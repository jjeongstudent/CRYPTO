import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import { estimateL1Fee } from "viem/op-stack";
import { erc20Abi, executorAbi } from "./abi.js";
import type { BotConfig } from "./config.js";
import { bigintJson, log } from "./log.js";
import type { Cycle, Hop, Opportunity } from "./types.js";

const FEE_SHIFT = 160n;
const DIR_SHIFT = 176n;
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Packs a hop exactly as Executor.sol decodes it: pool | fee << 160 | zeroForOne << 176. */
export function encodeHop(hop: Hop): bigint {
  return BigInt(hop.pool.address) | (BigInt(hop.pool.feeBps) << FEE_SHIFT) | ((hop.zeroForOne ? 1n : 0n) << DIR_SHIFT);
}

export function encodeRoute(cycle: Cycle): bigint[] {
  return cycle.hops.map(encodeHop);
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
        this.client.simulateContract({ address: executor, abi: executorAbi, functionName: "run", args, account: this.from }),
        this.client.estimateContractGas({ address: executor, abi: executorAbi, functionName: "run", args, account: this.from }),
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
      let profit = 0n;
      if (receipt.status === "success") {
        const executor = this.cfg.executor;
        for (const ev of parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })) {
          if (ev.address.toLowerCase() !== this.cfg.baseToken) continue;
          if (ev.args.to.toLowerCase() === executor) profit += ev.args.value;
          if (ev.args.from.toLowerCase() === executor) profit -= ev.args.value;
        }
      }
      record.realizedProfit = profit;
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
