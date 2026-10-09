import { type Address, type Hex, type LocalAccount, type PublicClient, formatEther } from "viem";
import { erc20Abi, executorAbi } from "./abi.js";
import { type V4KeyBasic, loadTickWindows, nearWindowEdge, v4PoolId } from "./concentrated.js";
import type { BotConfig } from "./config.js";
import { CycleIndex, findCycles } from "./cycles.js";
import { type Costs, ExecutionEngine, type TradeRecord, encodeRun, estimateRouteGas, planCosts, shortError } from "./engine.js";
import { ALL_TOPICS, type LogLike, applyLog, eventPoolId, isDeltaEvent } from "./events.js";
import { type Flashblock, FlashblocksStream } from "./flashblocks.js";
import { PendingLogsStream } from "./pendingLogs.js";
import { log } from "./log.js";
import {
  PoolRegistry,
  countActivity,
  fetchSymbols,
  loadPools,
  poolManagerOf,
  rankActiveTokens,
  recentPoolActivity,
  refreshAll,
  topTokens,
} from "./pools.js";
import { getLogs } from "./rpc.js";
import { findOpportunities, selectNonOverlapping } from "./strategy.js";
import type { ClPool, Cycle, Opportunity } from "./types.js";

/** Simulation reverts (other than "no longer profitable") before a route is set aside. */
const MAX_ROUTE_FAILURES = 3;
/**
 * "Not profitable" simulations in a row before a route is set aside. The local quote is exact, so a
 * route it keeps calling profitable that keeps failing is broken (e.g. a fee-on-transfer token the
 * executor's balance checks reject), not just losing races.
 */
const MAX_ROUTE_LOST_RACES = 6;
/** Set-aside routes are retried after this many blocks (~1h on Base), in case the cause went away. */
const ROUTE_BLOCK_TTL_BLOCKS = 1800n;
/** Blocks after which a pool locked by an in-flight trade is released even without a receipt. */
const PENDING_TTL_BLOCKS = 15n;
const REDISCOVER_EVERY_BLOCKS = 900;
/** How long to remember liquidity deltas already applied from flashblocks. */
const APPLIED_DELTA_TTL_BLOCKS = 10n;

export interface Stats {
  blocks: number;
  flashblocks: number;
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
  /** Exact profit from an on-chain simulation, when one was run. */
  simulatedProfit?: bigint;
}

export class ArbBot {
  registry = new PoolRegistry();
  index = new CycleIndex([]);
  symbols = new Map<Address, string>();
  lastBlock = 0n;
  readonly stats: Stats = { blocks: 0, flashblocks: 0, opportunities: 0, simulated: 0, sent: 0, landed: 0, reverted: 0, realizedNetWei: 0n };
  readonly engine: ExecutionEngine;

