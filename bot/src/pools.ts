import type { Address, Hex, PublicClient } from "viem";
import { aerodromeFactoryAbi, erc20Abi, poolAbi, v2FactoryAbi } from "./abi.js";
import { Q96 } from "./clmath.js";
import {
  type V4KeyBasic,
  candidateV4Keys,
  loadTickWindows,
  loadV3StylePools,
  loadV4Pools,
  refreshV3StylePools,
  refreshV4Pools,
  resolveV4Keys,
  v4PoolId,
} from "./concentrated.js";
import type { BotConfig } from "./config.js";
import { TOPICS } from "./events.js";
import { log } from "./log.js";
import { type ReadCall, getLogs, multiread } from "./rpc.js";
import type { ClPool, CpPool, DexConfig, Pool } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000";
/** (fee, tickSpacing) pairs Uniswap's interface creates for hookless V4 pools. */
export const DEFAULT_V4_KEYS: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10_000, 200],
];
const ACTIVITY_TOPICS: Hex[] = [TOPICS.syncV2, TOPICS.syncAerodrome, TOPICS.swapV3, TOPICS.swapPancakeV3, TOPICS.swapV4];

export class PoolRegistry {
  private readonly pools = new Map<Hex, Pool>();

  add(pool: Pool): void {
    this.pools.set(pool.id, pool);
  }

  get(id: Hex): Pool | undefined {
    return this.pools.get(id.toLowerCase() as Hex);
  }

  has(id: Hex): boolean {
    return this.pools.has(id.toLowerCase() as Hex);
  }

  get size(): number {
    return this.pools.size;
  }

  get map(): ReadonlyMap<Hex, Pool> {
    return this.pools;
  }

  all(): Pool[] {
    return [...this.pools.values()];
  }
}

export function poolManagerOf(cfg: BotConfig): Address | undefined {
  return cfg.dexes.find((d) => d.kind === "v4")?.factory;
}

/** Hub/hub pairs plus every long-tail token against every hub. */
export function tokenPairs(cfg: BotConfig, tokens: Address[]): [Address, Address][] {
  const hubs = new Set(cfg.hubs);
  const pairs: [Address, Address][] = [];
  for (let i = 0; i < cfg.hubs.length; i++) for (let j = i + 1; j < cfg.hubs.length; j++) pairs.push([cfg.hubs[i]!, cfg.hubs[j]!]);
  for (const spoke of tokens) if (!hubs.has(spoke)) for (const hub of cfg.hubs) pairs.push([spoke, hub]);
  return pairs;
}

/**
 * Finds every pool on the configured DEXes for the token set, drops empty or shallow ones, and loads
 * tick windows for the concentrated ones. `extraV4Keys` adds V4 pools discovered from activity
 * (non-standard fees or allowed hooks) that probing the default keys would miss.
 */
