import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  keccak256,
  parseAbi,
} from "viem";
import { type ClState, type TickInfo, wordOf } from "./clmath.js";
import { type ReadCall, multiread } from "./rpc.js";
import type { ClPool, DexConfig, V4Key } from "./types.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const DYNAMIC_FEE_FLAG = 0x800000;

export const v3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
export const slipstreamFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
  "function tickSpacings() view returns (int24[])",
]);
/**
 * Only the leading fields are declared: Uniswap V3, PancakeSwap V3 and Slipstream share them but
 * differ further down (slot0 and ticks() return different tails), and decoding stops at what is declared.
 */
export const clPoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);
export const poolManagerAbi = parseAbi(["function extsload(bytes32[] slots) view returns (bytes32[])"]);
export const positionManagerAbi = parseAbi([
  "function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);

// ---------------------------------------------------------------- V4 storage layout (v4-core StateLibrary)

const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
const TICKS_OFFSET = 4n;
const TICK_BITMAP_OFFSET = 5n;
const EXTSLOAD_CHUNK = 500;

export interface V4KeyBasic {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function v4PoolId(key: V4KeyBasic): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

function slotHex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function v4StateSlot(poolId: Hex): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT])));
}

function mappingSlot(key: bigint, mapping: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "int256" }, { type: "uint256" }], [key, mapping]));
}

export function v4Slots(poolId: Hex) {
  const state = v4StateSlot(poolId);
  return {
    slot0: slotHex(state),
    liquidity: slotHex(state + LIQUIDITY_OFFSET),
    tick: (tick: number) => mappingSlot(BigInt(tick), state + TICKS_OFFSET),
    bitmap: (word: number) => mappingSlot(BigInt(word), state + TICK_BITMAP_OFFSET),
  };
}

function signed(value: bigint, bits: number): bigint {
  const masked = value & ((1n << BigInt(bits)) - 1n);
  return masked >> BigInt(bits - 1) ? masked - (1n << BigInt(bits)) : masked;
}

/** Decodes Pool.State slot0: sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24). */
export function decodeV4Slot0(word: Hex) {
  const v = BigInt(word);
  return {
    sqrtPriceX96: v & ((1n << 160n) - 1n),
    tick: Number(signed(v >> 160n, 24)),
    protocolFee: Number((v >> 184n) & 0xffffffn),
    lpFee: Number((v >> 208n) & 0xffffffn),
  };
}

/** Decodes a V4 TickInfo first slot: liquidityGross (low 128) | liquidityNet (high 128, signed). */
export function decodeV4TickInfo(word: Hex): { liquidityGross: bigint; liquidityNet: bigint } {
  const v = BigInt(word);
  return { liquidityGross: v & ((1n << 128n) - 1n), liquidityNet: signed(v >> 128n, 128) };
}

async function extsload(client: PublicClient, poolManager: Address, slots: Hex[]): Promise<Hex[]> {
  const chunks: Hex[][] = [];
  for (let i = 0; i < slots.length; i += EXTSLOAD_CHUNK) chunks.push(slots.slice(i, i + EXTSLOAD_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => client.readContract({ address: poolManager, abi: poolManagerAbi, functionName: "extsload", args: [chunk] })),
  );
  return results.flat() as Hex[];
}

// ---------------------------------------------------------------- tick windows

/** Bitmap words on each side of the current one needed to cover a ±`rangePct` price move. */
export function windowWords(tickSpacing: number, rangePct: number): number {
  const ticks = Math.log(1 + rangePct) / Math.log(1.0001);
  return Math.min(Math.max(Math.ceil(ticks / (256 * tickSpacing)), 1), 32);
}

/** True when the current tick is within one word of the edge of the loaded window. */
export function nearWindowEdge(state: ClState): boolean {
  const w = wordOf(state.tick, state.tickSpacing);
  return w - 1 <= state.wordLo || w + 1 >= state.wordHi;
}

function initializedTicks(word: number, bitmap: bigint, tickSpacing: number): number[] {
  const ticks: number[] = [];
  for (let bit = 0; bitmap !== 0n && bit < 256; bit++, bitmap >>= 1n) {
    if (bitmap & 1n) ticks.push((word * 256 + bit) * tickSpacing);
  }
  return ticks;
}

