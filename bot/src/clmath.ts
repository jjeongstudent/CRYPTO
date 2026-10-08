/**
 * Concentrated-liquidity (Uniswap V3 / V4) swap math, ported bit-for-bit from the Solidity sources:
 * v3-core TickMath, SqrtPriceMath, SwapMath, FullMath, UnsafeMath, TickBitmap, LiquidityMath and
 * UniswapV3Pool.swap (identical in result to v4-core's libraries and Pool.swap for exact input).
 *
 * Everything is bigint except ticks. Wherever Solidity would revert this throws, and wherever it wraps
 * (unchecked uint256 / uint160 arithmetic) this masks, so every branch matches the on-chain code.
 * Parity with the real contracts is checked in test/parity/clmath-parity.test.ts.
 */

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_INT256 = (1n << 255n) - 1n;
const PIPS = 1_000_000n;

function revert(what: string): never {
  throw new Error(`clmath: ${what}`);
}

// ---------------------------------------------------------------------------------------------------
// FullMath / UnsafeMath

/** floor(a·b / denominator) with a 512-bit intermediate; reverts if denominator is 0 or the result overflows uint256. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) revert("mulDiv by zero");
  const result = (a * b) / denominator;
  if (result > MAX_UINT256) revert("mulDiv overflow");
  return result;
}

/** ceil(a·b / denominator); reverts like FullMath.mulDivRoundingUp. */
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  let result = mulDiv(a, b, denominator);
  if ((a * b) % denominator > 0n) {
    if (result === MAX_UINT256) revert("mulDivRoundingUp overflow");
    result++;
  }
  return result;
}

/** UnsafeMath.divRoundingUp (callers guarantee y > 0). */
function divRoundingUp(x: bigint, y: bigint): bigint {
  return x / y + (x % y > 0n ? 1n : 0n);
}

// ---------------------------------------------------------------------------------------------------
// TickMath

// [bit of |tick|, Q128.128 factor] exactly as in TickMath.getSqrtRatioAtTick.
const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) · 2^96, rounded up exactly like TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) revert(`tick ${tick} out of range`);
  const absTick = Math.abs(tick);
  let ratio = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of TICK_FACTORS) if (absTick & bit) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 -> Q64.96, rounding up so getTickAtSqrtRatio of the result is consistent.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Greatest tick whose sqrt ratio is <= sqrtPriceX96 (TickMath.getTickAtSqrtRatio, same log2 approximation). */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) revert("sqrt price out of range");
  const ratio = sqrtPriceX96 << 32n;
  const msb = BigInt(ratio.toString(2).length - 1);
  let r = msb >= 128n ? ratio >> (msb - 127n) : ratio << (127n - msb);
  let log2 = (msb - 128n) << 64n;
  // 14 rounds of squaring give the fractional bits 63..50 of log2. BigInt bit ops are two's complement,
  // so OR-ing into a negative log2 behaves like the EVM's 256-bit `or`.
  for (let bit = 63n; bit >= 50n; bit--) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log2 |= f << bit;
    r >>= f;
  }
  const logSqrt10001 = log2 * 255738958999603826347141n; // Q128.128
  // BigInt >> floors, like Solidity's arithmetic shift on int256.
  const tickLow = Number((logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHi = Number((logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n);
  return tickLow === tickHi ? tickLow : getSqrtRatioAtTick(tickHi) <= sqrtPriceX96 ? tickHi : tickLow;
}

// ---------------------------------------------------------------------------------------------------
// SqrtPriceMath

/** liquidity · (1/sqrtLower - 1/sqrtUpper): token0 between two prices (order-insensitive). */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) revert("zero sqrt price");
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

/** liquidity · (sqrtUpper - sqrtLower): token1 between two prices (order-insensitive). */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivRoundingUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

/** getNextSqrtPriceFromAmount0RoundingUp with add = true. */
function nextSqrtPriceFromAmount0In(sqrtPX96: bigint, liquidity: bigint, amount: bigint): bigint {
  // Short circuit: the formula below is not guaranteed to return the input price for amount 0.
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;
  // Precise form L·√P / (L + amount·√P) unless amount·√P or the denominator overflows uint256,
  // in which case Solidity falls back to the coarser L / (L/√P + amount).
  const product = amount * sqrtPX96;
  if (product <= MAX_UINT256) {
    const denominator = numerator1 + product;
    if (denominator <= MAX_UINT256) return mulDivRoundingUp(numerator1, sqrtPX96, denominator) & MAX_UINT160;
  }
  const denominator = numerator1 / sqrtPX96 + amount;
  if (denominator > MAX_UINT256) revert("amount0 overflow"); // LowGasSafeMath.add
  return divRoundingUp(numerator1, denominator) & MAX_UINT160;
}

/** getNextSqrtPriceFromAmount1RoundingDown with add = true. */
function nextSqrtPriceFromAmount1In(sqrtPX96: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
  const next = sqrtPX96 + quotient;
  if (next > MAX_UINT160) revert("sqrt price overflow"); // LowGasSafeMath.add then SafeCast.toUint160
  return next;
}

/** Price after adding amountIn of the input token, rounded so the target is never overshot. */
export function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 === 0n || liquidity === 0n) revert("zero price or liquidity");
  return zeroForOne
    ? nextSqrtPriceFromAmount0In(sqrtPX96, liquidity, amountIn)
    : nextSqrtPriceFromAmount1In(sqrtPX96, liquidity, amountIn);
}

