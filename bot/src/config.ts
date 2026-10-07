import { type Address, type Chain, type Hex, isAddress, isHex, parseEther } from "viem";
import { PRESETS } from "./chains.js";
import type { DexConfig } from "./types.js";

export interface BotConfig {
  chain: Chain;
  opStack: boolean;
  /** Lowercase. Start/end token of every cycle. */
  baseToken: Address;
  /** Lowercase hub tokens (includes baseToken). */
  hubs: Address[];
  /** Lowercase long-tail tokens to always track, in addition to auto-discovered ones. */
  extraTokens: Address[];
  dexes: DexConfig[];
  executor?: Address;
  /** When true, opportunities are found and simulated but never sent. */
  dryRun: boolean;
  maxHops: number;
  /** Capital cap per trade (also capped by the executor's balance when one is configured). */
  maxTradeWei: bigint;
  /** Minimum profit after gas, L1 fee and priority bid. */
  minProfitWei: bigint;
  /** Ignore pools holding less than this much of the base token. */
  minPoolBaseWei: bigint;
  /** Share of expected net profit offered as priority fee (basis points). */
  bidBps: number;
  maxTxPerBlock: number;
  /** Look back this many blocks of Sync events to find active long-tail tokens (0 disables). */
  discoverBlocks: number;
  maxSpokes: number;
  /** Re-read every reserve from chain this often, as a safety net against missed logs/reorgs. */
  resyncEveryBlocks: number;
  pollMs: number;
  /** Used for paper-trading estimates when no executor is deployed: gas ≈ gasBase + gasPerHop·hops. */
  gasBase: bigint;
  gasPerHop: bigint;
  tradeLog: string;
}

export interface Secrets {
  rpcUrl: string;
  privateKey?: Hex;
}

type Env = Record<string, string | undefined>;

function lower(address: string): Address {
  if (!isAddress(address, { strict: false })) throw new Error(`invalid address: ${address}`);
  return address.toLowerCase() as Address;
}

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  return value;
}

function eth(env: Env, key: string, fallback: string): bigint {
  const raw = env[key] || fallback;
  try {
    return parseEther(raw);
  } catch {
    throw new Error(`${key} must be an ETH amount like "0.5", got "${raw}"`);
  }
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${key} must be true or false, got "${raw}"`);
}

export function loadConfig(env: Env = process.env): BotConfig {
  const presetName = env.CHAIN ?? "base";
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`unknown CHAIN "${presetName}" (available: ${Object.keys(PRESETS).join(", ")})`);

  const disabled = new Set((env.DISABLE_DEXES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const extraTokens = (env.EXTRA_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(lower);
  const executor = env.EXECUTOR_ADDRESS ? lower(env.EXECUTOR_ADDRESS) : undefined;

  const bidPercent = num(env, "BID_PERCENT", 30);
  if (bidPercent >= 100) throw new Error("BID_PERCENT must be below 100");

  return {
    chain: preset.chain,
    opStack: preset.opStack,
    baseToken: lower(preset.baseToken),
    hubs: Object.values(preset.hubs).map(lower),
    extraTokens,
    dexes: preset.dexes.filter((d) => !disabled.has(d.name)).map((d) => ({ ...d, factory: lower(d.factory) })),
    executor,
    dryRun: bool(env, "DRY_RUN", true),
    maxHops: Math.min(Math.max(Math.floor(num(env, "MAX_HOPS", 3)), 2), 4),
    maxTradeWei: eth(env, "MAX_TRADE_ETH", "1"),
    minProfitWei: eth(env, "MIN_PROFIT_ETH", "0.00002"),
    minPoolBaseWei: eth(env, "MIN_POOL_WETH", "0.5"),
    bidBps: Math.round(bidPercent * 100),
    maxTxPerBlock: Math.max(1, Math.floor(num(env, "MAX_TX_PER_BLOCK", 2))),
    discoverBlocks: Math.floor(num(env, "DISCOVER_BLOCKS", 900)),
    maxSpokes: Math.floor(num(env, "MAX_SPOKES", 300)),
    resyncEveryBlocks: Math.max(1, Math.floor(num(env, "RESYNC_EVERY_BLOCKS", 150))),
    pollMs: Math.max(50, Math.floor(num(env, "POLL_MS", 200))),
    gasBase: 60_000n,
    gasPerHop: 75_000n,
    tradeLog: env.TRADE_LOG ?? "logs/trades.jsonl",
  };
}

export function loadSecrets(env: Env = process.env): Secrets {
  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required (an HTTPS endpoint for Base mainnet)");
  const privateKey = env.PRIVATE_KEY ? (env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`) : undefined;
  if (privateKey && (!isHex(privateKey) || privateKey.length !== 66)) throw new Error("PRIVATE_KEY must be a 32-byte hex key");
  return { rpcUrl, privateKey: privateKey as Hex | undefined };
}
