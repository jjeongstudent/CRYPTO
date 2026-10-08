import type { Address, Hex } from "viem";
import type { ClState } from "./clmath.js";

/**
 * `v2`: Uniswap V2 and forks (fixed fee per factory). `aerodrome`: Aerodrome volatile pools (fee per pool).
 * `v3`: Uniswap V3 and forks with the same interface (SushiSwap V3). `pancakeV3`: PancakeSwap V3 (own callback/event).
 * `slipstream`: Aerodrome Slipstream (V3-style, keyed by tick spacing, dynamic fee). `v4`: Uniswap V4 PoolManager.
 */
export type DexKind = "v2" | "aerodrome" | "v3" | "pancakeV3" | "slipstream" | "v4";

export interface DexConfig {
  name: string;
  kind: DexKind;
  /** Factory address; for `v4` the PoolManager. */
  factory: Address;
  /** `v2`: swap fee in basis points. */
  feeBps?: number;
  /** `v3` / `pancakeV3`: fee tiers (pips) to look up per token pair. */
  feeTiers?: number[];
  /** `slipstream`: tick spacings to look up; read from the factory when omitted. */
  tickSpacings?: number[];
  /** `v4`: (fee, tickSpacing) combinations to probe for hookless pools. */
  v4Keys?: [fee: number, tickSpacing: number][];
  /** `v4`: PositionManager, used to resolve the keys of active pools seen in Swap events. */
  positionManager?: Address;
}

export interface V4Key {
  /** Raw currencies (0x0 = native ETH). */
  currency0: Address;
  currency1: Address;
  /** PoolKey.fee as stored in the key (may carry the dynamic-fee flag). */
  fee: number;
  tickSpacing: number;
  hooks: Address;
  /** From slot0: protocol fee (12 bits per direction) and LP fee, both in pips. */
  protocolFee: number;
  lpFee: number;
}

interface PoolCommon {
  /** Lowercase pool address, or for V4 the lowercase 32-byte pool id. Used as the map key everywhere. */
  id: Hex;
  dex: string;
  kind: DexKind;
  /** Lowercase ERC20s. A V4 native-ETH currency is represented by WETH here. */
  token0: Address;
  token1: Address;
}

/** Constant-product pool (x·y = k). */
export interface CpPool extends PoolCommon {
  family: "cp";
  feeBps: number;
  reserve0: bigint;
  reserve1: bigint;
}

/** Concentrated-liquidity pool (V3-style tick math). */
export interface ClPool extends PoolCommon {
  family: "cl";
  state: ClState;
  v4?: V4Key;
}

export type Pool = CpPool | ClPool;

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

export function hopTokenIn(hop: Hop): Address {
  return hop.zeroForOne ? hop.pool.token0 : hop.pool.token1;
}

export function hopTokenOut(hop: Hop): Address {
  return hop.zeroForOne ? hop.pool.token1 : hop.pool.token0;
}
