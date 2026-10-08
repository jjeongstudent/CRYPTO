import { describe, expect, it } from "vitest";
import {
  type ClState,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
  applyLiquidityDelta,
  compressTick,
  computeSwapStepExactIn,
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  mulDiv,
  mulDivRoundingUp,
  quoteExactInput,
  wordOf,
} from "../../src/clmath.js";

// Bit-exactness against the real contracts is in test/parity; these are properties and the
// known vectors from v3-core's own test suite (test/*.spec.ts).

const E18 = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function state(overrides: Partial<ClState> = {}): ClState {
  return {
    sqrtPriceX96: Q96,
    tick: 0,
    liquidity: 0n,
    tickSpacing: 60,
    fee: 3000,
    ticks: [],
    wordLo: wordOf(MIN_TICK, overrides.tickSpacing ?? 60),
    wordHi: wordOf(MAX_TICK, overrides.tickSpacing ?? 60),
    ...overrides,
  };
}

/** A state with the given positions minted onto an empty pool at `tick`'s price. */
function poolWith(positions: [number, number, bigint][], overrides: Partial<ClState> = {}): ClState {
  const s = state(overrides);
  for (const [lo, hi, l] of positions) applyLiquidityDelta(s, lo, hi, l);
  return s;
}

describe("FullMath", () => {
  it("mulDiv floors with a 512-bit intermediate and reverts on overflow or zero", () => {
    expect(mulDiv(MAX_UINT256, MAX_UINT256, MAX_UINT256)).toBe(MAX_UINT256);
    expect(mulDiv(Q96, 3n * Q96, 2n * Q96)).toBe((3n * Q96) / 2n);
    expect(mulDiv(7n, 3n, 2n)).toBe(10n);
    expect(() => mulDiv(MAX_UINT256, 2n, 1n)).toThrow();
    expect(() => mulDiv(1n, 1n, 0n)).toThrow();
  });

  it("mulDivRoundingUp rounds up only on a remainder", () => {
    expect(mulDivRoundingUp(7n, 3n, 2n)).toBe(11n);
    expect(mulDivRoundingUp(8n, 3n, 2n)).toBe(12n);
    expect(() => mulDivRoundingUp(MAX_UINT256, MAX_UINT256 - 1n, MAX_UINT256 - 2n)).toThrow();
  });
});

describe("TickMath", () => {
  it("matches v3-core's known values", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MIN_TICK + 1)).toBe(4295343490n);
    expect(getSqrtRatioAtTick(MAX_TICK - 1)).toBe(1461373636630004318706518188784493106690254656249n);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(getTickAtSqrtRatio(MIN_SQRT_RATIO)).toBe(MIN_TICK);
    expect(getTickAtSqrtRatio(MAX_SQRT_RATIO - 1n)).toBe(MAX_TICK - 1);
    expect(getTickAtSqrtRatio(Q96)).toBe(0);
    expect(getTickAtSqrtRatio(Q96 - 1n)).toBe(-1);
  });

  it("rejects out-of-range ticks and prices", () => {
    for (const t of [MIN_TICK - 1, MAX_TICK + 1, 0.5, Number.NaN]) expect(() => getSqrtRatioAtTick(t)).toThrow();
    for (const p of [0n, MIN_SQRT_RATIO - 1n, MAX_SQRT_RATIO]) expect(() => getTickAtSqrtRatio(p)).toThrow();
  });

  it("is strictly increasing and round-trips at, just below and between tick boundaries", () => {
    const rand = rng(11);
    for (let i = 0; i < 2000; i++) {
      const t = MIN_TICK + 1 + Math.floor(rand() * (MAX_TICK - MIN_TICK - 1));
      const p = getSqrtRatioAtTick(t);
      const next = getSqrtRatioAtTick(t + 1);
      expect(getSqrtRatioAtTick(t - 1) < p && p < next).toBe(true);
      expect(getTickAtSqrtRatio(p)).toBe(t);
      expect(getTickAtSqrtRatio(p - 1n)).toBe(t - 1);
      // Greatest tick whose ratio is <= the price, for a price strictly inside (t, t + 1).
      if (next - p > 1n) expect(getTickAtSqrtRatio(p + 1n + BigInt(Math.floor(rand() * Number(next - p - 1n))))).toBe(t);
    }
  });
});

