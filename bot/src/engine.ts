import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hash,
  type Hex,
  type LocalAccount,
  type Log,
  type PublicClient,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import { estimateL1Fee } from "viem/op-stack";
import { erc20Abi, executorAbi } from "./abi.js";
import type { BotConfig } from "./config.js";
import { bigintJson, log } from "./log.js";
import { type Cycle, type Hop, type Opportunity, hopTokenIn, hopTokenOut } from "./types.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Executor.Hop.kind */
export const HOP_V2 = 0;
export const HOP_V3 = 1;
export const HOP_V4 = 2;
const FLAG_NATIVE_IN = 1;
const FLAG_NATIVE_OUT = 2;

export interface EncodedHop {
  kind: number;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
  zeroForOne: boolean;
  flags: number;
}

/** Builds the Executor.Hop struct for one hop (see contracts/src/Executor.sol for the field meanings). */
export function encodeHop(hop: Hop): EncodedHop {
  const pool = hop.pool;
  const base = { tokenIn: hopTokenIn(hop), tokenOut: hopTokenOut(hop), zeroForOne: hop.zeroForOne };
  if (pool.family === "cp") return { ...base, kind: HOP_V2, pool: pool.id as Address, fee: pool.feeBps, tickSpacing: 0, flags: 0 };
  if (!pool.v4) return { ...base, kind: HOP_V3, pool: pool.id as Address, fee: 0, tickSpacing: 0, flags: 0 };
  // V4: native ETH is routed as WETH and (un)wrapped by the executor around the PoolManager.
  const [currencyIn, currencyOut] = hop.zeroForOne ? [pool.v4.currency0, pool.v4.currency1] : [pool.v4.currency1, pool.v4.currency0];
  const flags = (currencyIn === ZERO_ADDRESS ? FLAG_NATIVE_IN : 0) | (currencyOut === ZERO_ADDRESS ? FLAG_NATIVE_OUT : 0);
  return { ...base, kind: HOP_V4, pool: pool.v4.hooks, fee: pool.v4.fee, tickSpacing: pool.v4.tickSpacing, flags };
}

export function encodeRoute(cycle: Cycle): EncodedHop[] {
  return cycle.hops.map(encodeHop);
}

/** Rough gas per hop kind, for paper trading and as a starting point before simulation. */
export function estimateRouteGas(cycle: Cycle, gasBase: bigint, gasPerHop: bigint): bigint {
  let gas = gasBase;
  for (const hop of cycle.hops) {
    if (hop.pool.family === "cp") gas += gasPerHop;
    else if (hop.pool.v4) gas += gasPerHop * 2n;
    else gas += (gasPerHop * 3n) / 2n;
  }
  return gas;
}

export function encodeRun(baseToken: Address, amountIn: bigint, minProfit: bigint, cycle: Cycle): Hex {
  return encodeFunctionData({ abi: executorAbi, functionName: "run", args: [baseToken, amountIn, minProfit, encodeRoute(cycle)] });
}

export interface Costs {
  gas: bigint;
  gasLimit: bigint;
  baseFee: bigint;
  priorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  /** gas · baseFee */
  l2Cost: bigint;
  l1Fee: bigint;
  /** Priority fee actually paid if the tx uses `gas`. */
  bid: bigint;
  /** l2Cost + l1Fee + bid */
  totalCost: bigint;
  /** grossProfit - totalCost */
  net: bigint;
}

/**
 * Works out what to bid. On Base the sequencer orders by priority fee, so the bot offers a fixed
 * share (`bidBps`) of whatever is left after unavoidable costs. Bidding more wins more races and
 * keeps less per win; tune it with the trade log.
 */
export function planCosts(grossProfit: bigint, gas: bigint, baseFee: bigint, l1Fee: bigint, bidBps: number): Costs {
  const gasLimit = (gas * 125n) / 100n;
  const l2Cost = gas * baseFee;
  const surplus = grossProfit - l2Cost - l1Fee;
  const budget = surplus > 0n ? (surplus * BigInt(bidBps)) / 10_000n : 0n;
  const priorityFeePerGas = gasLimit > 0n ? budget / gasLimit : 0n;
  const bid = priorityFeePerGas * gas;
  const totalCost = l2Cost + l1Fee + bid;
  return {
    gas,
    gasLimit,
    baseFee,
    priorityFeePerGas,
    maxFeePerGas: baseFee * 2n + priorityFeePerGas,
    l2Cost,
    l1Fee,
    bid,
    totalCost,
    net: grossProfit - totalCost,
  };
}

export type SimulationResult =
  | { ok: true; profit: bigint; gas: bigint }
  | { ok: false; reason: string; /** true when the route simply wasn't profitable anymore (a lost race, not a broken pool) */ benign: boolean };

export interface TradeRecord {
  mode: "paper" | "dry-run" | "live";
  block: string;
  route: string;
  amountIn: bigint;
  expectedGross: bigint;
  costs: Costs;
  hash?: Hash;
  status?: "success" | "reverted" | "dropped";
  realizedProfit?: bigint;
  realizedFees?: bigint;
}

export class ExecutionEngine {
  private nonce: number | undefined;

  constructor(
    private readonly client: PublicClient,
    private readonly cfg: BotConfig,
    /** Address simulations are sent from: the executor's operator. */
    readonly from: Address | undefined,
    private readonly account: LocalAccount | undefined,
  ) {}