// ---------------------------------------------------------------------------------------------------
// SwapMath

export interface SwapStep {
  sqrtPriceNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/**
 * SwapMath.computeSwapStep for exact input (amountRemaining >= 0), returning V3's split. V4 splits
 * amountIn/feeAmount differently when the target is not reached (amountIn = remaining less fee) but
 * amountIn + feeAmount, the price and amountOut are identical. A 100% fee (1e6 pips, V4 only) follows
 * V4, where V3's mulDivRoundingUp(.., 0) would revert.
 */
export function computeSwapStepExactIn(
  sqrtPriceCurrentX96: bigint,
  sqrtPriceTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: number,
): SwapStep {
  if (amountRemaining < 0n) revert("exact input only");
  if (!Number.isInteger(feePips) || feePips < 0 || feePips > 1_000_000) revert(`bad fee ${feePips}`);
  const fee = BigInt(feePips);
  const zeroForOne = sqrtPriceCurrentX96 >= sqrtPriceTargetX96;

  const amountRemainingLessFee = mulDiv(amountRemaining, PIPS - fee, PIPS);
  let amountIn = zeroForOne
    ? getAmount0Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, true)
    : getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, true);
  const sqrtPriceNextX96 =
    amountRemainingLessFee >= amountIn
      ? sqrtPriceTargetX96
      : getNextSqrtPriceFromInput(sqrtPriceCurrentX96, liquidity, amountRemainingLessFee, zeroForOne);

  const max = sqrtPriceTargetX96 === sqrtPriceNextX96;
  let amountOut: bigint;
  if (zeroForOne) {
    if (!max) amountIn = getAmount0Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, true);
    amountOut = getAmount1Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, false);
  } else {
    if (!max) amountIn = getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, true);
    amountOut = getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, false);
  }

  // Target not reached: the whole remainder is spent, the part not swapped is the fee.
  const feeAmount = !max
    ? amountRemaining - amountIn
    : fee === PIPS
      ? amountIn
      : mulDivRoundingUp(amountIn, fee, PIPS - fee);
  return { sqrtPriceNextX96, amountIn, amountOut, feeAmount };
}

// ---------------------------------------------------------------------------------------------------
// Pool state, TickBitmap and swap

export interface TickInfo {
  tick: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
}

