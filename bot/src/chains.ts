import type { Address, Chain } from "viem";
import { base } from "viem/chains";
import type { DexConfig } from "./types.js";

export interface ChainPreset {
  chain: Chain;
  /** OP-stack chains charge an L1 data fee on top of L2 gas. */
  opStack: boolean;
  /** Every cycle starts and ends in this token; profit and gas are both measured in it. */
  baseToken: Address;
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
 */
export const BASE: ChainPreset = {
  chain: base,
  opStack: true,
  baseToken: "0x4200000000000000000000000000000000000006",
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
  ],
};

export const PRESETS: Record<string, ChainPreset> = { base: BASE };
