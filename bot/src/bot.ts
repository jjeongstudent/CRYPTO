import { type Address, type LocalAccount, type PublicClient, formatEther } from "viem";
import { erc20Abi, executorAbi } from "./abi.js";
import type { BotConfig } from "./config.js";
import { CycleIndex, findCycles } from "./cycles.js";
import { type Costs, ExecutionEngine, type TradeRecord, encodeRun, planCosts, shortError } from "./engine.js";
import { log } from "./log.js";
import {
  PoolRegistry,
  decodeSync,
  fetchSymbols,
  getSyncLogs,
  loadPools,
  rankActiveTokens,
  recentPoolActivity,
  refreshReserves,
  topTokens,
} from "./pools.js";
import { findOpportunities, selectNonOverlapping } from "./strategy.js";
import type { Cycle, Opportunity } from "./types.js";

/** Simulation failures (other than "no longer profitable") before a route is ignored for good. */
const MAX_ROUTE_FAILURES = 3;
/** Blocks after which a pool locked by an in-flight trade is released even without a receipt. */
const PENDING_TTL_BLOCKS = 15n;
const REDISCOVER_EVERY_BLOCKS = 900;

export interface Stats {
  blocks: number;
  opportunities: number;
  simulated: number;
  sent: number;
  landed: number;
  reverted: number;
  realizedNetWei: bigint;
}

export interface Evaluated {
  opp: Opportunity;
  costs: Costs;
  /** Exact profit from an on-chain simulation, when an executor is configured. */
  simulatedProfit?: bigint;
}

export class ArbBot {
  registry = new PoolRegistry();
  index = new CycleIndex([]);
  symbols = new Map<Address, string>();
  lastBlock = 0n;
  readonly stats: Stats = { blocks: 0, opportunities: 0, simulated: 0, sent: 0, landed: 0, reverted: 0, realizedNetWei: 0n };
  readonly engine: ExecutionEngine;

  private spokes: Address[] = [];
  private blocksSinceResync = 0;
  private blocksSinceDiscovery = 0;
  private readonly untrackedActivity = new Map<Address, number>();
  private readonly pending = new Map<Address, bigint>();
  private readonly routeFailures = new Map<string, number>();
  private readonly blockedRoutes = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private scannedAll = false;
  private stopped = false;

  constructor(
    private readonly client: PublicClient,
    readonly cfg: BotConfig,
    account?: LocalAccount,
    simulateFrom?: Address,
  ) {
    this.engine = new ExecutionEngine(client, cfg, simulateFrom ?? account?.address, account);
  }

  async init(head?: bigint): Promise<void> {
    const block = head ?? (await this.client.getBlockNumber({ cacheTime: 0 }));
    await this.dropDexesWithoutCode();
    const activity = await recentPoolActivity(this.client, this.cfg, block);
    const scores = await rankActiveTokens(this.client, this.cfg, activity);
    const exclude = new Set([...this.cfg.hubs, ...this.cfg.extraTokens]);
    this.spokes = [...this.cfg.extraTokens, ...topTokens(scores, this.cfg.maxSpokes, exclude)];
    await this.rebuild();
    await this.engine.init();
    this.lastBlock = block;
  }

  /** Reloads every pool for the current hub + spoke token set and rebuilds the cycle graph. */
  async rebuild(): Promise<void> {
    const pools = await loadPools(this.client, this.cfg, [...this.cfg.hubs, ...this.spokes]);
    this.registry = new PoolRegistry();
    for (const pool of pools) this.registry.add(pool);
    const cycles = findCycles(this.registry.all(), this.cfg.baseToken, this.cfg.maxHops);
    this.index = new CycleIndex(cycles);
    const tokens = new Set<Address>();
    for (const p of this.registry.all()) tokens.add(p.token0).add(p.token1);
    this.symbols = await fetchSymbols(this.client, [...tokens].filter((t) => !this.symbols.has(t))).then(
      (fresh) => new Map([...this.symbols, ...fresh]),
    );
    this.scannedAll = false;
    const byDex: Record<string, number> = {};
    for (const p of this.registry.all()) byDex[p.dex] = (byDex[p.dex] ?? 0) + 1;
    log.info("pool graph built", { tokens: tokens.size, spokes: this.spokes.length, pools: this.registry.size, cycles: cycles.length, byDex });
  }