/**
 * (Re)loads the initialized ticks around each pool's current price. Replaces `state.ticks` and
 * the window bounds atomically per pool, so quotes never mix old and new tick sets.
 */
export async function loadTickWindows(client: PublicClient, pools: ClPool[], rangePct: number, poolManager?: Address): Promise<void> {
  const plans = pools.map((pool) => {
    const w = windowWords(pool.state.tickSpacing, rangePct);
    const center = wordOf(pool.state.tick, pool.state.tickSpacing);
    const words: number[] = [];
    for (let i = center - w; i <= center + w; i++) words.push(i);
    return { pool, words, lo: center - w, hi: center + w };
  });

  // Bitmaps: V3-style pools via tickBitmap(), V4 pools via extsload on the PoolManager.
  const v3Plans = plans.filter((p) => !p.pool.v4);
  const v4Plans = plans.filter((p) => p.pool.v4);
  const v3Bitmaps = await multiread<bigint>(
    client,
    v3Plans.flatMap((p) => p.words.map((w) => ({ address: p.pool.id as Address, abi: clPoolAbi, functionName: "tickBitmap", args: [w] }) as ReadCall)),
  );
  const v4Bitmaps =
    v4Plans.length && poolManager
      ? (await extsload(client, poolManager, v4Plans.flatMap((p) => p.words.map((w) => v4Slots(p.pool.id).bitmap(w))))).map(BigInt)
      : [];

  const tickLists = new Map<ClPool, number[]>();
  let i = 0;
  for (const p of v3Plans) {
    const ticks: number[] = [];
    for (const w of p.words) ticks.push(...initializedTicks(w, v3Bitmaps[i++] ?? 0n, p.pool.state.tickSpacing));
    tickLists.set(p.pool, ticks);
  }
  i = 0;
  for (const p of v4Plans) {
    const ticks: number[] = [];
    for (const w of p.words) ticks.push(...initializedTicks(w, v4Bitmaps[i++] ?? 0n, p.pool.state.tickSpacing));
    tickLists.set(p.pool, ticks);
  }

  // Tick infos for every initialized tick found.
  const v3Infos = await multiread<readonly [bigint, bigint]>(
    client,
    v3Plans.flatMap((p) => tickLists.get(p.pool)!.map((t) => ({ address: p.pool.id as Address, abi: clPoolAbi, functionName: "ticks", args: [t] }) as ReadCall)),
  );
  const v4Infos =
    v4Plans.length && poolManager
      ? (await extsload(client, poolManager, v4Plans.flatMap((p) => tickLists.get(p.pool)!.map((t) => v4Slots(p.pool.id).tick(t))))).map(decodeV4TickInfo)
      : [];

  let j = 0;
  for (const p of v3Plans) {
    const infos: TickInfo[] = [];
    for (const tick of tickLists.get(p.pool)!) {
      const info = v3Infos[j++];
      if (info && info[0] > 0n) infos.push({ tick, liquidityGross: info[0], liquidityNet: info[1] });
    }
    commitWindow(p.pool, infos, p.lo, p.hi);
  }
  j = 0;
  for (const p of v4Plans) {
    const infos: TickInfo[] = [];
    for (const tick of tickLists.get(p.pool)!) {
      const info = v4Infos[j++];
      if (info && info.liquidityGross > 0n) infos.push({ tick, ...info });
    }
    commitWindow(p.pool, infos, p.lo, p.hi);
  }
}

function commitWindow(pool: ClPool, ticks: TickInfo[], wordLo: number, wordHi: number): void {
  ticks.sort((a, b) => a.tick - b.tick);
  pool.state.ticks = ticks;
  pool.state.wordLo = wordLo;
  pool.state.wordHi = wordHi;
}

// ---------------------------------------------------------------- V3-style discovery

/**
 * Finds V3-style pools (Uniswap/Sushi V3 by fee tier, PancakeSwap V3 by fee tier, Slipstream by
 * tick spacing) for the given token pairs and loads their slot0, liquidity, spacing and fee.
 */
