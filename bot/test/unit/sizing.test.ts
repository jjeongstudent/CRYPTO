import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { type ClState, type TickInfo, getSqrtRatioAtTick, wordOf } from "../../src/clmath.js";
import { findCycles } from "../../src/cycles.js";
import { bestRouteTrade, routeMarginalRate, routeQuote } from "../../src/quote.js";
import { findOpportunities } from "../../src/strategy.js";
import type { ClPool, CpPool, Hop } from "../../src/types.js";

const E18 = 10n ** 18n;
const W = "0x00000000000000000000000000000000000000a1" as Address;
const A = "0x00000000000000000000000000000000000000b2" as Address;

function cp(reserve0: bigint, reserve1: bigint): CpPool {
  return { family: "cp", id: "0x00000000000000000000000000000000000000c2", dex: "v2", kind: "v2", token0: W, token1: A, feeBps: 30, reserve0, reserve1 };
}

/** A V3 pool at `tick` built from positions [lower, upper, liquidity], fully known (whole tick range). */
function cl(tick: number, positions: [number, number, bigint][], spacing = 60, fee = 3000): ClPool {
  const map = new Map<number, TickInfo>();
  let liquidity = 0n;
  for (const [lower, upper, l] of positions) {
    for (const [t, net] of [
      [lower, l],
      [upper, -l],
    ] as const) {
      const info = map.get(t) ?? { tick: t, liquidityGross: 0n, liquidityNet: 0n };
      info.liquidityGross += l;
      info.liquidityNet += net;
      map.set(t, info);
    }
    if (lower <= tick && tick < upper) liquidity += l;
  }
  const state: ClState = {
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tick,
    liquidity,
    tickSpacing: spacing,
    fee,
    ticks: [...map.values()].sort((a, b) => a.tick - b.tick),
    wordLo: wordOf(-887_272, spacing),
    wordHi: wordOf(887_272, spacing),
  };
  return { family: "cl", id: "0x00000000000000000000000000000000000000c1", dex: "v3", kind: "v3", token0: W, token1: A, state };
}

/** Coarse grid plus local refinement over the exact quote: the reference optimum. */
function bruteForce(hops: Hop[], cap: bigint, steps = 2_000): bigint {
  const profit = (x: bigint) => routeQuote(hops, x) - x;
  let bestX = 0n;
  let best = 0n;
  for (let i = 1n; i <= BigInt(steps); i++) {
    const x = (cap * i) / BigInt(steps);
    const p = profit(x);
    if (p > best) [best, bestX] = [p, x];
  }
  for (let step = cap / BigInt(steps); step > 0n; step /= 2n) {
    for (const x of [bestX - step, bestX + step]) {
      if (x <= 0n || x > cap) continue;
      const p = profit(x);
      if (p > best) [best, bestX] = [p, x];
    }
  }
  return best;
}

/**
 * Within a millionth of the reference. The search stops at 1e-6 relative precision in the input; when
 * the optimum sits on a kink (the trade exactly uses up a liquidity range) that costs up to the same
 * order of profit, e.g. ~4e-10 ETH on a 0.002 ETH trade.
 */
function nearOptimal(profit: bigint, reference: bigint): boolean {
  return profit >= reference - reference / 1_000_000n;
}

/** The cycle that sells W on the V2 pair first. */
function v2First(v2: CpPool, v3: ClPool): Hop[] {
  return findCycles([v2, v3], W, 2).find((c) => c.hops[0]!.pool === v2)!.hops;
}

