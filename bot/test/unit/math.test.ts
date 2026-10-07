import { describe, expect, it } from "vitest";
import { type HopReserves, bestTrade, getAmountOut, isqrt, optimalAmountIn, quoteRoute, routeCurve } from "../../src/math.js";

const E18 = 10n ** 18n;

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomBig(rand: () => number, minExp: number, maxExp: number): bigint {
  const exp = minExp + Math.floor(rand() * (maxExp - minExp));
  const mantissa = BigInt(Math.floor(1 + rand() * 9_999_999));
  return mantissa * 10n ** BigInt(Math.max(exp - 7, 0));
}

/** Integer ternary search over the exact (floored) quote; the brute-force reference. */
function bruteForceBest(hops: HopReserves[], cap: bigint): bigint {
  let lo = 1n;
  let hi = cap;
  const profit = (x: bigint) => quoteRoute(x, hops) - x;
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

describe("getAmountOut", () => {
  it("matches Uniswap V2's 997/1000 formula at 30 bps", () => {
    const amountIn = 3n * E18;
    const reserveIn = 100n * E18;
    const reserveOut = 300_000n * E18;
    const uniswap = (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);
    expect(getAmountOut(amountIn, reserveIn, reserveOut, 30)).toBe(uniswap);
  });

  it("returns zero for empty input or pools", () => {
    expect(getAmountOut(0n, 1n, 1n, 30)).toBe(0n);
    expect(getAmountOut(1n, 0n, 1n, 30)).toBe(0n);
    expect(getAmountOut(1n, 1n, 0n, 30)).toBe(0n);
  });
});

describe("isqrt", () => {
  it("is exact for small and enormous values", () => {
    const rand = rng(7);
    const samples = [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 2n ** 64n, 2n ** 600n + 12345n];
    for (let i = 0; i < 300; i++) samples.push(randomBig(rand, 1, 250));
    for (const v of samples) {
      const r = isqrt(v);
      expect(r * r <= v).toBe(true);
      expect((r + 1n) * (r + 1n) > v).toBe(true);
    }
  });
});

describe("route curve composition", () => {
  it("equals applying each hop in sequence (exact rational arithmetic)", () => {
    const rand = rng(11);
    for (let trial = 0; trial < 200; trial++) {
      const hops: HopReserves[] = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => ({
        reserveIn: randomBig(rand, 15, 30),
        reserveOut: randomBig(rand, 15, 30),
        feeBps: Math.floor(rand() * 100),
      }));
      const x = randomBig(rand, 10, 22);
      // Sequential, as a fraction num/den.
      let num = x;
      let den = 1n;
      for (const h of hops) {
        const g = 10_000n - BigInt(h.feeBps);
        // out = g·rOut·(num/den) / (10000·rIn + g·(num/den))
        const newNum = g * h.reserveOut * num;
        const newDen = 10_000n * h.reserveIn * den + g * num;
        num = newNum;
        den = newDen;
      }
      const c = routeCurve(hops);
      // c.n·x / (c.d + c.c·x) == num/den
      expect(c.n * x * den).toBe(num * (c.d + c.c * x));
    }
  });
});

describe("bestTrade", () => {
  it("finds the profit-maximising input (vs brute force) on random mispriced routes", () => {
    const rand = rng(42);
    let profitable = 0;
    for (let trial = 0; trial < 150; trial++) {
      const nHops = 2 + Math.floor(rand() * 2);
      const hops: HopReserves[] = [];
      // Build a cycle of prices that multiplies to (1 + skew), so some routes are profitable.
      const skew = 0.9 + rand() * 0.25;
      for (let i = 0; i < nHops; i++) {
        const reserveIn = randomBig(rand, 19, 24);
        const price = i === 0 ? skew : 1;
        hops.push({
          reserveIn,
          reserveOut: (reserveIn * BigInt(Math.round(price * 1e6))) / 1_000_000n,
          feeBps: [5, 25, 30][Math.floor(rand() * 3)]!,
        });
      }
      const cap = randomBig(rand, 18, 23);
      const trade = bestTrade(hops, cap);
      const brute = bruteForceBest(hops, cap);
      if (brute <= 0n) {
        expect(trade).toBeNull();
        continue;
      }
      profitable++;
      expect(trade).not.toBeNull();
      // Integer flooring makes the true optimum differ by dust at most.
      const tolerance = brute / 1_000_000n + 10n;
      expect(trade!.profit >= brute - tolerance).toBe(true);
      expect(trade!.amountIn <= cap).toBe(true);
      expect(trade!.amountOut).toBe(quoteRoute(trade!.amountIn, hops));
    }
    expect(profitable).toBeGreaterThan(20);
  });

  it("returns null for a fairly priced route (fees make it a loss)", () => {
    const hops: HopReserves[] = [
      { reserveIn: 100n * E18, reserveOut: 300_000n * E18, feeBps: 30 },
      { reserveIn: 300_000n * E18, reserveOut: 100n * E18, feeBps: 25 },
    ];
    expect(optimalAmountIn(routeCurve(hops))).toBe(0n);
    expect(bestTrade(hops, 10n * E18)).toBeNull();
  });

  it("caps the input at available capital", () => {
    const hops: HopReserves[] = [
      { reserveIn: 100n * E18, reserveOut: 300_000n * E18, feeBps: 30 },
      { reserveIn: 270_000n * E18, reserveOut: 100n * E18, feeBps: 25 },
    ];
    const unconstrained = bestTrade(hops, 1_000n * E18)!;
    expect(unconstrained.amountIn > E18).toBe(true);
    const capped = bestTrade(hops, E18)!;
    expect(capped.amountIn).toBe(E18);
    expect(capped.profit < unconstrained.profit).toBe(true);
  });
});