describe("SqrtPriceMath", () => {
  // encodePriceSqrt(121, 100) from v3-core's tests: floor(1.1 * 2^96).
  const P121_100 = 87150978765690771352898345369n;

  it("getAmount0Delta / getAmount1Delta match v3-core's vectors and are order-insensitive", () => {
    expect(getAmount0Delta(Q96, P121_100, E18, true)).toBe(90909090909090910n);
    expect(getAmount0Delta(Q96, P121_100, E18, false)).toBe(90909090909090909n);
    expect(getAmount0Delta(P121_100, Q96, E18, true)).toBe(90909090909090910n);
    expect(getAmount1Delta(Q96, P121_100, E18, true)).toBe(100000000000000000n);
    expect(getAmount1Delta(Q96, P121_100, E18, false)).toBe(99999999999999999n);
    expect(getAmount0Delta(Q96, 2n * Q96, 0n, true)).toBe(0n);
    expect(getAmount1Delta(Q96, Q96, E18, true)).toBe(0n);
    expect(() => getAmount0Delta(0n, Q96, E18, true)).toThrow();
  });

  it("getNextSqrtPriceFromInput matches v3-core's vectors, including the overflow fallback", () => {
    expect(getNextSqrtPriceFromInput(Q96, E18, E18 / 10n, false)).toBe(87150978765690771352898345369n);
    expect(getNextSqrtPriceFromInput(Q96, E18, E18 / 10n, true)).toBe(72025602285694852357767227579n);
    expect(getNextSqrtPriceFromInput(Q96, 10n * E18, 1n << 100n, true)).toBe(624999999995069620n);
    expect(getNextSqrtPriceFromInput(Q96, E18 / 10n, 0n, true)).toBe(Q96);
    expect(getNextSqrtPriceFromInput(Q96, E18 / 10n, 0n, false)).toBe(Q96);
    // amount * price overflows uint256: Solidity falls back to L / (L/√P + amount).
    expect(getNextSqrtPriceFromInput(Q96, 1n, MAX_UINT256 / 2n, true)).toBe(1n);
    expect(getNextSqrtPriceFromInput(1n, 1n, 1n << 255n, true)).toBe(1n);
    const sqrtP = (1n << 160n) - 1n;
    const maxAmountNoOverflow = MAX_UINT256 - (MAX_UINT128 << 96n) / sqrtP;
    expect(getNextSqrtPriceFromInput(sqrtP, MAX_UINT128, maxAmountNoOverflow, true)).toBe(1n);
    expect(() => getNextSqrtPriceFromInput(sqrtP, MAX_UINT128, maxAmountNoOverflow + 1n, true)).toThrow();
    // Reverts: zero price or liquidity, price overflowing uint160.
    expect(() => getNextSqrtPriceFromInput(0n, 0n, E18 / 10n, false)).toThrow();
    expect(() => getNextSqrtPriceFromInput(1n, 0n, E18 / 10n, true)).toThrow();
    expect(() => getNextSqrtPriceFromInput((1n << 160n) - 1n, 1024n, 1024n, false)).toThrow();
  });
});

