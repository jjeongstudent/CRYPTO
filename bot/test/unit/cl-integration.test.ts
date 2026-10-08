import { type Address, type Hex, encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { type ClState, getSqrtRatioAtTick, wordOf } from "../../src/clmath.js";
import { decodeV4Slot0, decodeV4TickInfo, v4PoolId } from "../../src/concentrated.js";
import { findCycles } from "../../src/cycles.js";
import { TOPICS, applyLog } from "../../src/events.js";
import { bestRouteTrade, clSwapFee, routeMarginalRate, routeQuote } from "../../src/quote.js";
import { findOpportunities } from "../../src/strategy.js";
import type { ClPool, CpPool, Hop, Pool } from "../../src/types.js";

const E18 = 10n ** 18n;
const W = "0x00000000000000000000000000000000000000a1" as Address;
const A = "0x00000000000000000000000000000000000000b2" as Address;
const PM = "0x00000000000000000000000000000000000000fe" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const eventsAbi = parseAbi([
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);
const v4Abi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);

function cp(id: string, token0: Address, token1: Address, reserve0: bigint, reserve1: bigint, feeBps = 30): CpPool {
  return { family: "cp", id: id as Hex, dex: "v2", kind: "v2", token0, token1, feeBps, reserve0, reserve1 };
}

/** A single full-window position of liquidity L around `tick`. */
function clState(tick: number, liquidity: bigint, tickSpacing = 60, fee = 3000, halfWidth = 6000): ClState {
  const lower = Math.floor((tick - halfWidth) / tickSpacing) * tickSpacing;
  const upper = Math.ceil((tick + halfWidth) / tickSpacing) * tickSpacing;
  return {
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tick,
    liquidity,
    tickSpacing,
    fee,
    ticks: [
      { tick: lower, liquidityGross: liquidity, liquidityNet: liquidity },
      { tick: upper, liquidityGross: liquidity, liquidityNet: -liquidity },
    ],
    wordLo: wordOf(lower, tickSpacing) - 1,
    wordHi: wordOf(upper, tickSpacing) + 1,
  };
}

function cl(id: string, token0: Address, token1: Address, state: ClState, v4?: ClPool["v4"]): ClPool {
  return { family: "cl", id: id as Hex, dex: v4 ? "v4" : "v3", kind: v4 ? "v4" : "v3", token0, token1, state, v4 };
}

describe("applyLog", () => {
  const v2 = cp("0x0000000000000000000000000000000000000001", W, A, 1n, 1n);
  const v3 = cl("0x0000000000000000000000000000000000000002", W, A, clState(0, E18));
  const v4id = v4PoolId({ currency0: ZERO, currency1: A, fee: 3000, tickSpacing: 60, hooks: ZERO });
  const v4 = cl(v4id, W, A, clState(0, E18), { currency0: ZERO, currency1: A, fee: 3000, tickSpacing: 60, hooks: ZERO, protocolFee: 0, lpFee: 3000 });
  const pools = new Map<Hex, Pool>([v2, v3, v4].map((p) => [p.id, p]));

  it("applies V2/Aerodrome Sync as absolute reserves", () => {
    const data = encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }], [7n * E18, 21_000n * E18]);
    const effect = applyLog(pools, { address: v2.id as Address, topics: [TOPICS.syncV2], data }, PM);
    expect(effect).toEqual({ type: "changed", id: v2.id });
    expect([v2.reserve0, v2.reserve1]).toEqual([7n * E18, 21_000n * E18]);
    // Same reserves again: nothing changed.
    expect(applyLog(pools, { address: v2.id as Address, topics: [TOPICS.syncAerodrome], data }, PM).type).toBe("ignored");
  });

  it("applies V3 Swap including negative ticks", () => {
    const topics = encodeEventTopics({ abi: eventsAbi, eventName: "Swap", args: { sender: W, recipient: A } }) as Hex[];
    const sqrt = getSqrtRatioAtTick(-12_345);
    const data = encodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
      [5n, -7n, sqrt, 123n, -12_345],
    );
    expect(topics[0]).toBe(TOPICS.swapV3);
    expect(applyLog(pools, { address: v3.id as Address, topics, data }, PM)).toEqual({ type: "changed", id: v3.id });
    expect(v3.state).toMatchObject({ sqrtPriceX96: sqrt, liquidity: 123n, tick: -12_345 });
  });

  it("applies PancakeSwap V3 Swap (two extra trailing fields)", () => {
    const data = encodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint128" }, { type: "uint128" }],
      [1n, -1n, getSqrtRatioAtTick(60), 456n, 60, 9n, 9n],
    );
    applyLog(pools, { address: v3.id as Address, topics: [TOPICS.swapPancakeV3, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`], data }, PM);
    expect(v3.state).toMatchObject({ liquidity: 456n, tick: 60 });
  });

  it("applies V3 Mint and Burn as liquidity deltas with signed tick topics", () => {
    const pool = cl("0x0000000000000000000000000000000000000003", W, A, clState(0, 1_000n));
    const local = new Map<Hex, Pool>([[pool.id, pool]]);
    const mintTopics = encodeEventTopics({ abi: eventsAbi, eventName: "Mint", args: { owner: W, tickLower: -120, tickUpper: 180 } }) as Hex[];
    const mintData = encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [W, 500n, 1n, 1n]);
    expect(mintTopics[0]).toBe(TOPICS.mintV3);
    applyLog(local, { address: pool.id as Address, topics: mintTopics, data: mintData }, PM);
    expect(pool.state.liquidity).toBe(1_500n); // in range: -120 <= 0 < 180
    expect(pool.state.ticks.find((t) => t.tick === -120)?.liquidityNet).toBe(500n);
    expect(pool.state.ticks.find((t) => t.tick === 180)?.liquidityNet).toBe(-500n);

    const burnTopics = encodeEventTopics({ abi: eventsAbi, eventName: "Burn", args: { owner: W, tickLower: -120, tickUpper: 180 } }) as Hex[];
    const burnData = encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [500n, 1n, 1n]);
    applyLog(local, { address: pool.id as Address, topics: burnTopics, data: burnData }, PM);
    expect(pool.state.liquidity).toBe(1_000n);
    expect(pool.state.ticks.some((t) => t.tick === -120 || t.tick === 180)).toBe(false);
  });

  it("applies V4 Swap and ModifyLiquidity only from the PoolManager", () => {
    const swapTopics = encodeEventTopics({ abi: v4Abi, eventName: "Swap", args: { id: v4id, sender: W } }) as Hex[];
    const swapData = encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [-1n, 1n, getSqrtRatioAtTick(-61), 777n, -61, 3000],
    );
    expect(swapTopics[0]).toBe(TOPICS.swapV4);
    expect(applyLog(pools, { address: W, topics: swapTopics, data: swapData }, PM).type).toBe("ignored");
    expect(applyLog(pools, { address: PM, topics: swapTopics, data: swapData }, PM)).toEqual({ type: "changed", id: v4id });
    expect(v4.state).toMatchObject({ liquidity: 777n, tick: -61 });

    const modTopics = encodeEventTopics({ abi: v4Abi, eventName: "ModifyLiquidity", args: { id: v4id, sender: W } }) as Hex[];
    const modify = (delta: bigint) =>
      encodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }], [-600, 600, delta, `0x${"00".repeat(32)}`]);
    expect(applyLog(pools, { address: PM, topics: modTopics, data: modify(100n) }, PM)).toEqual({ type: "changed", id: v4id, delta: true, reload: false });
    applyLog(pools, { address: PM, topics: modTopics, data: modify(-77n) }, PM);
    expect(v4.state.liquidity).toBe(800n);
    expect(v4.state.ticks.find((t) => t.tick === -600)?.liquidityNet).toBe(23n);

    const unknown = encodeEventTopics({ abi: v4Abi, eventName: "Swap", args: { id: `0x${"22".repeat(32)}`, sender: W } }) as Hex[];
    expect(applyLog(pools, { address: PM, topics: unknown, data: swapData }, PM)).toEqual({ type: "untracked", id: `0x${"22".repeat(32)}`, v4: true });
  });
});

describe("liquidity deltas outside the loaded window", () => {
  it("keep active liquidity right and request a reload instead of throwing", () => {
    const pool = cl("0x0000000000000000000000000000000000000004", W, A, clState(0, 1_000n, 60, 3000, 600));
    pool.state.wordLo = 0;
    pool.state.wordHi = 0; // only the word holding ticks [0, 15360) is known
    const local = new Map<Hex, Pool>([[pool.id, pool]]);
    // A burn of a position whose lower tick lies in the unknown word below: local state has no such tick.
    const topics = encodeEventTopics({ abi: eventsAbi, eventName: "Burn", args: { owner: W, tickLower: -60_000, tickUpper: 60 } }) as Hex[];
    const data = encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [300n, 1n, 1n]);
    expect(applyLog(local, { address: pool.id as Address, topics, data }, PM)).toEqual({ type: "changed", id: pool.id, delta: true, reload: true });
    expect(pool.state.liquidity).toBe(700n);
  });

  it("request a reload when an in-window delta contradicts local ticks", () => {
    const pool = cl("0x0000000000000000000000000000000000000005", W, A, clState(0, 1_000n));
    const local = new Map<Hex, Pool>([[pool.id, pool]]);
    const topics = encodeEventTopics({ abi: eventsAbi, eventName: "Burn", args: { owner: W, tickLower: -120, tickUpper: 120 } }) as Hex[];
    const data = encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [5_000n, 1n, 1n]);
    const effect = applyLog(local, { address: pool.id as Address, topics, data }, PM);
    expect(effect).toMatchObject({ type: "changed", reload: true });
    expect(pool.state.liquidity).toBe(1_000n); // would go negative: left alone until the reload
  });
});

describe("V4 storage decoding", () => {
  it("unpacks slot0 and tick info words", () => {
    const sqrt = getSqrtRatioAtTick(-200);
    const tick = BigInt.asUintN(24, -200n);
    const word = (3000n << 208n) | (0x0010_05n << 184n) | (tick << 160n) | sqrt;
    expect(decodeV4Slot0(`0x${word.toString(16).padStart(64, "0")}`)).toEqual({ sqrtPriceX96: sqrt, tick: -200, protocolFee: 0x1005, lpFee: 3000 });
    const info = (BigInt.asUintN(128, -5n) << 128n) | 9n;
    expect(decodeV4TickInfo(`0x${info.toString(16).padStart(64, "0")}`)).toEqual({ liquidityGross: 9n, liquidityNet: -5n });
  });

  it("applies V4 protocol fees per direction", () => {
    const pool = cl(`0x${"33".repeat(32)}`, W, A, clState(0, E18, 60, 3000), {
      currency0: W, currency1: A, fee: 3000, tickSpacing: 60, hooks: ZERO, protocolFee: (100 << 12) | 50, lpFee: 3000,
    });
    expect(clSwapFee(pool, true)).toBe(50 + 3000 - Math.floor((50 * 3000) / 1e6));
    expect(clSwapFee(pool, false)).toBe(100 + 3000 - Math.floor((100 * 3000) / 1e6));
  });
});

describe("mixed constant-product / concentrated routes", () => {
  /** Integer ternary search over the exact route quote: the brute-force reference. */
  function bruteForce(hops: Hop[], cap: bigint): bigint {
    let lo = 1n;
    let hi = cap;
    const profit = (x: bigint) => routeQuote(hops, x) - x;
    while (hi - lo > 2n) {
      const m1 = lo + (hi - lo) / 3n;
      const m2 = hi - (hi - lo) / 3n;
      if (profit(m1) < profit(m2)) lo = m1;
      else hi = m2;
    }
    let best = profit(lo);
    for (let x = lo; x <= hi; x++) if (profit(x) > best) best = profit(x);
    return best;
  }

  it("sizes a V2 -> V3 arbitrage within dust of brute force", () => {
    // V3 pool prices A at ~e^(0.0001·tick); V2 pool is skewed against it.
    const tick = 69_082; // ≈ 1000 A per W
    for (const skew of [1.02, 1.05, 1.15]) {
      const v3 = cl("0x00000000000000000000000000000000000000c1", W, A, clState(tick, 10n ** 21n, 60, 500));
      const price = 1.0001 ** tick;
      const v2 = cp("0x00000000000000000000000000000000000000c2", W, A, 100n * E18, BigInt(Math.round(price * skew * 100)) * E18);
      const opps = findOpportunities(findCycles([v2, v3], W, 2), 50n * E18, 0n);
      expect(opps).toHaveLength(1);
      const opp = opps[0]!;
      // Sells W where A is cheap (the skewed V2 pool), buys W back on V3.
      expect(opp.cycle.hops[0]!.pool.id).toBe(v2.id);
      const brute = bruteForce(opp.cycle.hops, 50n * E18);
      expect(opp.grossProfit >= brute - brute / 100_000n - 10n).toBe(true);
      expect(opp.amountOut).toBe(routeQuote(opp.cycle.hops, opp.amountIn));
    }
  });

  it("rejects routes whose marginal rate is not above 1 without exact math", () => {
    const tick = 0;
    const v3 = cl("0x00000000000000000000000000000000000000d1", W, A, clState(tick, E18 * 1000n, 60, 3000));
    const v2 = cp("0x00000000000000000000000000000000000000d2", W, A, 1000n * E18, 1000n * E18);
    const cycles = findCycles([v2, v3], W, 2);
    for (const c of cycles) expect(routeMarginalRate(c.hops) < 1).toBe(true);
    expect(findOpportunities(cycles, 10n * E18, 0n)).toHaveLength(0);
  });

  it("never quotes past the loaded tick window (conservative partial fills)", () => {
    const state = clState(0, E18, 60, 3000, 120);
    state.wordLo = 0; // the downward side of the window is unknown
    state.wordHi = 0;
    const v3 = cl("0x00000000000000000000000000000000000000e1", W, A, state);
    const v2 = cp("0x00000000000000000000000000000000000000e2", W, A, 10n * E18, 20n * E18);
    const trade = bestRouteTrade(findCycles([v2, v3], W, 2).find((c) => c.hops[0]!.pool.id === v2.id)!.hops, 1000n * E18);
    if (trade) expect(trade.amountOut).toBe(trade.amountIn + trade.profit);
  });
});