export async function loadV3StylePools(client: PublicClient, dex: DexConfig, pairs: [Address, Address][]): Promise<ClPool[]> {
  let selectors: number[];
  if (dex.kind === "slipstream") {
    selectors = dex.tickSpacings ?? [];
    if (selectors.length === 0) {
      const spacings = await client
        .readContract({ address: dex.factory, abi: slipstreamFactoryAbi, functionName: "tickSpacings" })
        .catch(() => [] as readonly number[]);
      selectors = [...spacings].map(Number);
    }
  } else {
    selectors = dex.feeTiers ?? [100, 500, 3000, 10_000];
  }
  const abi = dex.kind === "slipstream" ? slipstreamFactoryAbi : v3FactoryAbi;
  const lookups = pairs.flatMap(([a, b]) => selectors.map((s) => ({ address: dex.factory, abi, functionName: "getPool", args: [a, b, s] }) as ReadCall));
  const found = await multiread<Address>(client, lookups);
  const addresses = [...new Set(found.filter((a): a is Address => !!a && a !== ZERO).map((a) => a.toLowerCase() as Address))];
  if (addresses.length === 0) return [];

  const fields = ["token0", "token1", "slot0", "liquidity", "tickSpacing", "fee"] as const;
  const details = await multiread<unknown>(
    client,
    addresses.flatMap((address) => fields.map((functionName) => ({ address, abi: clPoolAbi, functionName }) as ReadCall)),
  );
  const pools: ClPool[] = [];
  addresses.forEach((address, i) => {
    const [token0, token1, slot0, liquidity, tickSpacing, fee] = details.slice(i * fields.length, (i + 1) * fields.length) as [
      Address | undefined,
      Address | undefined,
      readonly [bigint, number] | undefined,
      bigint | undefined,
      number | undefined,
      number | undefined,
    ];
    if (!token0 || !token1 || !slot0 || liquidity === undefined || !tickSpacing || fee === undefined) return;
    if (slot0[0] === 0n || fee >= 1_000_000) return;
    pools.push({
      family: "cl",
      id: address,
      dex: dex.name,
      kind: dex.kind,
      token0: token0.toLowerCase() as Address,
      token1: token1.toLowerCase() as Address,
      state: emptyState(slot0[0], Number(slot0[1]), liquidity, Number(tickSpacing), Number(fee)),
    });
  });
  return pools;
}

/** Re-reads slot0, liquidity and (dynamic) fee for V3-style pools. Returns ids that changed. */
export async function refreshV3StylePools(client: PublicClient, pools: ClPool[]): Promise<Set<Hex>> {
  const fields = ["slot0", "liquidity", "fee"] as const;
  const results = await multiread<unknown>(
    client,
    pools.flatMap((p) => fields.map((functionName) => ({ address: p.id as Address, abi: clPoolAbi, functionName }) as ReadCall)),
  );
  const changed = new Set<Hex>();
  pools.forEach((pool, i) => {
    const [slot0, liquidity, fee] = results.slice(i * 3, i * 3 + 3) as [readonly [bigint, number] | undefined, bigint | undefined, number | undefined];
    if (!slot0 || liquidity === undefined || fee === undefined) return;
    const s = pool.state;
    if (s.sqrtPriceX96 !== slot0[0] || s.liquidity !== liquidity || s.fee !== Number(fee) || s.tick !== Number(slot0[1])) changed.add(pool.id);
    s.sqrtPriceX96 = slot0[0];
    s.tick = Number(slot0[1]);
    s.liquidity = liquidity;
    s.fee = Number(fee);
  });
  return changed;
}

function emptyState(sqrtPriceX96: bigint, tick: number, liquidity: bigint, tickSpacing: number, fee: number): ClState {
  // Empty window (wordLo > wordHi): quotes return complete=false until ticks are loaded.
  return { sqrtPriceX96, tick, liquidity, tickSpacing, fee, ticks: [], wordLo: 1, wordHi: 0 };
}

// ---------------------------------------------------------------- V4 discovery

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/**
 * Candidate V4 keys for token pairs: every configured (fee, tickSpacing) without hooks, with the
 * pair's WETH also tried as native ETH (most V4 ETH liquidity is native).
 */
export function candidateV4Keys(pairs: [Address, Address][], combos: [number, number][], weth: Address): V4KeyBasic[] {
  const keys: V4KeyBasic[] = [];
  for (const [a, b] of pairs) {
    const variants: [Address, Address][] = [[a, b]];
    if (a === weth) variants.push([ZERO, b]);
    if (b === weth) variants.push([a, ZERO]);
    for (const [x, y] of variants) {
      const [currency0, currency1] = sortCurrencies(x, y);
      for (const [fee, tickSpacing] of combos) keys.push({ currency0, currency1, fee, tickSpacing, hooks: ZERO });
    }
  }
  return keys;
}