export interface ClState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
  /** Swap fee in pips (1e-6), e.g. 3000 = 0.30%. For V4 this is the combined LP + protocol swap fee. */
  fee: number;
  /** Initialized ticks (liquidityGross > 0) sorted ascending, complete for bitmap words [wordLo, wordHi]. */
  ticks: TickInfo[];
  /** Inclusive range of tick-bitmap words (wordOf(tick, tickSpacing)) whose ticks are known. */
  wordLo: number;
  wordHi: number;
}

export interface QuoteResult {
  /** Input actually consumed, fee included. */
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  ticksCrossed: number;
  /** False if the swap stopped at the edge of the known bitmap window with input left over. */
  complete: boolean;
}

/** tick / tickSpacing rounded toward negative infinity, as TickBitmap does. */
export function compressTick(tick: number, tickSpacing: number): number {
  const q = Math.trunc(tick / tickSpacing);
  return tick < 0 && tick % tickSpacing !== 0 ? q - 1 : q;
}

/** Bitmap word holding a tick: compressTick(...) >> 8 (arithmetic shift). */
export function wordOf(tick: number, tickSpacing: number): number {
  return compressTick(tick, tickSpacing) >> 8;
}

/** A word is known if inside the window, or entirely outside [MIN_TICK, MAX_TICK] (it can hold no ticks). */
function wordKnown(state: ClState, word: number): boolean {
  return (
    (word >= state.wordLo && word <= state.wordHi) ||
    word < wordOf(MIN_TICK, state.tickSpacing) ||
    word > wordOf(MAX_TICK, state.tickSpacing)
  );
}

/** Index of the first tick >= value. */
function lowerBound(ticks: readonly TickInfo[], value: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid]!.tick < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface NextTick {
  next: number;
  initialized: TickInfo | undefined;
  word: number;
}

/**
 * TickBitmap.nextInitializedTickWithinOneWord: the next initialized tick at or below (lte) / above the
 * current tick but only within one bitmap word, else that word's last tick in the search direction.
 */
function nextInitializedTickWithinOneWord(state: ClState, tick: number, lte: boolean): NextTick {
  const spacing = state.tickSpacing;
  const ticks = state.ticks;
  const compressed = compressTick(tick, spacing);
  if (lte) {
    const word = compressed >> 8;
    const lowest = (word << 8) * spacing;
    const i = lowerBound(ticks, compressed * spacing + 1) - 1; // last tick <= compressed * spacing
    const t = ticks[i];
    return t !== undefined && t.tick >= lowest
      ? { next: t.tick, initialized: t, word }
      : { next: lowest, initialized: undefined, word };
  }
  const start = compressed + 1;
  const word = start >> 8;
  const highest = ((word << 8) + 255) * spacing;
  const t = ticks[lowerBound(ticks, start * spacing)];
  return t !== undefined && t.tick <= highest
    ? { next: t.tick, initialized: t, word }
    : { next: highest, initialized: undefined, word };
}

/** LiquidityMath.addDelta. */
function addDelta(x: bigint, y: bigint): bigint {
  const z = x + y;
  if (z < 0n) revert("liquidity underflow");
  if (z > MAX_UINT128) revert("liquidity overflow");
  return z;
}

/**
 * Exact-input swap to the extreme price limit, reproducing UniswapV3Pool.swap / v4 Pool.swap step for
 * step. Stops early (complete = false) rather than step into a bitmap word whose ticks are unknown.
 * Does not mutate `state`.
 */