export async function loadPools(client: PublicClient, cfg: BotConfig, tokens: Address[], extraV4Keys: V4KeyBasic[] = []): Promise<Pool[]> {
  const pairs = tokenPairs(cfg, tokens);
  const loaded = await Promise.all(
    cfg.dexes.map(async (dex): Promise<Pool[]> => {
      try {
        if (dex.kind === "v2" || dex.kind === "aerodrome") return await loadCpPools(client, dex, pairs);
        if (dex.kind === "v4") {
          const keys = [...candidateV4Keys(pairs, dex.v4Keys ?? DEFAULT_V4_KEYS, cfg.weth), ...extraV4Keys];
          return await loadV4Pools(client, dex, keys, cfg.weth);
        }
        return await loadV3StylePools(client, dex, pairs);
      } catch (err) {
        log.warn("could not load pools", { dex: dex.name, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
        return [];
      }
    }),
  );
  const pools = loaded.flat().filter((p) => isLiquid(p, cfg));
  const cl = pools.filter((p): p is ClPool => p.family === "cl");
  if (cl.length) await loadTickWindows(client, cl, cfg.clRangePct, poolManagerOf(cfg));
  return pools;
}

async function loadCpPools(client: PublicClient, dex: DexConfig, pairs: [Address, Address][]): Promise<CpPool[]> {
  const lookups: ReadCall[] = pairs.map(([a, b]) =>
    dex.kind === "aerodrome"
      ? { address: dex.factory, abi: aerodromeFactoryAbi, functionName: "getPool", args: [a, b, false] }
      : { address: dex.factory, abi: v2FactoryAbi, functionName: "getPair", args: [a, b] },
  );
  const found = await multiread<Address>(client, lookups);
  const addresses = [...new Set(found.filter((a): a is Address => !!a && a !== ZERO).map((a) => a.toLowerCase() as Address))];
  if (addresses.length === 0) return [];

  // Aerodrome fees are set per pool by its factory; V2 forks use one fee per factory.
  const [details, fees] = await Promise.all([
    multiread<unknown>(
      client,
      addresses.flatMap((address) => [
        { address, abi: poolAbi, functionName: "token0" },
        { address, abi: poolAbi, functionName: "token1" },
        { address, abi: poolAbi, functionName: "getReserves" },
      ]),
    ),
    dex.kind === "aerodrome"
      ? multiread<bigint>(
          client,
          addresses.map((address) => ({ address: dex.factory, abi: aerodromeFactoryAbi, functionName: "getFee", args: [address, false] })),
        )
      : Promise.resolve(addresses.map(() => BigInt(dex.feeBps ?? 30))),
  ]);

  const pools: CpPool[] = [];
  addresses.forEach((address, i) => {
    const [token0, token1, reserves] = details.slice(i * 3, i * 3 + 3) as [
      Address | undefined,
      Address | undefined,
      readonly [bigint, bigint, bigint] | undefined,
    ];
    const fee = fees[i];
    if (!token0 || !token1 || !reserves || fee === undefined || fee >= 10_000n) return;
    pools.push({
      family: "cp",
      id: address,
      dex: dex.name,
      kind: dex.kind,
      token0: token0.toLowerCase() as Address,
      token1: token1.toLowerCase() as Address,
      feeBps: Number(fee),
      reserve0: reserves[0],
      reserve1: reserves[1],
    });
  });
  return pools;
}

/** Drops empty pools and pools shallower than `minPoolBaseWei` in the base token. */
export function isLiquid(pool: Pool, cfg: BotConfig): boolean {
  let reserve0: bigint;
  let reserve1: bigint;
  if (pool.family === "cp") {
    reserve0 = pool.reserve0;
    reserve1 = pool.reserve1;
  } else {
    // Virtual reserves at the current price: what the pool behaves like for small trades.
    const { liquidity, sqrtPriceX96 } = pool.state;
    if (liquidity === 0n || sqrtPriceX96 === 0n) return false;
    reserve0 = (liquidity * Q96) / sqrtPriceX96;
    reserve1 = (liquidity * sqrtPriceX96) / Q96;
  }
  if (reserve0 === 0n || reserve1 === 0n) return false;
  if (pool.token0 === cfg.baseToken) return reserve0 >= cfg.minPoolBaseWei;
  if (pool.token1 === cfg.baseToken) return reserve1 >= cfg.minPoolBaseWei;
  return true;
}

/**
 * Re-reads the full state of every tracked pool (reserves, slot0, liquidity, fees, tick windows).
 * Safety net against missed logs and reorgs. Returns the ids that changed.
 */
export async function refreshAll(client: PublicClient, cfg: BotConfig, registry: PoolRegistry): Promise<Set<Hex>> {
  const pools = registry.all();
  const cp = pools.filter((p): p is CpPool => p.family === "cp");
  const cl = pools.filter((p): p is ClPool => p.family === "cl");
  const v3 = cl.filter((p) => !p.v4);
  const v4 = cl.filter((p) => p.v4);
  const poolManager = poolManagerOf(cfg);

  const [reserves, v3Changed, v4Changed] = await Promise.all([
    multiread<readonly [bigint, bigint, bigint]>(
      client,
      cp.map((p) => ({ address: p.id as Address, abi: poolAbi, functionName: "getReserves" })),
    ),
    v3.length ? refreshV3StylePools(client, v3) : Promise.resolve(new Set<Hex>()),
    v4.length && poolManager ? refreshV4Pools(client, poolManager, v4) : Promise.resolve(new Set<Hex>()),
  ]);
  const changed = new Set<Hex>([...v3Changed, ...v4Changed]);
  reserves.forEach((r, i) => {
    const pool = cp[i]!;
    if (!r || (pool.reserve0 === r[0] && pool.reserve1 === r[1])) return;
    pool.reserve0 = r[0];
    pool.reserve1 = r[1];
    changed.add(pool.id);
  });
  if (cl.length) await loadTickWindows(client, cl, cfg.clRangePct, poolManager);
  return changed;
}

/** Counts swap/sync events per pool (address, or V4 pool id) over the last `cfg.discoverBlocks` blocks. */
export async function recentPoolActivity(client: PublicClient, cfg: BotConfig, head: bigint): Promise<Map<Hex, number>> {
  const activity = new Map<Hex, number>();
  if (cfg.discoverBlocks <= 0) return activity;
  const from = head - BigInt(cfg.discoverBlocks) + 1n;
  const logs = await getLogs(client, ACTIVITY_TOPICS, from > 0n ? from : 0n, head);
  const poolManager = poolManagerOf(cfg);
  for (const entry of logs) countActivity(activity, entry.address, entry.topics, poolManager);
  log.info("scanned recent pool activity", { blocks: cfg.discoverBlocks, events: logs.length, pools: activity.size });
  return activity;
}

export function countActivity(activity: Map<Hex, number>, address: Address, topics: readonly Hex[], poolManager: Address | undefined): void {
  const topic0 = topics[0];
  if (!topic0 || !ACTIVITY_TOPICS.includes(topic0)) return;
  let id: Hex;
  if (topic0 === TOPICS.swapV4) {
    if (!poolManager || address.toLowerCase() !== poolManager || !topics[1]) return;
    id = topics[1].toLowerCase() as Hex;
  } else {
    id = address.toLowerCase() as Hex;
  }
  activity.set(id, (activity.get(id) ?? 0) + 1);
}

export interface Ranking {
  /** Non-hub tokens scored by trading activity of their hub-paired pools. */
  scores: Map<Address, number>;
  /** Keys of active V4 pools (resolved through the PositionManager). */
  v4Keys: V4KeyBasic[];
}

/**
 * Ranks long-tail tokens by how much their pools traded. Only pools created by a configured
 * factory (or V4 pools with allowed hooks) and paired with a hub count, since those are the only
 * ones the bot can route through.
 */
export async function rankActiveTokens(client: PublicClient, cfg: BotConfig, activity: Map<Hex, number>): Promise<Ranking> {
  const factories = new Set(cfg.dexes.filter((d) => d.kind !== "v4").map((d) => d.factory));
  const hubs = new Set(cfg.hubs);
  const scores = new Map<Address, number>();
  const credit = (token0: Address, token1: Address, weight: number) => {
    const spoke = hubs.has(token0) && !hubs.has(token1) ? token1 : hubs.has(token1) && !hubs.has(token0) ? token0 : undefined;
    if (spoke) scores.set(spoke, (scores.get(spoke) ?? 0) + weight);
  };

  const addresses = [...activity.keys()].filter((id) => id.length === 42) as Address[];
  const results = await multiread<Address>(
    client,
    addresses.flatMap((address) => [
      { address, abi: poolAbi, functionName: "factory" },
      { address, abi: poolAbi, functionName: "token0" },
      { address, abi: poolAbi, functionName: "token1" },
    ]),
  );
  addresses.forEach((address, i) => {
    const [factory, t0, t1] = results.slice(i * 3, i * 3 + 3);
    if (!factory || !t0 || !t1 || !factories.has(factory.toLowerCase() as Address)) return;
    credit(t0.toLowerCase() as Address, t1.toLowerCase() as Address, activity.get(address) ?? 0);
  });

  const v4Keys: V4KeyBasic[] = [];
  const v4Dex = cfg.dexes.find((d) => d.kind === "v4");
  const v4Ids = [...activity.keys()].filter((id) => id.length === 66);
  if (v4Dex?.positionManager && v4Ids.length) {
    const resolved = await resolveV4Keys(client, v4Dex.positionManager, v4Ids, new Set(cfg.v4Hooks));
    const norm = (c: Address) => (c === ZERO ? cfg.weth : c);
    for (const key of resolved) {
      v4Keys.push(key);
      const id = v4PoolId(key);
      credit(norm(key.currency0), norm(key.currency1), activity.get(id) ?? 0);
    }
  }
  return { scores, v4Keys };
}


export function topTokens(scores: Map<Address, number>, limit: number, exclude: Set<Address>): Address[] {
  return [...scores.entries()]
    .filter(([token]) => !exclude.has(token))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
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