  private spokes: Address[] = [];
  private readonly extraV4Keys = new Map<Hex, V4KeyBasic>();
  private blocksSinceResync = 0;
  private blocksSinceDiscovery = 0;
  private readonly untrackedActivity = new Map<Hex, number>();
  private readonly pending = new Map<Hex, bigint>();
  private readonly routeFailures = new Map<string, { reverts: number; lostRaces: number }>();
  /** Route key -> block after which it may be tried again. */
  private readonly blockedRoutes = new Map<string, bigint>();
  private readonly inflight = new Set<Promise<unknown>>();
  /** "tx:pool" liquidity deltas already applied from a flashblock, so the sealed block doesn't apply them twice. */
  private readonly appliedDeltas = new Map<string, bigint>();
  /** Concentrated pools whose price moved near the edge of their loaded tick window. */
  private readonly staleWindows = new Set<ClPool>();
  /** Pools to re-evaluate on the next event even if nothing changed (e.g. a window was just reloaded). */
  private readonly dirty = new Set<Hex>();
  private lastBaseFee = 0n;
  private lastCapital = 0n;
  private queue: Promise<unknown> = Promise.resolve();
  private stream: FlashblocksStream | PendingLogsStream | undefined;
  private warnedNoReceipts = false;
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
    const ranking = await rankActiveTokens(this.client, this.cfg, activity);
    for (const key of ranking.v4Keys) this.extraV4Keys.set(v4PoolId(key), key);
    const exclude = new Set([...this.cfg.hubs, ...this.cfg.extraTokens]);
    this.spokes = [...this.cfg.extraTokens, ...topTokens(ranking.scores, this.cfg.maxSpokes, exclude)];
    await this.rebuild();
    await this.engine.init();
    const [latest, capital] = await Promise.all([this.client.getBlock({ blockNumber: block }), this.capital()]);
    this.lastBaseFee = latest.baseFeePerGas ?? 0n;
    this.lastCapital = capital;
    this.lastBlock = block;
  }

  /** Reloads every pool for the current hub + spoke token set and rebuilds the cycle graph. */
  async rebuild(): Promise<void> {
    const pools = await loadPools(this.client, this.cfg, [...this.cfg.hubs, ...this.spokes], [...this.extraV4Keys.values()]);
    this.registry = new PoolRegistry();
    for (const pool of pools) this.registry.add(pool);
    const cycles = findCycles(this.registry.all(), this.cfg.baseToken, this.cfg.maxHops);
    this.index = new CycleIndex(cycles);
    const tokens = new Set<Address>();
    for (const p of this.registry.all()) tokens.add(p.token0).add(p.token1);
    this.symbols = await fetchSymbols(this.client, [...tokens].filter((t) => !this.symbols.has(t))).then(
      (fresh) => new Map([...this.symbols, ...fresh]),
    );
    this.staleWindows.clear();
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

  /** Runs state-mutating work one task at a time, in arrival order (blocks and flashblocks interleave). */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Syncs pool state up to `head` from sealed blocks, then finds and (unless dry-run) executes opportunities. */
  processBlock(head: bigint): Promise<Evaluated[]> {
    return this.serial(() => this.onBlock(head));
  }

  /** Applies a pre-confirmed flashblock and trades on what it changed, ahead of the sealed block. */
  processFlashblock(fb: Flashblock): Promise<Evaluated[]> {
    return this.serial(() => this.onFlashblock(fb));
  }

  private async onBlock(head: bigint): Promise<Evaluated[]> {
    if (head <= this.lastBlock) return [];
    const [logs, block, capital] = await Promise.all([
      getLogs(this.client, ALL_TOPICS, this.lastBlock + 1n, head),
      this.client.getBlock({ blockNumber: head }),
      this.capital(),
    ]);
    const { changed, mustReload } = this.applyLogs(logs, head);
    this.lastBlock = head;
    this.lastBaseFee = block.baseFeePerGas ?? 0n;
    this.lastCapital = capital;
    this.stats.blocks++;
    for (const [pool, sentAt] of this.pending) if (head - sentAt > PENDING_TTL_BLOCKS) this.pending.delete(pool);
    for (const [key, at] of this.appliedDeltas) if (head - at > APPLIED_DELTA_TTL_BLOCKS) this.appliedDeltas.delete(key);
    await this.reloadWindows(mustReload);

    if (++this.blocksSinceResync >= this.cfg.resyncEveryBlocks) {
      this.blocksSinceResync = 0;
      for (const id of await refreshAll(this.client, this.cfg, this.registry)) changed.add(id);
      this.staleWindows.clear();
    }
    if (++this.blocksSinceDiscovery >= REDISCOVER_EVERY_BLOCKS) {
      this.blocksSinceDiscovery = 0;
      await this.rediscover();
    }

    const accepted = await this.evaluateChanged(changed, capital, this.lastBaseFee, head);
    await this.reloadStaleWindows();
    return accepted;
  }

  private async onFlashblock(fb: Flashblock): Promise<Evaluated[]> {
    // A flashblock for a block we already synced from the sealed chain adds nothing.
    if (fb.blockNumber <= this.lastBlock) return [];
    this.stats.flashblocks++;
    if (fb.baseFeePerGas !== undefined) this.lastBaseFee = fb.baseFeePerGas;
    const { changed, mustReload } = this.applyLogs(fb.logs, undefined, fb.blockNumber);
    await this.reloadWindows(mustReload);
    const accepted = await this.evaluateChanged(changed, this.lastCapital, this.lastBaseFee, fb.blockNumber);
    await this.reloadStaleWindows();
    return accepted;
  }

  /**
   * Applies logs in execution order. Absolute events (Sync, Swap) are idempotent and re-applied from
   * sealed blocks so the final state is right even if a flashblock was missed. Liquidity deltas
   * (Mint/Burn/ModifyLiquidity) applied from a flashblock are remembered per transaction and pool
   * and skipped when the sealed block (`sealedHead` set) replays them.
   */
  private applyLogs(logs: readonly LogLike[], sealedHead?: bigint, flashblock?: bigint): { changed: Set<Hex>; mustReload: Set<ClPool> } {
    const changed = new Set<Hex>();
    const mustReload = new Set<ClPool>();
    const poolManager = poolManagerOf(this.cfg);
    for (const entry of logs) {
      const delta = isDeltaEvent(entry.topics[0]);
      const key = delta && entry.transactionHash ? `${entry.transactionHash.toLowerCase()}:${eventPoolId(entry)}` : undefined;
      if (sealedHead !== undefined && key && this.appliedDeltas.has(key)) continue;
      const effect = applyLog(this.registry.map, entry, poolManager);
      if (effect.type === "changed") {
        changed.add(effect.id);
        const pool = this.registry.get(effect.id);
        if (pool?.family !== "cl") continue;
        // A delta that needs the window reloaded is not marked applied: the sealed block replays it on
        // top of the reloaded (pre-flashblock) ticks.
        if (effect.reload) mustReload.add(pool);
        else if (flashblock !== undefined && key) this.appliedDeltas.set(key, flashblock);
        if (nearWindowEdge(pool.state)) this.staleWindows.add(pool);
      } else if (effect.type === "untracked") {
        countActivity(this.untrackedActivity, entry.address, entry.topics, poolManager);
      }
    }
    return { changed, mustReload };
  }

  /** Re-reads tick windows that local events could not keep exact. Must finish before quoting those pools. */
  private async reloadWindows(pools: Set<ClPool>): Promise<void> {
    if (pools.size === 0) return;
    try {
      await loadTickWindows(this.client, [...pools], this.cfg.clRangePct, poolManagerOf(this.cfg));
    } catch (err) {
      // Leave them stale; the post-trade reload or the next resync retries.
      log.warn("tick window reload failed", { pools: pools.size, error: shortError(err) });
      for (const p of pools) this.staleWindows.add(p);
    }
  }

  private async evaluateChanged(changed: Set<Hex>, capital: bigint, baseFee: bigint, head: bigint): Promise<Evaluated[]> {
    for (const id of this.dirty) changed.add(id);
    this.dirty.clear();
    const cycles = this.scannedAll ? this.index.affectedBy(changed) : this.index.cycles;
    this.scannedAll = true;
    if (cycles.length === 0) return [];
    return this.act(cycles, capital, baseFee, head);
  }

  /** Re-centres tick windows that the price has drifted towards. Done after trading to keep it off the hot path. */
  private async reloadStaleWindows(): Promise<void> {
    if (this.staleWindows.size === 0) return;
    const pools = [...this.staleWindows].filter((p) => this.registry.get(p.id) === p);
    this.staleWindows.clear();
    try {
      await loadTickWindows(this.client, pools, this.cfg.clRangePct, poolManagerOf(this.cfg));
      for (const p of pools) this.dirty.add(p.id);
    } catch (err) {
      log.warn("tick window reload failed", { pools: pools.length, error: shortError(err) });
      for (const p of pools) this.staleWindows.add(p);
    }
  }

  private async rediscover(): Promise<void> {
    if (this.untrackedActivity.size === 0) return;
    const ranking = await rankActiveTokens(this.client, this.cfg, this.untrackedActivity);
    this.untrackedActivity.clear();
    let newKeys = 0;
    for (const key of ranking.v4Keys) {
      const id = v4PoolId(key);
      if (!this.extraV4Keys.has(id)) {
        this.extraV4Keys.set(id, key);
        newKeys++;
      }
    }
    const known = new Set([...this.cfg.hubs, ...this.spokes]);
    const room = this.cfg.maxSpokes + this.cfg.extraTokens.length - this.spokes.length;
    const fresh = topTokens(ranking.scores, Math.max(room, 0), known);
    if (fresh.length === 0 && newKeys === 0) return;
    log.info("discovered new active markets", { tokens: fresh.length, v4Pools: newKeys });
    this.spokes.push(...fresh);
    await this.rebuild();
  }

  private skip = (cycle: Cycle): boolean => {
    if (this.blockedRoutes.size === 0) return false;
    const key = routeKey(cycle);
    const until = this.blockedRoutes.get(key);
    if (until === undefined) return false;
    if (this.lastBlock < until) return true;
    this.blockedRoutes.delete(key);
    return false;
  };

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
    const modelGas = estimateRouteGas(opp.cycle, this.cfg.gasBase, this.cfg.gasPerHop);
    if (!this.engine.canSimulate || this.cfg.skipSimulation) {
      // Without simulation, budget generously for gas: an underestimate would make the tx run out of gas.
      const gas = this.engine.canSimulate ? modelGas * 2n : modelGas;
      const costs = planCosts(opp.grossProfit, gas, baseFee, await this.engine.l1Fee(calldata), this.cfg.bidBps);
      return costs.net >= this.cfg.minProfitWei ? { opp, costs } : undefined;
    }

    this.stats.simulated++;
    const [sim, l1Fee] = await Promise.all([this.engine.simulate(opp), this.engine.l1Fee(calldata)]);
    if (!sim.ok) {
      this.noteRouteFailure(opp.cycle, sim.reason, sim.benign);
      log.debug("simulation rejected route", { route, reason: sim.reason });
      return undefined;
    }
    this.routeFailures.delete(routeKey(opp.cycle));
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
    for (const hop of ev.opp.cycle.hops) this.pending.set(hop.pool.id, head);
    try {
      record.hash = await this.engine.send(ev.opp, ev.costs, minProfit);
      this.stats.sent++;
      log.info("SENT", { ...summary, hash: record.hash });
    } catch (err) {
      for (const hop of ev.opp.cycle.hops) this.pending.delete(hop.pool.id);
      log.warn("send failed", { route, error: shortError(err) });
      return;
    }
    const settled = this.engine.settle(record).then(async (r) => {
      for (const hop of ev.opp.cycle.hops) this.pending.delete(hop.pool.id);
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
   * A route that keeps failing simulation is broken (fee-on-transfer token, paused pool, fee higher
   * than configured) and would otherwise take a candidate slot every block. Set it aside for a while.
   */
  private noteRouteFailure(cycle: Cycle, reason: string, lostRace: boolean): void {
    const key = routeKey(cycle);
    const counts = this.routeFailures.get(key) ?? { reverts: 0, lostRaces: 0 };
    if (lostRace) counts.lostRaces++;
    else counts.reverts++;
    this.routeFailures.set(key, counts);
    if (counts.reverts >= MAX_ROUTE_FAILURES || counts.lostRaces >= MAX_ROUTE_LOST_RACES) {
      this.routeFailures.delete(key);
      this.blockedRoutes.set(key, this.lastBlock + ROUTE_BLOCK_TTL_BLOCKS);
      log.warn("route set aside after repeated simulation failures", { route: this.describe(cycle), reason, blocks: ROUTE_BLOCK_TTL_BLOCKS });
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
      flashblocks: this.cfg.flashblocksRpcWs ? "pendingLogs" : this.cfg.flashblocksWs ? "raw stream" : "off",
      maxTrade: formatEther(this.cfg.maxTradeWei),
      minProfit: formatEther(this.cfg.minProfitWei),
      bidPercent: this.cfg.bidBps / 100,
    });
    this.stream = this.startFlashblocks();
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
    this.stream?.stop();
    await Promise.allSettled([...this.inflight]);
  }

  stop(): void {
    this.stopped = true;
    this.stream?.stop();
  }

  /** Starts the pre-confirmation feed: the RPC `pendingLogs` subscription if configured, else the raw stream. */
  private startFlashblocks(): FlashblocksStream | PendingLogsStream | undefined {
    const onStatus = (status: string, detail?: string) => log.info(`flashblocks ${status}`, detail ? { detail } : undefined);
    const handle = (fb: Flashblock) => {
      this.processFlashblock(fb).catch((err) => log.error("flashblock processing failed", { error: shortError(err) }));
    };
    let stream: FlashblocksStream | PendingLogsStream | undefined;
    if (this.cfg.flashblocksRpcWs) {
      stream = new PendingLogsStream({ url: this.cfg.flashblocksRpcWs, topics: ALL_TOPICS, onBatch: handle, onStatus });
    } else if (this.cfg.flashblocksWs) {
      stream = new FlashblocksStream({
        url: this.cfg.flashblocksWs,
        onStatus,
        onFlashblock: (fb) => {
          if (fb.receiptsIncluded === false && !this.warnedNoReceipts) {
            this.warnedNoReceipts = true;
            log.warn("this flashblocks stream carries no receipts (Base Azul+): set FLASHBLOCKS_RPC_WS to a Flashblocks-aware RPC websocket");
          }
          handle(fb);
        },
      });
    }
    stream?.start();
    return stream;
  }

  /** Waits for every in-flight trade to settle (used by tests and on shutdown). */
  async drain(): Promise<void> {
    await this.queue;
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
  return cycle.hops.map((h) => `${h.pool.id}:${h.zeroForOne ? 1 : 0}`).join(",");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
