import { parseAbi } from "viem";

export const v2FactoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address)"]);

export const aerodromeFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
  "function getFee(address pool, bool stable) view returns (uint256)",
]);

/**
 * getReserves is declared with uint256 outputs: Uniswap V2 returns (uint112, uint112, uint32) and
 * Aerodrome returns (uint256, uint256, uint256), and both decode correctly as 32-byte words.
 */
export const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  // WETH9
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);

/** Must match contracts/src/Executor.sol (the e2e test exercises it against the compiled contract). */
export const executorAbi = parseAbi([
  "struct Hop { uint8 kind; address pool; address tokenIn; address tokenOut; uint24 fee; int24 tickSpacing; bool zeroForOne; uint8 flags; }",
  "function run(address token, uint256 amountIn, uint256 minProfit, Hop[] hops) returns (uint256 profit)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function poolManager() view returns (address)",
  "function weth() view returns (address)",
  "function withdraw(address token, address to, uint256 amount)",
  "error NotOwner()",
  "error NotOperator()",
  "error BadRoute()",
  "error BadReserves()",
  "error TransferFailed()",
  "error Unauthorized()",
  "error NotProfitable(uint256 balanceBefore, uint256 balanceAfter)",
]);