  /**
   * With Flashblocks, state is ahead of the latest sealed block; a Flashblocks-aware RPC exposes
   * that pre-confirmed state as "pending", which is what trades must be simulated against.
   */
  private get blockTag(): "pending" | "latest" {
    return this.cfg.simulatePending ? "pending" : "latest";
  }

  get canSimulate(): boolean {
    return this.cfg.executor !== undefined && this.from !== undefined;
  }

  async init(): Promise<void> {
    if (this.account) this.nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
  }

  async simulate(opp: Opportunity): Promise<SimulationResult> {
    const executor = this.cfg.executor;
    if (!executor || !this.from) return { ok: false, reason: "no executor configured", benign: false };
    const args = [this.cfg.baseToken, opp.amountIn, 0n, encodeRoute(opp.cycle)] as const;
    try {
      const [sim, gas] = await Promise.all([
        this.client.simulateContract({ address: executor, abi: executorAbi, functionName: "run", args, account: this.from, blockTag: this.blockTag }),
        this.client.estimateContractGas({ address: executor, abi: executorAbi, functionName: "run", args, account: this.from, blockTag: this.blockTag }),
      ]);
      return { ok: true, profit: sim.result, gas };
    } catch (err) {
      const reason = revertReason(err);
      return { ok: false, reason, benign: reason === "NotProfitable" };
    }
  }

  async l1Fee(data: Hex): Promise<bigint> {
    if (!this.cfg.opStack) return 0n;
    return estimateL1Fee(this.client as never, {
      account: this.from ?? ZERO_ADDRESS,
      to: this.cfg.executor ?? ZERO_ADDRESS,
      data,
      chain: this.cfg.chain,
    } as never);
  }

  /** Signs locally and broadcasts. No extra RPC round-trips (chain id and nonce are tracked here). */
  async send(opp: Opportunity, costs: Costs, minProfit: bigint): Promise<Hash> {
    if (!this.account || !this.cfg.executor || this.nonce === undefined) throw new Error("engine not configured for live trading");
    const data = encodeRun(this.cfg.baseToken, opp.amountIn, minProfit, opp.cycle);
    const nonce = this.nonce;
    const serialized = await this.account.signTransaction({
      type: "eip1559",
      chainId: this.cfg.chain.id,
      nonce,
      to: this.cfg.executor,
      data,
      gas: costs.gasLimit,
      maxFeePerGas: costs.maxFeePerGas,
      maxPriorityFeePerGas: costs.priorityFeePerGas,
      value: 0n,
    });
    try {
      const hash = await this.client.sendRawTransaction({ serializedTransaction: serialized });
      this.nonce = nonce + 1;
      return hash;
    } catch (err) {
      // A rejected tx may leave our local nonce out of sync with the node; re-read it.
      this.nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
      throw err;
    }
  }

  /** Waits for the receipt and measures what the trade actually made from the executor's token transfers. */
  async settle(record: TradeRecord): Promise<TradeRecord> {
    if (!record.hash || !this.cfg.executor) return record;
    try {
      const receipt = await this.client.waitForTransactionReceipt({ hash: record.hash, timeout: 60_000, pollingInterval: 500 });
      const l1Fee = (receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n;
      record.realizedFees = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
      record.status = receipt.status;
      record.realizedProfit = receipt.status === "success" ? baseTokenFlow(receipt.logs, this.cfg.baseToken, this.cfg.executor) : 0n;
    } catch (err) {
      record.status = "dropped";
      log.warn("no receipt for trade", { hash: record.hash, error: shortError(err) });
    }
    return record;
  }

  async record(record: TradeRecord): Promise<void> {
    await mkdir(dirname(this.cfg.tradeLog), { recursive: true });
    await appendFile(this.cfg.tradeLog, JSON.stringify({ time: new Date().toISOString(), ...record }, bigintJson) + "\n");
  }
}

/**
 * Net base-token flow into `holder` from a receipt's logs. WETH9 wraps and unwraps emit Deposit /
 * Withdrawal rather than Transfer, and V4 native-ETH hops wrap and unwrap inside the route, so both
 * are counted alongside transfers.
 */
export function baseTokenFlow(logs: readonly Log[], token: Address, holder: Address): bigint {
  let flow = 0n;
  for (const ev of parseEventLogs({ abi: erc20Abi, logs: logs as Log[] })) {
    if (ev.address.toLowerCase() !== token) continue;
    if (ev.eventName === "Transfer") {
      if (ev.args.to.toLowerCase() === holder) flow += ev.args.value;
      if (ev.args.from.toLowerCase() === holder) flow -= ev.args.value;
    } else if (ev.eventName === "Deposit") {
      if (ev.args.dst.toLowerCase() === holder) flow += ev.args.wad;
    } else if (ev.eventName === "Withdrawal") {
      if (ev.args.src.toLowerCase() === holder) flow -= ev.args.wad;
    }
  }
  return flow;
}

export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      // Plain `require(..., "K")` reverts decode as Error(string); the message is the useful part.
      return name && name !== "Error" ? name : (revert.reason ?? "reverted");
    }
    return err.shortMessage;
  }
  return shortError(err);
}

export function shortError(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}
