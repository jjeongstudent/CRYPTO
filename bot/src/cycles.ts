import type { Address } from "viem";
import type { Cycle, Hop, Pool } from "./types.js";

interface Edge {
  pool: Pool;
  zeroForOne: boolean;
  next: Address;
}

/**
 * Enumerates every simple cycle that starts and ends at `base`, uses 2..maxHops distinct pools,
 * and never revisits an intermediate token. Both directions of each loop are included, since
 * at most one of them can be profitable at any moment and we don't know which in advance.
 */
export function findCycles(pools: readonly Pool[], base: Address, maxHops: number, limit = 1_000_000): Cycle[] {
  const adjacency = new Map<Address, Edge[]>();
  const link = (from: Address, edge: Edge) => {
    const edges = adjacency.get(from);
    if (edges) edges.push(edge);
    else adjacency.set(from, [edge]);
  };
  for (const pool of pools) {
    link(pool.token0, { pool, zeroForOne: true, next: pool.token1 });
    link(pool.token1, { pool, zeroForOne: false, next: pool.token0 });
  }

  const cycles: Cycle[] = [];
  const path: Hop[] = [];
  const seenTokens = new Set<Address>([base]);
  const usedPools = new Set<Address>();

  const walk = (token: Address): void => {
    for (const edge of adjacency.get(token) ?? []) {
      if (cycles.length >= limit) return;
      if (usedPools.has(edge.pool.address)) continue;
      const hop: Hop = { pool: edge.pool, zeroForOne: edge.zeroForOne };
      if (edge.next === base) {
        if (path.length >= 1) cycles.push({ id: cycles.length, hops: [...path, hop] });
        continue;
      }
      if (path.length + 1 >= maxHops || seenTokens.has(edge.next)) continue;
      path.push(hop);
      seenTokens.add(edge.next);
      usedPools.add(edge.pool.address);
      walk(edge.next);
      usedPools.delete(edge.pool.address);
      seenTokens.delete(edge.next);
      path.pop();
    }
  };
  walk(base);
  return cycles;
}

/** Lets the bot re-check only the cycles touching pools whose reserves just changed. */
export class CycleIndex {
  private readonly byPool = new Map<Address, Cycle[]>();

  constructor(readonly cycles: Cycle[]) {
    for (const cycle of cycles) {
      for (const hop of cycle.hops) {
        const list = this.byPool.get(hop.pool.address);
        if (list) list.push(cycle);
        else this.byPool.set(hop.pool.address, [cycle]);
      }
    }
  }

  affectedBy(changedPools: Iterable<Address>): Cycle[] {
    const result = new Set<Cycle>();
    for (const address of changedPools) for (const cycle of this.byPool.get(address) ?? []) result.add(cycle);
    return [...result];
  }
}

export function cycleTokens(cycle: Cycle): Address[] {
  return cycle.hops.map((h) => (h.zeroForOne ? h.pool.token0 : h.pool.token1));
}
