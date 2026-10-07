export const FEE_DENOMINATOR = 10_000n;

export interface HopReserves {
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
}

/** Constant-product output with fee, bit-for-bit identical to Executor._swap. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (FEE_DENOMINATOR - BigInt(feeBps));
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}

export function quoteRoute(amountIn: bigint, hops: readonly HopReserves[]): bigint {
  let amount = amountIn;
  for (const hop of hops) {
    amount = getAmountOut(amount, hop.reserveIn, hop.reserveOut, hop.feeBps);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/**
 * A chain of constant-product swaps is itself a Möbius map out(x) = n·x / (d + c·x).
 * Composing hops this way gives the whole route as one "virtual pool", which has a
 * closed-form profit-maximising input.
 */
export interface Curve {
  n: bigint;
  d: bigint;
  c: bigint;
}

export function hopCurve(hop: HopReserves): Curve {
  const gamma = FEE_DENOMINATOR - BigInt(hop.feeBps);
  return { n: gamma * hop.reserveOut, d: FEE_DENOMINATOR * hop.reserveIn, c: gamma };
}

/** Curve for "apply a, then b". */
export function composeCurves(a: Curve, b: Curve): Curve {
  return { n: a.n * b.n, d: a.d * b.d, c: b.d * a.c + b.c * a.n };
}

export function routeCurve(hops: readonly HopReserves[]): Curve {
  if (hops.length === 0) throw new Error("empty route");
  return hops.map(hopCurve).reduce(composeCurves);
}

export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("isqrt of negative");
  if (value < 2n) return value;
  // Newton's method from a seed that is guaranteed >= sqrt(value); decreases monotonically to floor(sqrt).
  let x = 1n << (BigInt(value.toString(2).length) / 2n + 1n);
  for (;;) {
    const y = (x + value / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * Input maximising out(x) - x. Setting the derivative n·d / (d + c·x)² to 1 gives
 * x* = (sqrt(n·d) - d) / c. Returns 0 when the route is not profitable at the margin (n <= d).
 */
export function optimalAmountIn(curve: Curve): bigint {
  if (curve.n <= curve.d) return 0n;
  const x = (isqrt(curve.n * curve.d) - curve.d) / curve.c;
  return x > 0n ? x : 0n;
}

export interface Trade {
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
}

/** Best trade for a route given at most `maxIn` of capital, or null if nothing profitable exists. */
export function bestTrade(hops: readonly HopReserves[], maxIn: bigint): Trade | null {
  if (maxIn <= 0n) return null;
  for (const hop of hops) if (hop.reserveIn <= 0n || hop.reserveOut <= 0n) return null;
  let amountIn = optimalAmountIn(routeCurve(hops));
  if (amountIn === 0n) return null;
  // Profit is concave in the input, so the capped optimum is simply min(x*, cap).
  if (amountIn > maxIn) amountIn = maxIn;
  const amountOut = quoteRoute(amountIn, hops);
  const profit = amountOut - amountIn;
  return profit > 0n ? { amountIn, amountOut, profit } : null;
}