  private async dropDexesWithoutCode(): Promise<void> {
    const codes = await Promise.all(this.cfg.dexes.map((d) => this.client.getCode({ address: d.factory }).catch(() => undefined)));
    const missing = this.cfg.dexes.filter((_, i) => !codes[i] || codes[i] === "0x");
    for (const dex of missing) log.warn("factory has no code on this chain; DEX disabled", { dex: dex.name, factory: dex.factory });
    this.cfg.dexes = this.cfg.dexes.filter((d) => !missing.includes(d));
  }

  /** WETH available per trade: the configured cap, further limited by what the executor holds. */
  async capital(): Promise<bigint> {
    if (!this.cfg.executor) return this.cfg.maxTradeWei;
    const balance = await this.client.readContract({ address: this.cfg.baseToken, abi: erc20Abi, functionName: "balanceOf", args: [this.cfg.executor] });
    return balance < this.cfg.maxTradeWei ? balance : this.cfg.maxTradeWei;
  }

  /** Syncs pool state up to `head`, then finds and (unless dry-run) executes the best opportunities. */
  async processBlock(head: bigint): Promise<Evaluated[]> {
    if (head <= this.lastBlock) return [];
    const [logs, block, capital] = await Promise.all([
      getSyncLogs(this.client, this.lastBlock + 1n, head),
      this.client.getBlock({ blockNumber: head }),
      this.capital(),
    ]);
    const changed = new Set<Address>();
    for (const entry of logs) {
      const address = entry.address.toLowerCase() as Address;
      const reserves = decodeSync(entry);
      if (!reserves) continue;
      if (this.registry.has(address)) {
        if (this.registry.applyReserves(address, reserves.reserve0, reserves.reserve1)) changed.add(address);
      } else {
        this.untrackedActivity.set(address, (this.untrackedActivity.get(address) ?? 0) + 1);
      }
    }
    this.lastBlock = head;
    this.stats.blocks++;
    for (const [pool, sentAt] of this.pending) if (head - sentAt > PENDING_TTL_BLOCKS) this.pending.delete(pool);

    if (++this.blocksSinceResync >= this.cfg.resyncEveryBlocks) {
      this.blocksSinceResync = 0;
      for (const address of await refreshReserves(this.client, this.registry)) changed.add(address);
    }
    if (++this.blocksSinceDiscovery >= REDISCOVER_EVERY_BLOCKS) {
      this.blocksSinceDiscovery = 0;
      await this.rediscover();
    }

    const cycles = this.scannedAll ? this.index.affectedBy(changed) : this.index.cycles;
    this.scannedAll = true;
    if (cycles.length === 0) return [];
    return this.act(cycles, capital, block.baseFeePerGas ?? 0n, head);
  }

  private async rediscover(): Promise<void> {
    if (this.untrackedActivity.size === 0) return;
    const scores = await rankActiveTokens(this.client, this.cfg, this.untrackedActivity);
    this.untrackedActivity.clear();
    const known = new Set([...this.cfg.hubs, ...this.spokes]);
    const room = this.cfg.maxSpokes + this.cfg.extraTokens.length - this.spokes.length;
    const fresh = topTokens(scores, Math.max(room, 0), known);
    if (fresh.length === 0) return;
    log.info("discovered new active tokens", { count: fresh.length });
    this.spokes.push(...fresh);
    await this.rebuild();
  }

  private skip = (cycle: Cycle): boolean => this.blockedRoutes.size > 0 && this.blockedRoutes.has(routeKey(cycle));

