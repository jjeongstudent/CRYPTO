import type { Abi, Address, Hex, PublicClient } from "viem";
import type { LogLike } from "./events.js";

const MULTICALL_CHUNK = 400;

export interface ReadCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** Multicall with per-call failure tolerance; failed calls come back as undefined. */
export async function multiread<T>(client: PublicClient, calls: ReadCall[]): Promise<(T | undefined)[]> {
  const chunks: ReadCall[][] = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) chunks.push(calls.slice(i, i + MULTICALL_CHUNK));
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        client.multicall({ contracts: chunk, allowFailure: true, batchSize: 0 } as never) as Promise<
          { status: "success" | "failure"; result?: unknown }[]
        >,
    ),
  );
  return results.flat().map((r) => (r.status === "success" ? (r.result as T) : undefined));
}

export interface RpcLog extends LogLike {
  transactionHash: Hex | null;
  blockNumber: bigint;
}

interface RawRpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex | null;
  blockNumber: Hex | null;
}

/**
 * eth_getLogs for any of `topics` over a block range, without decoding (the bot decodes the few
 * words it needs). Halves the window whenever the provider rejects a range as too large.
 */
export async function getLogs(client: PublicClient, topics: Hex[], fromBlock: bigint, toBlock: bigint, maxWindow = 200n): Promise<RpcLog[]> {
  const logs: RpcLog[] = [];
  let start = fromBlock;
  let window = maxWindow;
  while (start <= toBlock) {
    const end = start + window - 1n < toBlock ? start + window - 1n : toBlock;
    try {
      const chunk = (await client.request({
        method: "eth_getLogs",
        params: [{ fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [topics] }],
      } as never)) as RawRpcLog[];
      for (const l of chunk) {
        logs.push({
          address: l.address.toLowerCase() as Address,
          topics: l.topics,
          data: l.data,
          transactionHash: l.transactionHash?.toLowerCase() as Hex | null,
          blockNumber: l.blockNumber ? BigInt(l.blockNumber) : end,
        });
      }
      start = end + 1n;
    } catch (err) {
      if (window === 1n) throw err;
      window = window / 2n;
    }
  }
  return logs;
}
