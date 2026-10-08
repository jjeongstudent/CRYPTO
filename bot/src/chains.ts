import type { Address, Chain } from "viem";
import { base } from "viem/chains";
import type { DexConfig } from "./types.js";

export interface ChainPreset {
  chain: Chain;
  /** OP-stack chains charge an L1 data fee on top of L2 gas. */
  opStack: boolean;
  /** Every cycle starts and ends in this token; profit and gas are both measured in it. */
  baseToken: Address;
  /** Wrapped native token (V4 native-ETH pools are routed through it). */
  weth: Address;
  /**
   * Liquid "hub" tokens. Pools are tracked between every pair of hubs, and between each
   * discovered long-tail token and every hub.
   */
  hubs: Record<string, Address>;
  dexes: DexConfig[];
}

/**
 * Base mainnet. Addresses are from each project's docs. They could not be checked on-chain
 * from the environment this was written in, so run `npm run check` against your RPC first: it
 * confirms every factory has code and finds a WETH/USDC pool, and disables any DEX that fails.
 * Interfaces (callbacks, slot0/ticks layouts, events) were verified against each project's source.
 */
export const BASE: ChainPreset = {
  chain: base,
  opStack: true,
  baseToken: "0x4200000000000000000000000000000000000006",
  weth: "0x4200000000000000000000000000000000000006",
  hubs: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
    AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  },
  dexes: [
    { name: "uniswap-v2", kind: "v2", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", feeBps: 30 },
    { name: "sushiswap-v2", kind: "v2", factory: "0x71524B4f93c58fcbF659783284E38825f0622859", feeBps: 30 },
    { name: "pancakeswap-v2", kind: "v2", factory: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", feeBps: 25 },
    // Fee set conservatively. Assuming a higher fee than the pool charges is always safe (we just ask for slightly less output).
    { name: "baseswap", kind: "v2", factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB", feeBps: 30 },
    { name: "aerodrome", kind: "aerodrome", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
    // Concentrated liquidity: where most Base volume trades.
    { name: "uniswap-v3", kind: "v3", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", feeTiers: [100, 500, 3000, 10_000] },
    { name: "sushiswap-v3", kind: "v3", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", feeTiers: [100, 500, 3000, 10_000] },
    { name: "pancakeswap-v3", kind: "pancakeV3", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", feeTiers: [100, 500, 2500, 10_000] },
    // Tick spacings are read from the factory; fees are dynamic per pool and re-read on every resync.
    { name: "aerodrome-slipstream", kind: "slipstream", factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" },
    {
      name: "uniswap-v4",
      kind: "v4",
      factory: "0x498581fF718922c3f8e6A244956aF099B2652b2b", // PoolManager
      positionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    },
  ],
};

export const PRESETS: Record<string, ChainPreset> = { base: BASE };