describe("computeSwapStepExactIn", () => {
  it("matches v3-core's exact-input vectors", () => {
    // Fully spent, one for zero (the target is never reached so its exact value does not matter).
    const spent = computeSwapStepExactIn(Q96, getSqrtRatioAtTick(23027), 2n * E18, E18, 600);
    expect(spent).toEqual({
      sqrtPriceNextX96: getNextSqrtPriceFromInput(Q96, 2n * E18, (E18 * 9994n) / 10000n, false),
      amountIn: 999400000000000000n,
      amountOut: 666399946655997866n,
      feeAmount: 600000000000000n,
    });
    expect(computeSwapStepExactIn(2n, 1n, 1n, 3915081100057732413702495386755767n, 1)).toEqual({
      sqrtPriceNextX96: 1n,
      amountIn: 39614081257132168796771975168n,
      amountOut: 0n,
      feeAmount: 39614120871253040049813n,
    });
    expect(computeSwapStepExactIn(2413n, 79887613182836312n, 1985041575832132834610021537970n, 10n, 1872)).toEqual({
      sqrtPriceNextX96: 2413n,
      amountIn: 0n,
      amountOut: 0n,
      feeAmount: 10n,
    });
  });

  it("never spends more than the remaining amount and caps at the target", () => {
    const rand = rng(5);
    for (let i = 0; i < 2000; i++) {
      const cur = getSqrtRatioAtTick(Math.floor((rand() - 0.5) * 200_000));
      const target = getSqrtRatioAtTick(Math.floor((rand() - 0.5) * 200_000));
      const liquidity = BigInt(Math.floor(rand() * 1e12)) * 10n ** BigInt(Math.floor(rand() * 15));
      const amount = BigInt(Math.floor(rand() * 1e12)) * 10n ** BigInt(Math.floor(rand() * 20));
      const fee = [0, 100, 500, 3000, 10000, 999_999][i % 6]!;
      const s = computeSwapStepExactIn(cur, target, liquidity, amount, fee);
      expect(s.amountIn + s.feeAmount <= amount).toBe(true);
      if (cur >= target) expect(s.sqrtPriceNextX96 >= target && s.sqrtPriceNextX96 <= cur).toBe(true);
      else expect(s.sqrtPriceNextX96 <= target && s.sqrtPriceNextX96 >= cur).toBe(true);
      if (s.sqrtPriceNextX96 !== target) expect(s.amountIn + s.feeAmount).toBe(amount);
    }
  });

  it("follows V4 for a 100% fee: everything is fee, nothing is swapped", () => {
    expect(computeSwapStepExactIn(Q96, Q96 / 2n, E18, 1000n, 1_000_000)).toEqual({
      sqrtPriceNextX96: Q96,
      amountIn: 0n,
      amountOut: 0n,
      feeAmount: 1000n,
    });
    expect(computeSwapStepExactIn(Q96, Q96 / 2n, 0n, 1000n, 1_000_000)).toEqual({
      sqrtPriceNextX96: Q96 / 2n,
      amountIn: 0n,
      amountOut: 0n,
      feeAmount: 0n,
    });
    expect(() => computeSwapStepExactIn(Q96, Q96 / 2n, E18, 1000n, 1_000_001)).toThrow();
    expect(() => computeSwapStepExactIn(Q96, Q96 / 2n, E18, -1n, 3000)).toThrow();
  });
});

describe("tick bitmap helpers", () => {
  it("compressTick floors toward negative infinity like TickBitmap", () => {
    expect(compressTick(0, 60)).toBe(0);
    expect(compressTick(59, 60)).toBe(0);
    expect(compressTick(60, 60)).toBe(1);
    expect(compressTick(-1, 60)).toBe(-1);
    expect(compressTick(-60, 60)).toBe(-1);
    expect(compressTick(-61, 60)).toBe(-2);
    expect(compressTick(-887272, 60)).toBe(-14788);
    expect(compressTick(-5, 1)).toBe(-5);
  });

  it("wordOf shifts the compressed tick arithmetically", () => {
    expect(wordOf(0, 1)).toBe(0);
    expect(wordOf(255, 1)).toBe(0);
    expect(wordOf(256, 1)).toBe(1);
    expect(wordOf(-1, 1)).toBe(-1);
    expect(wordOf(-256, 1)).toBe(-1);
    expect(wordOf(-257, 1)).toBe(-2);
    expect(wordOf(MIN_TICK, 1)).toBe(-3466);
    expect(wordOf(MAX_TICK, 1)).toBe(3465);
    expect(wordOf(-1, 60)).toBe(-1);
    expect(wordOf(60 * 256, 60)).toBe(1);
    expect(wordOf(60 * 256 - 1, 60)).toBe(0);
  });
});

