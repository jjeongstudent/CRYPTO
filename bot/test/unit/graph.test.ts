import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { CycleIndex, cycleTokens, findCycles } from "../../src/cycles.js";
import { encodeHop, planCosts } from "../../src/engine.js";
import { evaluateCycle, findOpportunities, selectNonOverlapping } from "../../src/strategy.js";
import type { CpPool, Pool } from "../../src/types.js";

const E18 = 10n ** 18n;
const W = "0x00000000000000000000000000000000000000a1" as Address;
const A = "0x00000000000000000000000000000000000000b2" as Address;
const B = "0x00000000000000000000000000000000000000c3" as Address;

function pool(n: number, token0: Address, token1: Address, reserve0: bigint, reserve1: bigint, feeBps = 30): CpPool {
  return {
    family: "cp",
    id: `0x${n.toString(16).padStart(40, "0")}` as Hex,
    dex: `dex${n}`,
    kind: "v2",
    token0,
    token1,
    feeBps,
    reserve0,
    reserve1,
  };
}

describe("findCycles", () => {
  const wa1 = pool(1, W, A, 100n * E18, 300_000n * E18);
  const wa2 = pool(2, W, A, 100n * E18, 270_000n * E18, 25);
  const ab = pool(3, A, B, 300_000n * E18, 300_000n * E18);
  const bw = pool(4, B, W, 300_000n * E18, 100n * E18);
  const pools = [wa1, wa2, ab, bw];

  it("finds both directions of the 2-hop loop", () => {
    const cycles = findCycles(pools, W, 2);
    expect(cycles).toHaveLength(2);
    for (const c of cycles) {
      expect(c.hops).toHaveLength(2);
      expect(new Set(c.hops.map((h) => h.pool.id)).size).toBe(2);
    }
  });

  it("adds triangles at 3 hops, never reusing a pool or token", () => {
    const cycles = findCycles(pools, W, 3);
    // 2 two-hop + (W-A-B-W via wa1/wa2) + (W-B-A-W via wa1/wa2)
    expect(cycles).toHaveLength(6);
    for (const c of cycles) {
      expect(cycleTokens(c)[0]).toBe(W);
      expect(new Set(c.hops.map((h) => h.pool.id)).size).toBe(c.hops.length);
      expect(new Set(cycleTokens(c)).size).toBe(c.hops.length);
      // Each hop's output token is the next hop's input token, ending back at W.
      for (let i = 0; i < c.hops.length; i++) {
        const h = c.hops[i]!;
        const out = h.zeroForOne ? h.pool.token1 : h.pool.token0;
        const next = c.hops[(i + 1) % c.hops.length]!;
        expect(out).toBe(next.zeroForOne ? next.pool.token0 : next.pool.token1);
      }
    }
  });

  it("indexes cycles by pool", () => {
    const index = new CycleIndex(findCycles(pools, W, 3));
    expect(index.affectedBy([ab.id])).toHaveLength(4);
    expect(index.affectedBy([wa2.id])).toHaveLength(4);
    expect(index.affectedBy([])).toHaveLength(0);
  });

  it("evaluates the mispriced loop as profitable in exactly one direction", () => {
    const cycles = findCycles([wa1, wa2], W, 2);
    const results = cycles.map((c) => evaluateCycle(c, 50n * E18));
    expect(results.filter(Boolean)).toHaveLength(1);
    const opp = results.find(Boolean)!;
    // Sell W where it is dear (wa1: 3000 A per W), buy it back where it is cheap (wa2: 2700).
    expect(opp.cycle.hops[0]!.pool.id).toBe(wa1.id);
    expect(opp.grossProfit > 0n).toBe(true);
  });
});

describe("selectNonOverlapping", () => {
  it("never picks two opportunities that share a pool", () => {
    const wa1 = pool(1, W, A, 100n * E18, 300_000n * E18);
    const wa2 = pool(2, W, A, 100n * E18, 270_000n * E18);
    const wa3 = pool(3, W, A, 100n * E18, 280_000n * E18);
    const opps = findOpportunities(findCycles([wa1, wa2, wa3], W, 2), 50n * E18, 0n);
    expect(opps.length).toBeGreaterThan(1);
    const chosen = selectNonOverlapping(opps, 10);
    const used = chosen.flatMap((o) => o.cycle.hops.map((h) => h.pool.id));
    expect(new Set(used).size).toBe(used.length);
    expect(chosen[0]).toBe(opps[0]);
    expect(selectNonOverlapping(opps, 10, new Set([wa1.id, wa2.id, wa3.id]))).toHaveLength(0);
  });
});