/** Loads the initialized pools among `keys`. Native ETH is represented by `weth` in token0/token1. */
export async function loadV4Pools(client: PublicClient, dex: DexConfig, keys: V4KeyBasic[], weth: Address): Promise<ClPool[]> {
  const unique = new Map<Hex, V4KeyBasic>();
  for (const key of keys) {
    if (key.fee & DYNAMIC_FEE_FLAG) continue; // fee set by hooks per swap: not quotable locally
    unique.set(v4PoolId(key), key);
  }
  const ids = [...unique.keys()];
  if (ids.length === 0) return [];
  const words = await extsload(client, dex.factory, ids.flatMap((id) => [v4Slots(id).slot0, v4Slots(id).liquidity]));

  const pools: ClPool[] = [];
  ids.forEach((id, i) => {
    const key = unique.get(id)!;
    const slot0 = decodeV4Slot0(words[i * 2]!);
    if (slot0.sqrtPriceX96 === 0n) return; // not initialized
    const token0 = key.currency0 === ZERO ? weth : key.currency0;
    const token1 = key.currency1 === ZERO ? weth : key.currency1;
    if (token0 === token1) return; // ETH/WETH
    const v4: V4Key = { ...key, protocolFee: slot0.protocolFee, lpFee: slot0.lpFee };
    pools.push({
      family: "cl",
      id: id.toLowerCase() as Hex,
      dex: dex.name,
      kind: "v4",
      token0: token0.toLowerCase() as Address,
      token1: token1.toLowerCase() as Address,
      state: emptyState(slot0.sqrtPriceX96, slot0.tick, BigInt(words[i * 2 + 1]!) & ((1n << 128n) - 1n), key.tickSpacing, slot0.lpFee),
      v4,
    });
  });
  return pools;
}

/** Re-reads slot0 and liquidity for V4 pools. Returns ids that changed. */
export async function refreshV4Pools(client: PublicClient, poolManager: Address, pools: ClPool[]): Promise<Set<Hex>> {
  const words = await extsload(client, poolManager, pools.flatMap((p) => [v4Slots(p.id).slot0, v4Slots(p.id).liquidity]));
  const changed = new Set<Hex>();
  pools.forEach((pool, i) => {
    const slot0 = decodeV4Slot0(words[i * 2]!);
    const liquidity = BigInt(words[i * 2 + 1]!) & ((1n << 128n) - 1n);
    const s = pool.state;
    if (s.sqrtPriceX96 !== slot0.sqrtPriceX96 || s.liquidity !== liquidity || s.tick !== slot0.tick || s.fee !== slot0.lpFee) changed.add(pool.id);
    s.sqrtPriceX96 = slot0.sqrtPriceX96;
    s.tick = slot0.tick;
    s.liquidity = liquidity;
    s.fee = slot0.lpFee;
    if (pool.v4) {
      pool.v4.protocolFee = slot0.protocolFee;
      pool.v4.lpFee = slot0.lpFee;
    }
  });
  return changed;
}

/**
 * Resolves V4 pool ids seen in Swap events to their keys through the PositionManager (which stores
 * the key of every pool it has minted into). Keys are checked against the id, and only pools whose
 * hooks are allowed are returned.
 */
export async function resolveV4Keys(client: PublicClient, positionManager: Address, ids: Hex[], allowedHooks: ReadonlySet<Address>): Promise<V4KeyBasic[]> {
  const results = await multiread<readonly [Address, Address, number, number, Address]>(
    client,
    ids.map((id) => ({ address: positionManager, abi: positionManagerAbi, functionName: "poolKeys", args: [id.slice(0, 52) as Hex] }) as ReadCall),
  );
  const keys: V4KeyBasic[] = [];
  results.forEach((r, i) => {
    if (!r) return;
    const key: V4KeyBasic = {
      currency0: r[0].toLowerCase() as Address,
      currency1: r[1].toLowerCase() as Address,
      fee: Number(r[2]),
      tickSpacing: Number(r[3]),
      hooks: r[4].toLowerCase() as Address,
    };
    if (v4PoolId(key) !== ids[i]!.toLowerCase()) return;
    if (key.hooks !== ZERO && !allowedHooks.has(key.hooks)) return;
    keys.push(key);
  });
  return keys;
}
