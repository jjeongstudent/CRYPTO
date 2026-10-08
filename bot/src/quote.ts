import { Q96, quoteExactInput } from "./clmath.js";
import { type HopReserves, type Trade, bestTrade, getAmountOut, optimalAmountIn, routeCurve } from "./math.js";
import type { ClPool, Hop } from "./types.js";

const PIPS = 1_000_000;
const Q96_FLOAT = 2 ** 96;
/** Golden-section ratio as a fraction of 2^32, for integer bisection of bigint ranges. */
const PHI_NUM = 2_654_435_769n; // (sqrt(5) - 1) / 2 · 2^32
const PHI_SHIFT = 32n;

/** Fee in pips the pool charges for a swap in this direction (V4 protocol fees are per direction). */
export function clSwapFee(pool: ClPool, zeroForOne: boolean): number {
  const v4 = pool.v4;
  if (!v4 || v4.protocolFee === 0) return pool.state.fee;
  const protocol = zeroForOne ? v4.protocolFee & 0xfff : v4.protocolFee >> 12;
  if (protocol === 0) return v4.lpFee;
  // ProtocolFeeLibrary.calculateSwapFee: protocolFee + lpFee - protocolFee·lpFee / 1e6
  return protocol + v4.lpFee - Math.floor((protocol * v4.lpFee) / PIPS);
}

/** Exact output of one hop for `amountIn`, matching the on-chain pool. Partial fills count only what fills. */
export function hopQuote(hop: Hop, amountIn: bigint): bigint {
  const pool = hop.pool;
  if (pool.family === "cp") {
    return hop.zeroForOne
      ? getAmountOut(amountIn, pool.reserve0, pool.reserve1, pool.feeBps)
      : getAmountOut(amountIn, pool.reserve1, pool.reserve0, pool.feeBps);
  }
  if (amountIn <= 0n) return 0n;
  const fee = clSwapFee(pool, hop.zeroForOne);
  const state = fee === pool.state.fee ? pool.state : { ...pool.state, fee };
  return quoteExactInput(state, hop.zeroForOne, amountIn).amountOut;
}

export function routeQuote(hops: readonly Hop[], amountIn: bigint): bigint {
  let amount = amountIn;
  for (const hop of hops) {
    amount = hopQuote(hop, amount);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/** Output per unit of input for an infinitesimal trade, fee included (float; used only as a filter). */
export function marginalRate(hop: Hop): number {
  const pool = hop.pool;
  if (pool.family === "cp") {
    const [rIn, rOut] = hop.zeroForOne ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0];
    if (rIn === 0n || rOut === 0n) return 0;
    return ((1 - pool.feeBps / 10_000) * Number(rOut)) / Number(rIn);
  }
  if (pool.state.liquidity === 0n) return 0;
  const sqrtP = Number(pool.state.sqrtPriceX96) / Q96_FLOAT;
  const price = sqrtP * sqrtP; // token1 per token0
  const keep = 1 - clSwapFee(pool, hop.zeroForOne) / PIPS;
  return hop.zeroForOne ? price * keep : keep / price;
}

export function routeMarginalRate(hops: readonly Hop[]): number {
  let rate = 1;
  for (const hop of hops) rate *= marginalRate(hop);
  return rate;
}

function asReserves(hop: Hop): HopReserves | undefined {
  const pool = hop.pool;
  if (pool.family !== "cp") return undefined;
  return hop.zeroForOne
    ? { reserveIn: pool.reserve0, reserveOut: pool.reserve1, feeBps: pool.feeBps }
    : { reserveIn: pool.reserve1, reserveOut: pool.reserve0, feeBps: pool.feeBps };
}

/**
 * Treats each concentrated pool as the constant-product pool it behaves like inside its current
 * tick range (virtual reserves L/√P and L·√P). Exact while no tick is crossed; a seed otherwise.
 */
function virtualReserves(hop: Hop): HopReserves | undefined {
  const pool = hop.pool;
  if (pool.family === "cp") return asReserves(hop);
  const { liquidity, sqrtPriceX96 } = pool.state;
  if (liquidity === 0n || sqrtPriceX96 === 0n) return undefined;
  const reserve0 = (liquidity * Q96) / sqrtPriceX96;
  const reserve1 = (liquidity * sqrtPriceX96) / Q96;
  if (reserve0 === 0n || reserve1 === 0n) return undefined;
  const feeBps = Math.ceil(clSwapFee(pool, hop.zeroForOne) / 100);
  return hop.zeroForOne ? { reserveIn: reserve0, reserveOut: reserve1, feeBps } : { reserveIn: reserve1, reserveOut: reserve0, feeBps };
}

/**
 * Profit-maximising trade for a route given at most `maxIn` of capital, or null if none.
 * Constant-product-only routes use the exact closed form. Anything with a concentrated hop is
 * maximised numerically: profit(x) = out(x) - x is concave (every hop's output is concave in its
 * input), so a golden-section search on the exact quote converges to the optimum.
 */
export function bestRouteTrade(hops: readonly Hop[], maxIn: bigint): Trade | null {
  if (maxIn <= 0n) return null;
  const reserves = hops.map(asReserves);
  if (reserves.every((r) => r !== undefined)) return bestTrade(reserves as HopReserves[], maxIn);
  if (!(routeMarginalRate(hops) > 1)) return null;

  // Seed the search window from the virtual-reserve optimum (exact while no tick is crossed), then
  // widen it while profit is still rising at the edge, e.g. when crossing into deeper liquidity.
  let hi = maxIn;
  const virtual = hops.map(virtualReserves);
  if (virtual.every((r) => r !== undefined)) {
    const seed = optimalAmountIn(routeCurve(virtual as HopReserves[]));
    if (seed > 0n && seed * 4n < hi) {
      hi = seed * 4n;
      const profit = (x: bigint) => routeQuote(hops, x) - x;
      while (hi < maxIn && profit(hi) > profit(hi - hi / 64n)) hi = hi * 4n < maxIn ? hi * 4n : maxIn;
    }
  }
  return goldenSection(hops, hi);
}

function goldenSection(hops: readonly Hop[], hi: bigint): Trade | null {
  const profit = (x: bigint) => routeQuote(hops, x) - x;
  let lo = 0n;
  let a = hi - (((hi - lo) * PHI_NUM) >> PHI_SHIFT);
  let b = lo + (((hi - lo) * PHI_NUM) >> PHI_SHIFT);
  let fa = profit(a);
  let fb = profit(b);
  for (let i = 0; i < 96 && hi - lo > 2n && hi - lo > lo / 1_000_000n; i++) {
    if (fa < fb) {
      lo = a;
      a = b;
      fa = fb;
      b = lo + (((hi - lo) * PHI_NUM) >> PHI_SHIFT);
      if (b <= a) b = a + 1n;
      fb = profit(b);
    } else {
      hi = b;
      b = a;
      fb = fa;
      a = hi - (((hi - lo) * PHI_NUM) >> PHI_SHIFT);
      if (a >= b) a = b - 1n;
      fa = profit(a);
    }
  }
  const [amountIn, best] = fa >= fb ? [a, fa] : [b, fb];
  if (best <= 0n || amountIn <= 0n) return null;
  return { amountIn, amountOut: amountIn + best, profit: best };
}
