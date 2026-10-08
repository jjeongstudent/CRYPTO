import { type Address, type Hex, toEventSelector } from "viem";
import { type ClState, applyLiquidityDelta, wordOf } from "./clmath.js";
import type { Pool } from "./types.js";

/**
 * Every pool-state event the bot follows. Verified against the sources: Uniswap V3, SushiSwap V3 and
 * Aerodrome Slipstream share the V3 Swap/Mint/Burn signatures; PancakeSwap V3's Swap adds two
 * protocol-fee fields (different topic, same leading words); V4 events come from the PoolManager.
 */
export const TOPICS = {
  syncV2: toEventSelector("Sync(uint112,uint112)"),
  syncAerodrome: toEventSelector("Sync(uint256,uint256)"),
  swapV3: toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  swapPancakeV3: toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  mintV3: toEventSelector("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  burnV3: toEventSelector("Burn(address,int24,int24,uint128,uint256,uint256)"),
  swapV4: toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  modifyLiquidityV4: toEventSelector("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
} as const;

export const ALL_TOPICS: Hex[] = Object.values(TOPICS);
/** Events whose effect is a delta (applying one twice corrupts state), as opposed to absolute snapshots. */
const DELTA_TOPICS = new Set<Hex>([TOPICS.mintV3, TOPICS.burnV3, TOPICS.modifyLiquidityV4]);

export interface LogLike {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  transactionHash?: Hex | null;
}

export type LogEffect =
  /** `delta`: the event was a liquidity delta. `reload`: the pool's tick window must be re-read from chain. */
  | { type: "changed"; id: Hex; delta?: boolean; reload?: boolean }
  /** A pool-state event for a pool we don't track: candidate for discovery. */
  | { type: "untracked"; id: Hex; v4: boolean }
  | { type: "ignored" };

const WORD = 64;

function word(data: Hex, index: number): bigint {
  const hex = data.slice(2 + index * WORD, 2 + (index + 1) * WORD);
  return hex.length === WORD ? BigInt(`0x${hex}`) : -1n;
}

function signed(value: bigint, bits: number): bigint {
  const masked = value & ((1n << BigInt(bits)) - 1n);
  return masked >> BigInt(bits - 1) ? masked - (1n << BigInt(bits)) : masked;
}

const int24 = (value: bigint) => Number(signed(value, 24));

export function isDeltaEvent(topic0: Hex | undefined): boolean {
  return topic0 !== undefined && DELTA_TOPICS.has(topic0);
}

/** Pool a log refers to: the emitting pool, or for V4 events the pool id in topic 1. */
export function eventPoolId(entry: LogLike): Hex | undefined {
  const topic0 = entry.topics[0];
  if (topic0 === TOPICS.swapV4 || topic0 === TOPICS.modifyLiquidityV4) return entry.topics[1]?.toLowerCase() as Hex | undefined;
  return entry.address.toLowerCase() as Hex;
}

/**
 * Applies one log to the matching pool, in place. Logs must be applied in execution order.
 * `poolManager` is the V4 PoolManager address (lowercase); V4 events from anything else are ignored.
 */
export function applyLog(pools: ReadonlyMap<Hex, Pool>, entry: LogLike, poolManager: Address | undefined): LogEffect {
  const topic0 = entry.topics[0];
  if (!topic0) return { type: "ignored" };
  const address = entry.address.toLowerCase() as Address;

  if (topic0 === TOPICS.swapV4 || topic0 === TOPICS.modifyLiquidityV4) {
    if (!poolManager || address !== poolManager || !entry.topics[1]) return { type: "ignored" };
    const id = entry.topics[1].toLowerCase() as Hex;
    const pool = pools.get(id);
    if (!pool || pool.family !== "cl") return { type: "untracked", id, v4: true };
    if (topic0 === TOPICS.swapV4) {
      // amount0, amount1, sqrtPriceX96, liquidity, tick, fee
      const sqrtPriceX96 = word(entry.data, 2);
      const liquidity = word(entry.data, 3);
      const tick = word(entry.data, 4);
      if (tick < 0n) return { type: "ignored" };
      pool.state.sqrtPriceX96 = sqrtPriceX96;
      pool.state.liquidity = liquidity;
      pool.state.tick = int24(tick);
    } else {
      // tickLower, tickUpper, liquidityDelta, salt
      const lower = word(entry.data, 0);
      const upper = word(entry.data, 1);
      const delta = word(entry.data, 2);
      if (delta < 0n) return { type: "ignored" };
      const liquidityDelta = signed(delta, 256);
      if (liquidityDelta === 0n) return { type: "ignored" };
      return { type: "changed", id, delta: true, reload: applyDelta(pool.state, int24(lower), int24(upper), liquidityDelta) };
    }
    return { type: "changed", id };
  }

  const id = address as Hex;
  const pool = pools.get(id);

  if (topic0 === TOPICS.syncV2 || topic0 === TOPICS.syncAerodrome) {
    if (!pool) return { type: "untracked", id, v4: false };
    if (pool.family !== "cp") return { type: "ignored" };
    const reserve0 = word(entry.data, 0);
    const reserve1 = word(entry.data, 1);
    if (reserve0 < 0n || reserve1 < 0n) return { type: "ignored" };
    if (pool.reserve0 === reserve0 && pool.reserve1 === reserve1) return { type: "ignored" };
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    return { type: "changed", id };
  }

  if (topic0 === TOPICS.swapV3 || topic0 === TOPICS.swapPancakeV3) {
    if (!pool) return { type: "untracked", id, v4: false };
    if (pool.family !== "cl") return { type: "ignored" };
    const sqrtPriceX96 = word(entry.data, 2);
    const liquidity = word(entry.data, 3);
    const tick = word(entry.data, 4);
    if (tick < 0n) return { type: "ignored" };
    pool.state.sqrtPriceX96 = sqrtPriceX96;
    pool.state.liquidity = liquidity;
    pool.state.tick = int24(tick);
    return { type: "changed", id };
  }

  if (topic0 === TOPICS.mintV3 || topic0 === TOPICS.burnV3) {
    if (!pool) return { type: "ignored" };
    if (pool.family !== "cl" || !entry.topics[2] || !entry.topics[3]) return { type: "ignored" };
    const lower = int24(BigInt(entry.topics[2]));
    const upper = int24(BigInt(entry.topics[3]));
    // Mint data: sender, amount, amount0, amount1. Burn data: amount, amount0, amount1.
    const amount = word(entry.data, topic0 === TOPICS.mintV3 ? 1 : 0);
    if (amount <= 0n) return { type: "ignored" };
    const reload = applyDelta(pool.state, lower, upper, topic0 === TOPICS.mintV3 ? amount : -amount);
    return { type: "changed", id, delta: true, reload };
  }

  return { type: "ignored" };
}

/**
 * Applies a liquidity delta to local state. Ticks are only known inside the loaded window, so a
 * position reaching outside it (or one that contradicts local state) can't be applied tick by tick:
 * keep the active liquidity right and report that the window must be reloaded from chain.
 */
function applyDelta(state: ClState, lower: number, upper: number, delta: bigint): boolean {
  const known = (tick: number) => {
    const w = wordOf(tick, state.tickSpacing);
    return w >= state.wordLo && w <= state.wordHi;
  };
  const liquidityBefore = state.liquidity;
  if (known(lower) && known(upper)) {
    try {
      applyLiquidityDelta(state, lower, upper, delta);
      return false;
    } catch {
      state.liquidity = liquidityBefore;
    }
  }
  if (lower <= state.tick && state.tick < upper && state.liquidity + delta >= 0n) state.liquidity += delta;
  return true;
}