describe("applyLiquidityDelta", () => {
  it("keeps ticks sorted, nets shared ticks and removes ticks whose gross hits zero", () => {
    const s = state();
    applyLiquidityDelta(s, -120, 120, 100n);
    applyLiquidityDelta(s, 120, 600, 100n);
    applyLiquidityDelta(s, -600, -120, 7n);
    expect(s.ticks).toEqual([
      { tick: -600, liquidityGross: 7n, liquidityNet: 7n },
      { tick: -120, liquidityGross: 107n, liquidityNet: 93n },
      { tick: 120, liquidityGross: 200n, liquidityNet: 0n },
      { tick: 600, liquidityGross: 100n, liquidityNet: -100n },
    ]);
    expect(s.liquidity).toBe(100n);

    applyLiquidityDelta(s, -120, 120, -100n);
    expect(s.ticks).toEqual([
      { tick: -600, liquidityGross: 7n, liquidityNet: 7n },
      { tick: -120, liquidityGross: 7n, liquidityNet: -7n },
      { tick: 120, liquidityGross: 100n, liquidityNet: 100n },
      { tick: 600, liquidityGross: 100n, liquidityNet: -100n },
    ]);
    expect(s.liquidity).toBe(0n);
    applyLiquidityDelta(s, -600, -120, -7n);
    applyLiquidityDelta(s, 120, 600, -100n);
    expect(s.ticks).toEqual([]);
  });

  it("counts in-range liquidity on [lower, upper) like the pool", () => {
    const s = state({ tick: 60 });
    applyLiquidityDelta(s, 60, 120, 5n); // lower == tick: in range
    applyLiquidityDelta(s, 0, 60, 3n); // upper == tick: out of range
    expect(s.liquidity).toBe(5n);
  });

  it("leaves ticks outside the known window alone but still tracks in-range liquidity", () => {
    const s = state({ wordLo: 0, wordHi: 0 });
    applyLiquidityDelta(s, -60, 60, 9n);
    expect(s.ticks).toEqual([{ tick: 60, liquidityGross: 9n, liquidityNet: -9n }]);
    expect(s.liquidity).toBe(9n);
  });

  it("rejects bad ranges and burning more than exists", () => {
    const s = state();
    expect(() => applyLiquidityDelta(s, 60, 60, 1n)).toThrow();
    expect(() => applyLiquidityDelta(s, 0, 30, 1n)).toThrow();
    expect(() => applyLiquidityDelta(s, 0, 60, -1n)).toThrow();
    applyLiquidityDelta(s, 0, 60, 0n);
    expect(s.ticks).toEqual([]);
  });
});

