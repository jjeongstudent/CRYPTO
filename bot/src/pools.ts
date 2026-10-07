import type { Abi, Address, Log, PublicClient } from "viem";
import { aerodromeFactoryAbi, erc20Abi, poolAbi, syncAerodromeEvent, syncV2Event, v2FactoryAbi } from "./abi.js";
import type { BotConfig } from "./config.js";
import { log } from "./log.js";
import type { DexConfig, Pool } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const MULTICALL_CHUNK = 400;

export class PoolRegistry {
  private readonly pools = new Map<Address, Pool>();

  add(pool: Pool): void {
    this.pools.set(pool.address, pool);
  }

  get(address: Address): Pool | undefined {
    return this.pools.get(address.toLowerCase() as Address);
  }

  has(address: Address): boolean {
    return this.pools.has(address.toLowerCase() as Address);
  }

  get size(): number {
    return this.pools.size;
  }

  all(): Pool[] {
    return [...this.pools.values()];
  }

  /** Returns true when the pool is tracked and its reserves actually changed. */
  applyReserves(address: Address, reserve0: bigint, reserve1: bigint): boolean {
    const pool = this.get(address);
    if (!pool || (pool.reserve0 === reserve0 && pool.reserve1 === reserve1)) return false;
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    return true;
  }
}

interface ReadCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Multicall with per-call failure tolerance; failed calls come back as undefined. */
export async function multiread<T>(client: PublicClient, calls: ReadCall[]): Promise<(T | undefined)[]> {
  const out: (T | undefined)[] = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const results = (await client.multicall({
      contracts: calls.slice(i, i + MULTICALL_CHUNK),
      allowFailure: true,
      batchSize: 0,
    } as never)) as { status: "success" | "failure"; result?: unknown }[];
    for (const r of results) out.push(r.status === "success" ? (r.result as T) : undefined);
  }
  return out;
}

/** eth_getLogs over a range, halving the window whenever the provider rejects it as too large. */
export async function getSyncLogs(client: PublicClient, fromBlock: bigint, toBlock: bigint, maxWindow = 200n): Promise<Log[]> {
  const logs: Log[] = [];
  let start = fromBlock;
  let window = maxWindow;
  while (start <= toBlock) {
    const end = start + window - 1n < toBlock ? start + window - 1n : toBlock;
    try {
      const chunk = await client.getLogs({ events: [syncV2Event, syncAerodromeEvent], fromBlock: start, toBlock: end, strict: false });
      logs.push(...(chunk as Log[]));
      start = end + 1n;
    } catch (err) {
      if (window === 1n) throw err;
      window = window / 2n;
    }
  }
  return logs;
}

/** Decodes the two reserve words from a Sync log (identical layout for V2 and Aerodrome). */
export function decodeSync(logEntry: Log): { reserve0: bigint; reserve1: bigint } | undefined {
  const data = logEntry.data;
  if (!data || data.length < 2 + 128) return undefined;
  return { reserve0: BigInt(`0x${data.slice(2, 66)}`), reserve1: BigInt(`0x${data.slice(66, 130)}`) };
}

function pairCall(dex: DexConfig, a: Address, b: Address): ReadCall {
  return dex.kind === "aerodrome"
    ? { address: dex.factory, abi: aerodromeFactoryAbi, functionName: "getPool", args: [a, b, false] }
    : { address: dex.factory, abi: v2FactoryAbi, functionName: "getPair", args: [a, b] };
}

/**
 * Finds every pool on the configured DEXes between hub/hub and token/hub pairs, then loads
 * tokens, reserves and fees. Pools that are empty or too shallow in the base token are dropped.
 */
export async function loadPools(client: PublicClient, cfg: BotConfig, tokens: Address[]): Promise<Pool[]> {
  const hubs = new Set(cfg.hubs);
  const spokes = tokens.filter((t) => !hubs.has(t));
  const pairs: [Address, Address][] = [];
  for (let i = 0; i < cfg.hubs.length; i++) for (let j = i + 1; j < cfg.hubs.length; j++) pairs.push([cfg.hubs[i]!, cfg.hubs[j]!]);
  for (const spoke of spokes) for (const hub of cfg.hubs) pairs.push([spoke, hub]);

  const lookups = cfg.dexes.flatMap((dex) => pairs.map(([a, b]) => ({ dex, call: pairCall(dex, a, b) })));
  const found = await multiread<Address>(client, lookups.map((l) => l.call));
  const poolDex = new Map<Address, DexConfig>();
  found.forEach((address, i) => {
    if (address && address !== ZERO) poolDex.set(address.toLowerCase() as Address, lookups[i]!.dex);
  });

  const addresses = [...poolDex.keys()];
  // Aerodrome fees are set per pool by its factory; V2 forks use one fee per factory.
  const aerodromePools = addresses.filter((a) => poolDex.get(a)!.kind === "aerodrome");
  const [details, aerodromeFees] = await Promise.all([
    multiread<unknown>(
      client,
      addresses.flatMap((address) => [
        { address, abi: poolAbi, functionName: "token0" },
        { address, abi: poolAbi, functionName: "token1" },
        { address, abi: poolAbi, functionName: "getReserves" },
      ]),
    ),
    multiread<bigint>(
      client,
      aerodromePools.map((address) => ({
        address: poolDex.get(address)!.factory,
        abi: aerodromeFactoryAbi,
        functionName: "getFee",
        args: [address, false],
      })),
    ),
  ]);
  const feeOf = new Map(aerodromePools.map((address, i) => [address, aerodromeFees[i]]));

  const pools: Pool[] = [];
  addresses.forEach((address, i) => {
    const dex = poolDex.get(address)!;
    const [token0, token1, reserves] = details.slice(i * 3, i * 3 + 3) as [
      Address | undefined,
      Address | undefined,
      readonly [bigint, bigint, bigint] | undefined,
    ];
    if (!token0 || !token1 || !reserves) return;
    const fee = dex.kind === "aerodrome" ? feeOf.get(address) : BigInt(dex.feeBps ?? 30);
    if (fee === undefined || fee >= 10_000n) return;
    const feeBps = Number(fee);
    const pool: Pool = {
      address,
      dex: dex.name,
      kind: dex.kind,
      token0: token0.toLowerCase() as Address,
      token1: token1.toLowerCase() as Address,
      feeBps,
      reserve0: reserves[0],
      reserve1: reserves[1],
    };
    if (isLiquid(pool, cfg)) pools.push(pool);
  });
  return pools;
}