  private async act(cycles: Cycle[], capital: bigint, baseFee: bigint, head: bigint): Promise<Evaluated[]> {
    const opps = findOpportunities(cycles, capital, 0n, this.skip);
    if (opps.length === 0) return [];
    this.stats.opportunities += opps.length;
    // Over-select (some candidates will fail simulation or the profit floor) and price them all in
    // parallel: one round-trip of latency instead of one per candidate.
    const candidates = selectNonOverlapping(opps, this.cfg.maxTxPerBlock * 3, new Set(this.pending.keys()));
    const accepted = (await Promise.all(candidates.map((opp) => this.evaluate(opp, baseFee))))
      .filter((ev): ev is Evaluated => ev !== undefined)
      .sort(byNetDescending)
      .slice(0, this.cfg.maxTxPerBlock);
    for (const ev of accepted) await this.execute(ev, head);
    return accepted;
  }

  /** Prices one opportunity: exact simulation when an executor exists, model estimate otherwise. */
  async evaluate(opp: Opportunity, baseFee: bigint): Promise<Evaluated | undefined> {
    const route = this.describe(opp.cycle);
    const calldata = encodeRun(this.cfg.baseToken, opp.amountIn, 0n, opp.cycle);
    if (!this.engine.canSimulate) {
      const gas = this.cfg.gasBase + this.cfg.gasPerHop * BigInt(opp.cycle.hops.length);
      const costs = planCosts(opp.grossProfit, gas, baseFee, await this.engine.l1Fee(calldata), this.cfg.bidBps);
      return costs.net >= this.cfg.minProfitWei ? { opp, costs } : undefined;
    }

    this.stats.simulated++;
    const [sim, l1Fee] = await Promise.all([this.engine.simulate(opp), this.engine.l1Fee(calldata)]);
    if (!sim.ok) {
      if (!sim.benign) this.noteRouteFailure(opp.cycle, sim.reason);
      log.debug("simulation rejected route", { route, reason: sim.reason });
      return undefined;
    }
    const costs = planCosts(sim.profit, sim.gas, baseFee, l1Fee, this.cfg.bidBps);
    if (costs.net < this.cfg.minProfitWei) {
      log.debug("below profit floor after costs", { route, gross: formatEther(sim.profit), net: formatEther(costs.net) });
      return undefined;
    }
    return { opp, costs, simulatedProfit: sim.profit };
  }

  private async execute(ev: Evaluated, head: bigint): Promise<void> {
    const route = this.describe(ev.opp.cycle);
    const record: TradeRecord = {
      mode: !this.engine.canSimulate ? "paper" : this.cfg.dryRun ? "dry-run" : "live",
      block: head.toString(),
      route,
      amountIn: ev.opp.amountIn,
      expectedGross: ev.simulatedProfit ?? ev.opp.grossProfit,
      costs: ev.costs,
    };
    const summary = {
      route,
      amountIn: formatEther(ev.opp.amountIn),
      gross: formatEther(record.expectedGross),
      costs: formatEther(ev.costs.totalCost),
      net: formatEther(ev.costs.net),
    };
    if (record.mode !== "live") {
      log.info(record.mode === "paper" ? "PAPER opportunity (estimated)" : "DRY-RUN would trade", summary);
      await this.engine.record(record);
      return;
    }

    // On-chain floor: revert unless gross profit still covers every cost plus the minimum net.
    const minProfit = ev.costs.totalCost + this.cfg.minProfitWei;
    for (const hop of ev.opp.cycle.hops) this.pending.set(hop.pool.address, head);
    try {
      record.hash = await this.engine.send(ev.opp, ev.costs, minProfit);
      this.stats.sent++;
      log.info("SENT", { ...summary, hash: record.hash });
    } catch (err) {
      for (const hop of ev.opp.cycle.hops) this.pending.delete(hop.pool.address);
      log.warn("send failed", { route, error: shortError(err) });
      return;
    }
    const settled = this.engine.settle(record).then(async (r) => {
      for (const hop of ev.opp.cycle.hops) this.pending.delete(hop.pool.address);
      const net = (r.realizedProfit ?? 0n) - (r.realizedFees ?? 0n);
      if (r.status === "success") this.stats.landed++;
      else if (r.status === "reverted") this.stats.reverted++;
      this.stats.realizedNetWei += net;
      log.info(r.status === "success" ? "LANDED" : "NOT LANDED", { route, status: r.status, net: formatEther(net), hash: r.hash });
      await this.engine.record(r);
    });
    this.inflight.add(settled);
    void settled.finally(() => this.inflight.delete(settled));
  }