describe("quoteExactInput", () => {
  it("matches closed-form constant-product math within one range", () => {
    const rand = rng(9);
    for (let i = 0; i < 500; i++) {
      const tick = Math.floor((rand() - 0.5) * 100_000);
      const liquidity = 10n ** BigInt(15 + Math.floor(rand() * 10));
      const lo = Math.floor(tick / 60) * 60 - 60 * 3000;
      const s = poolWith([[lo, lo + 60 * 6000, liquidity]], { tick, sqrtPriceX96: getSqrtRatioAtTick(tick) + 12345n });
      const zeroForOne = rand() < 0.5;
      // Small enough to stay well inside the position.
      const amountIn = (liquidity * BigInt(1 + Math.floor(rand() * 1000))) / 100_000n;
      const q = quoteExactInput(s, zeroForOne, amountIn);
      const x = (amountIn * (1_000_000n - 3000n)) / 1_000_000n;
      const p = s.sqrtPriceX96;
      // Exact real-valued outputs, as rationals: out1 = L²·x / (L·Q96/√P · (L·Q96/√P + x)) etc.
      const [num, den] = zeroForOne
        ? [liquidity * p * x * p, Q96 * (liquidity * Q96 + x * p)]
        : [liquidity * Q96 * x * Q96, p * (liquidity * p + x * Q96)];
      const exact = num / den;
      expect(q.complete).toBe(true);
      expect(q.amountIn).toBe(amountIn);
      expect(q.ticksCrossed).toBe(0);
      // Rounding always favours the pool. Crossing an (uninitialized) word boundary splits the swap into
      // steps whose input/fee rounding can shift a few wei of input, i.e. a few wei times the price of output.
      const tolerance = 4n * (exact / x + 1n);
      expect(q.amountOut <= exact && exact - q.amountOut <= tolerance, `${q.amountOut} vs ${exact}`).toBe(true);
      expect(q.tick).toBe(getTickAtSqrtRatio(q.sqrtPriceX96));
    }
  });

  it("crosses initialized ticks, applying liquidityNet with the right sign", () => {
    const L = 10n ** 20n;
    const s = poolWith(
      [
        [-600, 600, L],
        [-60, 60, L],
        [60, 1200, 2n * L],
      ],
      { liquidity: 0n },
    );
    expect(s.liquidity).toBe(2n * L);
    const right = quoteExactInput(s, false, 10n ** 30n);
    // Every initialized tick to the right is crossed, then the price runs to the limit on zero liquidity.
    expect(right.ticksCrossed).toBe(3);
    expect(right.liquidity).toBe(0n);
    expect(right.sqrtPriceX96).toBe(MAX_SQRT_RATIO - 1n);
    expect(right.amountIn < 10n ** 30n).toBe(true);

    // Exactly enough input to reach tick 60 going right: the tick becomes 60 and liquidity includes [60, 1200).
    const toTick = getAmount1Delta(s.sqrtPriceX96, getSqrtRatioAtTick(60), 2n * L, true);
    const gross = toTick + mulDivRoundingUp(toTick, 3000n, 1_000_000n - 3000n);
    expect(quoteExactInput(s, false, gross)).toMatchObject({
      amountIn: gross,
      sqrtPriceX96: getSqrtRatioAtTick(60),
      tick: 60,
      liquidity: 3n * L,
      ticksCrossed: 1,
    });

    const left = quoteExactInput(s, true, 10n ** 30n);
    expect(left.ticksCrossed).toBe(2);
    expect(left.liquidity).toBe(0n);
    expect(left.sqrtPriceX96).toBe(MIN_SQRT_RATIO + 1n);
  });

  it("lands on tickNext - 1 when a zeroForOne swap ends exactly on a tick", () => {
    const L = 10n ** 20n;
    const s = poolWith([[-600, 600, L]], { tick: 100, sqrtPriceX96: getSqrtRatioAtTick(100) });
    // Exact input that takes the price to tick 0 (the bitmap word boundary) and no further.
    const net = getAmount0Delta(getSqrtRatioAtTick(0), s.sqrtPriceX96, L, true);
    const fee = mulDivRoundingUp(net, 3000n, 1_000_000n - 3000n);
    const q = quoteExactInput(s, true, net + fee);
    expect(q.sqrtPriceX96).toBe(Q96);
    expect(q.tick).toBe(-1);
    expect(q.amountIn).toBe(net + fee);
  });

  it("does not mutate the state and is deterministic", () => {
    const s = poolWith([[-600, 600, 10n ** 20n]]);
    const before = structuredClone(s);
    const a = quoteExactInput(s, true, 10n ** 18n);
    expect(s).toEqual(before);
    expect(quoteExactInput(s, true, 10n ** 18n)).toEqual(a);
  });

  it("quotes nothing for zero input or from the price limit", () => {
    const s = poolWith([[-600, 600, 10n ** 20n]]);
    expect(quoteExactInput(s, true, 0n)).toMatchObject({ amountIn: 0n, amountOut: 0n, complete: true });
    const atMin = { ...s, sqrtPriceX96: MIN_SQRT_RATIO + 1n, tick: MIN_TICK };
    expect(quoteExactInput(atMin, true, 10n)).toMatchObject({ amountIn: 0n, amountOut: 0n });
    expect(() => quoteExactInput(s, true, 1n << 255n)).toThrow();
  });

  it("stops at the edge of the known window and never quotes more than the full state", () => {
    const L = 10n ** 20n;
    const full = poolWith(
      [
        [-60 * 2000, 60 * 2000, L],
        [-60 * 300, -60 * 200, L],
        [60 * 200, 60 * 300, L],
      ],
      { tickSpacing: 60 },
    );
    const windowed: ClState = { ...full, wordLo: -1, wordHi: 0 };
    for (const zeroForOne of [true, false]) {
      const f = quoteExactInput(full, zeroForOne, 10n ** 22n);
      const w = quoteExactInput(windowed, zeroForOne, 10n ** 22n);
      expect(f.complete).toBe(true);
      expect(w.complete).toBe(false);
      expect(w.amountOut < f.amountOut && w.amountIn < f.amountIn).toBe(true);
      // Stopped exactly on the window's last tick (compressed -256 going left, 255 going right).
      expect(w.sqrtPriceX96).toBe(getSqrtRatioAtTick(zeroForOne ? -60 * 256 : 60 * 255));
      // A small swap that stays inside the window is complete and identical.
      expect(quoteExactInput(windowed, zeroForOne, 10n ** 15n)).toEqual(quoteExactInput(full, zeroForOne, 10n ** 15n));
    }
  });
});
