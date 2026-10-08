import type { Hex } from "viem";
import type { Flashblock, RawLog } from "./flashblocks.js";

/**
 * Pre-confirmed logs from a Flashblocks-aware RPC (base/node-reth `eth_subscribe("pendingLogs", filter)`).
 *
 * Since Base's Azul upgrade (mainnet 2026-05-28) the public flashblocks websocket no longer carries
 * receipts, so this subscription is how a bot sees swaps ~200ms before the block seals. Per node-reth
 * (crates/execution/flashblocks/src/rpc/pubsub.rs, `pending_logs_stream`), each notification is one
 * standard RPC log from the latest flashblock only (no re-sends of earlier flashblocks), in execution
 * order. Logs of one flashblock arrive as a burst, so they are grouped by a short quiet period before
 * being handed over: trading on half a flashblock would act on a state the sequencer already moved past.
 */
export interface PendingLogsOptions {
  /** Websocket URL of a Flashblocks-aware RPC (e.g. wss://mainnet-preconf.base.org). */
  url: string;
  /** Topic0 values to subscribe to (any of). */
  topics: Hex[];
  onBatch: (batch: Flashblock) => void;
  onStatus?: (status: "open" | "closed" | "error", detail?: string) => void;
  /** Quiet period that ends a burst. */
  batchMs?: number;
  staleMs?: number;
  maxBackoffMs?: number;
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  transactionHash?: string | null;
  blockNumber?: string | null;
  removed?: boolean;
}

export class PendingLogsStream {
  readonly stats = { messages: 0, logs: 0, batches: 0, reconnects: 0, parseErrors: 0 };
  private socket: WebSocket | undefined;
  private stopped = true;
  private backoffMs = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private buffer: RawLog[] = [];
  private bufferBlock: bigint | undefined;
  private subscriptionId: string | undefined;

  constructor(private readonly opts: PendingLogsOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.subscriptionId !== undefined;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.staleTimer);
    this.flush();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private connect(): void {
    const socket = new WebSocket(this.opts.url);
    this.socket = socket;
    this.subscriptionId = undefined;
    socket.addEventListener("open", () => {
      this.backoffMs = 250;
      this.armWatchdog();
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["pendingLogs", { topics: [this.opts.topics] }] }));
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      this.armWatchdog();
      this.onMessage(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8"));
    });
    socket.addEventListener("error", () => this.opts.onStatus?.("error", "websocket error"));
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.opts.onStatus?.("closed");
      this.scheduleReconnect();
    });
  }

  private onMessage(text: string): void {
    this.stats.messages++;
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { subscription?: string; result?: RpcLog } };
    try {
      msg = JSON.parse(text);
    } catch {
      this.stats.parseErrors++;
      return;
    }
    if (msg.id === 1) {
      if (typeof msg.result === "string") {
        this.subscriptionId = msg.result;
        this.opts.onStatus?.("open");
      } else {
        // The endpoint doesn't support pendingLogs (not Flashblocks-aware): don't hammer it.
        this.opts.onStatus?.("error", `eth_subscribe pendingLogs rejected: ${msg.error?.message ?? "no subscription id"}`);
        this.backoffMs = this.opts.maxBackoffMs ?? 10_000;
        this.socket?.close();
      }
      return;
    }
    if (msg.method !== "eth_subscription" || msg.params?.subscription !== this.subscriptionId) return;
    const log = msg.params?.result;
    if (!log || log.removed) return;
    const parsed = parseLog(log);
    if (!parsed) {
      this.stats.parseErrors++;
      return;
    }
    this.stats.logs++;
    // A new block number ends the previous block's burst immediately.
    if (this.bufferBlock !== undefined && parsed.blockNumber !== this.bufferBlock) this.flush();
    this.bufferBlock = parsed.blockNumber;
    this.buffer.push(parsed.log);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.opts.batchMs ?? 3);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    if (this.buffer.length === 0 || this.bufferBlock === undefined) return;
    const logs = this.buffer;
    const blockNumber = this.bufferBlock;
    this.buffer = [];
    this.bufferBlock = undefined;
    const hashes: Hex[] = [];
    for (const l of logs) if (hashes[hashes.length - 1] !== l.transactionHash) hashes.push(l.transactionHash);
    this.stats.batches++;
    try {
      this.opts.onBatch({ blockNumber, index: -1, payloadId: "pendingLogs", transactionHashes: hashes, logs });
    } catch (err) {
      this.opts.onStatus?.("error", `batch handler threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private armWatchdog(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.opts.onStatus?.("error", "no pending logs for too long; reconnecting");
      this.socket?.close();
    }, this.opts.staleMs ?? 30_000);
  }

  private scheduleReconnect(): void {
    clearTimeout(this.staleTimer);
    this.flush();
    if (this.stopped) return;
    this.stats.reconnects++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 10_000);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }
}

function parseLog(log: RpcLog): { blockNumber: bigint; log: RawLog } | undefined {
  if (typeof log.address !== "string" || !Array.isArray(log.topics) || typeof log.data !== "string") return undefined;
  if (typeof log.transactionHash !== "string" || typeof log.blockNumber !== "string") return undefined;
  try {
    return {
      blockNumber: BigInt(log.blockNumber),
      log: {
        address: log.address.toLowerCase() as Hex,
        topics: log.topics.map((t) => t.toLowerCase() as Hex),
        data: log.data as Hex,
        transactionHash: log.transactionHash.toLowerCase() as Hex,
      },
    };
  } catch {
    return undefined;
  }
}