  /**
   * A route that keeps failing simulation for a reason other than "not profitable anymore" is broken
   * (fee-on-transfer token, paused pool, fee higher than configured). Stop wasting calls on it.
   */
  private noteRouteFailure(cycle: Cycle, reason: string): void {
    const key = routeKey(cycle);
    const failures = (this.routeFailures.get(key) ?? 0) + 1;
    this.routeFailures.set(key, failures);
    if (failures >= MAX_ROUTE_FAILURES) {
      this.blockedRoutes.add(key);
      log.warn("route blocked after repeated simulation failures", { route: this.describe(cycle), reason });
    }
  }

  describe(cycle: Cycle): string {
    const sym = (t: Address) => this.symbols.get(t) ?? t.slice(0, 8);
    const first = cycle.hops[0]!;
    let out = sym(first.zeroForOne ? first.pool.token0 : first.pool.token1);
    for (const hop of cycle.hops) out += ` -[${hop.pool.dex}]-> ${sym(hop.zeroForOne ? hop.pool.token1 : hop.pool.token0)}`;
    return out;
  }

  /** Evaluates every cycle once against current state, without trading. */
  async scan(limit = 20): Promise<Evaluated[]> {
    const [capital, block] = await Promise.all([this.capital(), this.client.getBlock()]);
    const opps = selectNonOverlapping(findOpportunities(this.index.cycles, capital, 0n, this.skip), limit);
    const results = await Promise.all(opps.map((opp) => this.evaluate(opp, block.baseFeePerGas ?? 0n)));
    return results.filter((ev): ev is Evaluated => ev !== undefined).sort(byNetDescending);
  }

  async run(): Promise<void> {
    log.info("bot running", {
      mode: this.cfg.dryRun ? (this.engine.canSimulate ? "dry-run" : "paper") : "LIVE",
      executor: this.cfg.executor ?? "none",
      maxTrade: formatEther(this.cfg.maxTradeWei),
      minProfit: formatEther(this.cfg.minProfitWei),
      bidPercent: this.cfg.bidBps / 100,
    });
    let lastStats = Date.now();
    while (!this.stopped) {
      try {
        const head = await this.client.getBlockNumber({ cacheTime: 0 });
        if (head > this.lastBlock) await this.processBlock(head);
        else await sleep(this.cfg.pollMs);
      } catch (err) {
        log.error("block processing failed", { error: shortError(err) });
        await sleep(1_000);
      }
      if (Date.now() - lastStats > 60_000) {
        lastStats = Date.now();
        log.info("stats", { ...this.stats, realizedNetEth: formatEther(this.stats.realizedNetWei) });
      }
    }
    await Promise.allSettled([...this.inflight]);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Waits for every in-flight trade to settle (used by tests and on shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }
}

export async function readExecutorRoles(client: PublicClient, executor: Address): Promise<{ owner: Address; operator: Address }> {
  const [owner, operator] = await Promise.all([
    client.readContract({ address: executor, abi: executorAbi, functionName: "owner" }),
    client.readContract({ address: executor, abi: executorAbi, functionName: "operator" }),
  ]);
  return { owner, operator };
}

function byNetDescending(a: Evaluated, b: Evaluated): number {
  return a.costs.net < b.costs.net ? 1 : a.costs.net > b.costs.net ? -1 : 0;
}

function routeKey(cycle: Cycle): string {
  return cycle.hops.map((h) => `${h.pool.address}:${h.zeroForOne ? 1 : 0}`).join(",");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
