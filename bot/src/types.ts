import type { Address } from "viem";

/** `v2`: Uniswap V2 and its forks (fixed fee per factory). `aerodrome`: Aerodrome/Velodrome volatile pools (fee per pool). */
export type DexKind = "v2" | "aerodrome";

export interface DexConfig {
  name: string;
  kind: DexKind;
  factory: Address;
  /** Swap fee in basis points. Required for `v2`; read from the factory for `aerodrome`. */
  feeBps?: number;
}

/** All addresses inside the bot are lowercase so they can be used as map keys. */
export interface Pool {
  address: Address;
  dex: string;
  kind: DexKind;
  token0: Address;
  token1: Address;
  feeBps: number;
  reserve0: bigint;
  reserve1: bigint;
}

export interface Hop {
  pool: Pool;
  /** true: token0 in, token1 out. */
  zeroForOne: boolean;
}

export interface Cycle {
  id: number;
  hops: Hop[];
}

export interface Opportunity {
  cycle: Cycle;
  amountIn: bigint;
  amountOut: bigint;
  /** amountOut - amountIn, before gas. Denominated in the base token (WETH). */
  grossProfit: bigint;
}
