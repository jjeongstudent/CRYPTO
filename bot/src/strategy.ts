import type { Hex } from "viem";
import { bestRouteTrade, routeMarginalRate } from "./quote.js";
import type { Cycle, Opportunity } from "./types.js";

export function evaluateCycle(cycle: Cycle, maxIn: bigint): Opportunity | null {
  const trade = bestRouteTrade(cycle.hops, maxIn);
  if (!trade) return null;
  return { cycle, amountIn: trade.amountIn, amountOut: trade.amountOut, grossProfit: trade.profit };
}

/**
 * Evaluates cycles and returns the profitable ones, best first. A float check of the route's
 * marginal price (does an infinitesimal trade gain anything?) rejects the vast majority of
 * cycles before any exact bigint math runs.
 */
export function findOpportunities(
  cycles: Iterable<Cycle>,
  maxIn: bigint,
  minGrossProfit: bigint,
  skip?: (cycle: Cycle) => boolean,
): Opportunity[] {
  const found: Opportunity[] = [];
  for (const cycle of cycles) {
    if (skip?.(cycle)) continue;
    if (!(routeMarginalRate(cycle.hops) > 1)) continue;
    const opp = evaluateCycle(cycle, maxIn);
    if (opp && opp.grossProfit > minGrossProfit) found.push(opp);
  }
  return found.sort((a, b) => (b.grossProfit > a.grossProfit ? 1 : b.grossProfit < a.grossProfit ? -1 : 0));
}

/**
 * Greedy pick of the best opportunities that share no pool with each other (or with `busy`).
 * Two trades through the same pool would invalidate each other's quotes.
 */
export function selectNonOverlapping(opps: readonly Opportunity[], limit: number, busy: ReadonlySet<Hex> = new Set()): Opportunity[] {
  const used = new Set<Hex>(busy);
  const chosen: Opportunity[] = [];
  for (const opp of opps) {
    if (chosen.length >= limit) break;
    if (opp.cycle.hops.some((h) => used.has(h.pool.id))) continue;
    for (const h of opp.cycle.hops) used.add(h.pool.id);
    chosen.push(opp);
  }
  return chosen;
}