export function isLiquid(pool: Pool, cfg: BotConfig): boolean {
  if (pool.reserve0 === 0n || pool.reserve1 === 0n) return false;
  if (pool.token0 === cfg.baseToken) return pool.reserve0 >= cfg.minPoolBaseWei;
  if (pool.token1 === cfg.baseToken) return pool.reserve1 >= cfg.minPoolBaseWei;
  return true;
}

/**
 * Ranks non-hub tokens by how much their pools traded, given Sync-event counts per pool.
 * Only pools created by a configured factory and paired with a hub count, since those are
 * the only ones the bot can route through.
 */
export async function rankActiveTokens(
  client: PublicClient,
  cfg: BotConfig,
  activity: Map<Address, number>,
): Promise<Map<Address, number>> {
  const factories = new Set(cfg.dexes.map((d) => d.factory));
  const hubs = new Set(cfg.hubs);
  const addresses = [...activity.keys()];
  const calls: ReadCall[] = addresses.flatMap((address) => [
    { address, abi: poolAbi, functionName: "factory" },
    { address, abi: poolAbi, functionName: "token0" },
    { address, abi: poolAbi, functionName: "token1" },
  ]);
  const results = await multiread<Address>(client, calls);

  const scores = new Map<Address, number>();
  addresses.forEach((address, i) => {
    const [factory, t0, t1] = results.slice(i * 3, i * 3 + 3);
    if (!factory || !t0 || !t1 || !factories.has(factory.toLowerCase() as Address)) return;
    const token0 = t0.toLowerCase() as Address;
    const token1 = t1.toLowerCase() as Address;
    const spoke = hubs.has(token0) && !hubs.has(token1) ? token1 : hubs.has(token1) && !hubs.has(token0) ? token0 : undefined;
    if (spoke) scores.set(spoke, (scores.get(spoke) ?? 0) + (activity.get(address) ?? 0));
  });
  return scores;
}

/** Counts Sync events per pool over the last `cfg.discoverBlocks` blocks. */
export async function recentPoolActivity(client: PublicClient, cfg: BotConfig, head: bigint): Promise<Map<Address, number>> {
  const activity = new Map<Address, number>();
  if (cfg.discoverBlocks <= 0) return activity;
  const from = head - BigInt(cfg.discoverBlocks) + 1n;
  const logs = await getSyncLogs(client, from > 0n ? from : 0n, head);
  for (const entry of logs) {
    const address = entry.address.toLowerCase() as Address;
    activity.set(address, (activity.get(address) ?? 0) + 1);
  }
  log.info("scanned recent pool activity", { blocks: cfg.discoverBlocks, syncEvents: logs.length, pools: activity.size });
  return activity;
}

export function topTokens(scores: Map<Address, number>, limit: number, exclude: Set<Address>): Address[] {
  return [...scores.entries()]
    .filter(([token]) => !exclude.has(token))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

/** Re-reads every tracked pool's reserves. Returns the addresses that changed. */
export async function refreshReserves(client: PublicClient, registry: PoolRegistry): Promise<Set<Address>> {
  const pools = registry.all();
  const results = await multiread<readonly [bigint, bigint, bigint]>(
    client,
    pools.map((p) => ({ address: p.address, abi: poolAbi, functionName: "getReserves" })),
  );
  const changed = new Set<Address>();
  results.forEach((r, i) => {
    if (r && registry.applyReserves(pools[i]!.address, r[0], r[1])) changed.add(pools[i]!.address);
  });
  return changed;
}

export async function fetchSymbols(client: PublicClient, tokens: Address[]): Promise<Map<Address, string>> {
  const results = await multiread<string>(
    client,
    tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: "symbol" })),
  );
  const symbols = new Map<Address, string>();
  tokens.forEach((t, i) => symbols.set(t, results[i] && results[i]!.length <= 20 ? results[i]! : `${t.slice(0, 8)}…`));
  return symbols;
}