describe("sizing routes through thin or empty liquidity", () => {
  it("finds the trade when the pool's current price sits in a zero-liquidity gap", () => {
    // No liquidity at the current tick; deep liquidity starts 600 ticks (~6%) higher. V2 is 15% off.
    const v3 = cl(0, [[600, 6_000, 10n ** 21n]]);
    const v2 = cp(100n * E18, 115n * E18);
    const brute = bruteForce(v2First(v2, v3), 20n * E18);
    expect(brute > E18 / 10n).toBe(true);
    const opps = findOpportunities(findCycles([v2, v3], W, 2), 20n * E18, 0n);
    expect(opps).toHaveLength(1);
    expect(nearOptimal(opps[0]!.grossProfit, brute)).toBe(true);
  });

  it("is not misled by dust liquidity in the current range", () => {
    for (const dust of [10n ** 3n, 10n ** 6n, 10n ** 9n, 10n ** 12n, 10n ** 15n]) {
      const v3 = cl(0, [
        [600, 6_000, 10n ** 21n],
        [-6_000, 600, dust],
      ]);
      const hops = v2First(cp(100n * E18, 115n * E18), v3);
      const trade = bestRouteTrade(hops, 20n * E18);
      expect(trade, `dust ${dust}`).not.toBeNull();
      expect(nearOptimal(trade!.profit, bruteForce(hops, 20n * E18)), `dust ${dust}`).toBe(true);
    }
  });

  it("is not misled by dust liquidity on a 6-decimal pair (tiny integer virtual reserves)", () => {
    // ~3000 USDC per WETH: raw price ~3e-9, tick ~ -195,000.
    const t = -195_000;
    for (const dust of [10n ** 3n, 10n ** 6n, 10n ** 9n]) {
      const v3 = cl(t, [
        [t + 600, t + 6_000, 10n ** 16n],
        [t - 6_000, t + 600, dust],
      ]);
      const reserve1 = BigInt(Math.round(1.0001 ** (t + 600) * 1.15 * 100 * 1e18));
      const hops = v2First(cp(100n * E18, reserve1), v3);
      const trade = bestRouteTrade(hops, 20n * E18);
      expect(trade, `dust ${dust}`).not.toBeNull();
      expect(nearOptimal(trade!.profit, bruteForce(hops, 20n * E18)), `dust ${dust}`).toBe(true);
    }
  });

  it("never filters out a profitable route and always reaches the optimum (random layouts with gaps)", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let profitable = 0;
    for (let trial = 0; trial < 60; trial++) {
      const tick = Math.round((rand() - 0.5) * 2_000) * 60;
      const positions: [number, number, bigint][] = [];
      for (let i = 0, n = 1 + Math.floor(rand() * 5); i < n; i++) {
        // Ranges anywhere near the price, often not covering it (gaps), liquidity across 9 orders of magnitude.
        const lower = tick + Math.round((rand() - 0.6) * 100) * 60;
        const upper = lower + (1 + Math.round(rand() * 80)) * 60;
        positions.push([lower, upper, 10n ** BigInt(12 + Math.floor(rand() * 10))]);
      }
      const v3 = cl(tick, positions);
      const skew = 0.85 + rand() * 0.35;
      const v2 = cp(100n * E18, BigInt(Math.round(1.0001 ** tick * skew * 100 * 1e6)) * 10n ** 12n);
      for (const cycle of findCycles([v2, v3], W, 2)) {
        const brute = bruteForce(cycle.hops, 20n * E18, 400);
        const passes = routeMarginalRate(cycle.hops) > 1;
        if (brute > 10n ** 9n) {
          profitable++;
          expect(passes, `trial ${trial}: filter rejected a route worth ${brute}`).toBe(true);
          const trade = bestRouteTrade(cycle.hops, 20n * E18)!;
          expect(trade, `trial ${trial}`).not.toBeNull();
          expect(nearOptimal(trade.profit, brute), `trial ${trial}: ${trade.profit} vs ${brute}`).toBe(true);
          expect(trade.amountOut).toBe(routeQuote(cycle.hops, trade.amountIn));
        }
      }
    }
    expect(profitable).toBeGreaterThan(10);
  });

  it("skips and reports a route whose quote throws (inconsistent local state) without aborting the scan", () => {
    const healthy = cl(0, [[-6_000, 6_000, 10n ** 21n]]);
    // A narrow range the arbitrage crosses, whose upper tick contradicts the active liquidity:
    // crossing it upwards would take liquidity negative (the real pool could never be in this state).
    const broken = cl(0, [
      [-60, 60, 10n ** 21n],
      [-6_000, 6_000, 10n ** 18n],
    ]);
    broken.id = "0x00000000000000000000000000000000000000c3";
    broken.state.ticks.find((t) => t.tick === 60)!.liquidityNet = -(10n ** 30n);
    const v2 = cp(100n * E18, 115n * E18);
    const reported: string[] = [];
    const opps = findOpportunities(findCycles([v2, healthy, broken], W, 2), 1_000n * E18, 0n, undefined, (cycle) =>
      reported.push(cycle.hops.map((h) => h.pool.id).join(">")),
    );
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every((r) => r.includes(broken.id))).toBe(true);
    expect(opps.some((o) => o.cycle.hops.some((h) => h.pool === healthy))).toBe(true);
  });
});