export function quoteExactInput(state: ClState, zeroForOne: boolean, amountIn: bigint): QuoteResult {
  if (amountIn > MAX_INT256) revert("amountIn exceeds int256");
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  let sqrtPriceX96 = state.sqrtPriceX96;
  let tick = state.tick;
  let liquidity = state.liquidity;
  let remaining = amountIn;
  let amountOut = 0n;
  let ticksCrossed = 0;
  let complete = true;

  // The pool reverts ('AS' / 'SPL') rather than swap nothing or swap from beyond the limit; quote zero.
  if (amountIn <= 0n || (zeroForOne ? sqrtPriceX96 <= limit : sqrtPriceX96 >= limit)) {
    return { amountIn: 0n, amountOut: 0n, sqrtPriceX96, tick, liquidity, ticksCrossed, complete };
  }

  while (remaining !== 0n && sqrtPriceX96 !== limit) {
    const sqrtPriceStartX96 = sqrtPriceX96;
    const step = nextInitializedTickWithinOneWord(state, tick, zeroForOne);
    if (!wordKnown(state, step.word)) {
      complete = false;
      break;
    }
    // The bitmap is not aware of the tick bounds.
    const tickNext = Math.min(Math.max(step.next, MIN_TICK), MAX_TICK);
    const sqrtPriceNextX96 = getSqrtRatioAtTick(tickNext);
    const target = (zeroForOne ? sqrtPriceNextX96 < limit : sqrtPriceNextX96 > limit) ? limit : sqrtPriceNextX96;

    const s = computeSwapStepExactIn(sqrtPriceX96, target, liquidity, remaining, state.fee);
    sqrtPriceX96 = s.sqrtPriceNextX96;
    remaining -= s.amountIn + s.feeAmount;
    amountOut += s.amountOut;

    if (sqrtPriceX96 === sqrtPriceNextX96) {
      if (step.initialized) {
        // Moving left, liquidityNet applies with the opposite sign.
        const net = step.initialized.liquidityNet;
        liquidity = addDelta(liquidity, zeroForOne ? -net : net);
        ticksCrossed++;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtPriceX96 !== sqrtPriceStartX96) {
      // Recompute unless still on the lower boundary of a tick just crossed.
      tick = getTickAtSqrtRatio(sqrtPriceX96);
    }
  }

  return { amountIn: amountIn - remaining, amountOut, sqrtPriceX96, tick, liquidity, ticksCrossed, complete };
}

/**
 * Apply a V3 Mint (delta > 0) / Burn (delta < 0) or V4 ModifyLiquidity to `state` in place.
 * Ticks in bitmap words outside the known window are left alone (their prior state is unknown);
 * the in-range liquidity is always updated.
 */
export function applyLiquidityDelta(state: ClState, tickLower: number, tickUpper: number, liquidityDelta: bigint): void {
  if (!(tickLower < tickUpper) || tickLower < MIN_TICK || tickUpper > MAX_TICK) revert("bad tick range");
  if (tickLower % state.tickSpacing !== 0 || tickUpper % state.tickSpacing !== 0) revert("tick not spaced");
  // A zero-liquidity burn (V3 "poke") touches no ticks.
  if (liquidityDelta === 0n) return;
  updateTick(state, tickLower, liquidityDelta, liquidityDelta);
  updateTick(state, tickUpper, liquidityDelta, -liquidityDelta);
  if (tickLower <= state.tick && state.tick < tickUpper) state.liquidity = addDelta(state.liquidity, liquidityDelta);
}

function updateTick(state: ClState, tick: number, grossDelta: bigint, netDelta: bigint): void {
  const word = wordOf(tick, state.tickSpacing);
  if (word < state.wordLo || word > state.wordHi) return;
  const i = lowerBound(state.ticks, tick);
  const existing = state.ticks[i]?.tick === tick ? state.ticks[i] : undefined;
  const liquidityGross = addDelta(existing?.liquidityGross ?? 0n, grossDelta);
  const liquidityNet = (existing?.liquidityNet ?? 0n) + netDelta;
  if (liquidityGross === 0n) {
    // Uninitialized ticks are cleared (and flipped off in the bitmap).
    if (existing) state.ticks.splice(i, 1);
  } else if (existing) {
    existing.liquidityGross = liquidityGross;
    existing.liquidityNet = liquidityNet;
  } else {
    state.ticks.splice(i, 0, { tick, liquidityGross, liquidityNet });
  }
}
