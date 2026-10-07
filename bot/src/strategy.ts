import type { Address } from "viem";
import { type HopReserves, bestTrade } from "./math.js";
import type { Cycle, Hop, Opportunity } from "./types.js";

export function hopReserves(hop: Hop): HopReserves {
  const { pool } = hop;
  return hop.zeroForOne
    ? { reserveIn: pool.reserve0, reserveOut: pool.reserve1, feeBps: pool.feeBps }
    : { reserveIn: pool.reserve1, reserveOut: pool.reserve0, feeBps: pool.feeBps };
}

export function evaluateCycle(cycle: Cycle, maxIn: bigint): Opportunity | null {
  const trade = bestTrade(cycle.hops.map(hopReserves), maxIn);
  if (!trade) return null;
  return { cycle, amountIn: trade.amountIn, amountOut: trade.amountOut, grossProfit: trade.profit };
}

/** Evaluates cycles and returns the profitable ones, best first. */
export function findOpportunities(
  cycles: Iterable<Cycle>,
  maxIn: bigint,
  minGrossProfit: bigint,
  skip?: (cycle: Cycle) => boolean,
): Opportunity[] {
  const found: Opportunity[] = [];
  for (const cycle of cycles) {
    if (skip?.(cycle)) continue;
    const opp = evaluateCycle(cycle, maxIn);
    if (opp && opp.grossProfit > minGrossProfit) found.push(opp);
  }
  return found.sort((a, b) => (b.grossProfit > a.grossProfit ? 1 : b.grossProfit < a.grossProfit ? -1 : 0));
}

/**
 * Greedy pick of the best opportunities that share no pool with each other (or with `busy`).
 * Two trades through the same pool would invalidate each other's quotes.
 */
export function selectNonOverlapping(opps: readonly Opportunity[], limit: number, busy: ReadonlySet<Address> = new Set()): Opportunity[] {
  const used = new Set<Address>(busy);
  const chosen: Opportunity[] = [];
  for (const opp of opps) {
    if (chosen.length >= limit) break;
    if (opp.cycle.hops.some((h) => used.has(h.pool.address))) continue;
    for (const h of opp.cycle.hops) used.add(h.pool.address);
    chosen.push(opp);
  }
  return chosen;
}