describe("encodeHop", () => {
  it("builds the Executor.Hop struct for constant-product pools", () => {
    const p = pool(0xabcdef, W, A, 1n, 1n, 25);
    expect(encodeHop({ pool: p, zeroForOne: true })).toEqual({
      kind: 0,
      pool: p.id,
      tokenIn: W,
      tokenOut: A,
      fee: 25,
      tickSpacing: 0,
      zeroForOne: true,
      flags: 0,
    });
    const back = encodeHop({ pool: p, zeroForOne: false });
    expect([back.tokenIn, back.tokenOut, back.zeroForOne]).toEqual([A, W, false]);
  });

  it("encodes V4 hops with the pool key and native-ETH flags", () => {
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;
    const hooks = "0x00000000000000000000000000000000000000ff" as Address;
    const v4: Pool = {
      family: "cl",
      id: `0x${"11".repeat(32)}` as Hex,
      dex: "uniswap-v4",
      kind: "v4",
      token0: W, // native ETH, routed as WETH
      token1: A,
      state: { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 1n, tickSpacing: 60, fee: 3000, ticks: [], wordLo: 0, wordHi: 0 },
      v4: { currency0: ZERO, currency1: A, fee: 3000, tickSpacing: 60, hooks, protocolFee: 0, lpFee: 3000 },
    };
    expect(encodeHop({ pool: v4, zeroForOne: true })).toMatchObject({ kind: 2, pool: hooks, tokenIn: W, tokenOut: A, fee: 3000, tickSpacing: 60, flags: 1 });
    expect(encodeHop({ pool: v4, zeroForOne: false })).toMatchObject({ tokenIn: A, tokenOut: W, zeroForOne: false, flags: 2 });
  });

  it("encodes V3-style hops by pool address only", () => {
    const v3: Pool = {
      family: "cl",
      id: "0x00000000000000000000000000000000000000c3" as Hex,
      dex: "uniswap-v3",
      kind: "v3",
      token0: A,
      token1: B,
      state: { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 1n, tickSpacing: 60, fee: 3000, ticks: [], wordLo: 0, wordHi: 0 },
    };
    expect(encodeHop({ pool: v3, zeroForOne: false })).toEqual({
      kind: 1,
      pool: v3.id,
      tokenIn: B,
      tokenOut: A,
      fee: 0,
      tickSpacing: 0,
      zeroForOne: false,
      flags: 0,
    });
  });
});

describe("planCosts", () => {
  it("bids the configured share of the post-cost surplus and accounts for every cost", () => {
    const gross = 10n ** 15n; // 0.001 ETH
    const gas = 200_000n;
    const baseFee = 10_000_000n; // 0.01 gwei
    const l1Fee = 5n * 10n ** 11n;
    const c = planCosts(gross, gas, baseFee, l1Fee, 3_000);
    expect(c.l2Cost).toBe(gas * baseFee);
    expect(c.gasLimit).toBe(250_000n);
    const surplus = gross - c.l2Cost - l1Fee;
    // Bid is ~30% of surplus (rounded down per gas unit, and paid only on gas actually used).
    expect(c.bid <= (surplus * 3_000n) / 10_000n).toBe(true);
    expect(c.bid > (surplus * 2_300n) / 10_000n).toBe(true);
    expect(c.totalCost).toBe(c.l2Cost + l1Fee + c.bid);
    expect(c.net).toBe(gross - c.totalCost);
    expect(c.maxFeePerGas).toBe(baseFee * 2n + c.priorityFeePerGas);
  });

  it("bids nothing when costs exceed profit", () => {
    const c = planCosts(1_000n, 200_000n, 10n ** 9n, 0n, 3_000);
    expect(c.bid).toBe(0n);
    expect(c.net < 0n).toBe(true);
  });
});
