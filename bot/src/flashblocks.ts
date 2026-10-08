import { brotliDecompressSync } from "node:zlib";
import { type Hex, isHex, keccak256 } from "viem";

/**
 * Base Flashblocks: 200ms pre-confirmed slices of the block being built, streamed over a websocket
 * (mainnet: wss://mainnet.flashblocks.base.org/ws).
 *
 * Wire format, verified against the sources (github.com/base/node-reth @ 4028d069, Oct 2026, and
 * github.com/flashbots/rollup-boost @ 87589f8b):
 * - FlashblocksPayloadV1 { payload_id: "0x<8 bytes>", index: number, base?: ExecutionPayloadBaseV1
 *   (index 0 only), diff: ExecutionPayloadFlashblockDeltaV1, metadata: free-form JSON }
 *   (node-reth crates/common/flashblocks/src/payload.rs; rollup-boost crates/rollup-boost-types/src/flashblocks.rs).
 *   `index` is a plain JSON number.
 * - base: snake_case; block_number / gas_limit / timestamp are hex quantities, base_fee_per_gas is a
 *   U256 (hex string).
 * - diff.transactions: EIP-2718 encoded txs (`encoded_2718`) of only the txs new in this flashblock,
 *   in execution order (node-reth crates/builder/core/src/flashblocks/payload.rs).
 * - metadata (same builder file, `FlashblocksMetadata`): { block_number: plain number,
 *   prev_flashblock_id: "<block>-<index>", receipts?: { txHash: BaseReceipt }, new_account_balances? }.
 *   `receipts` (a HashMap, so key order is meaningless) only covers this flashblock's txs, and is
 *   OMITTED once the Base Azul upgrade is active (mainnet timestamp 1779991200, 2026-05-28; see
 *   crates/common/chains/src/chain.rs). On such streams `logs` is empty for lack of data, and
 *   `receiptsIncluded` is false: logs must then come from a flashblocks-aware RPC
 *   (eth_subscribe "pendingLogs" / "newFlashblockTransactions", crates/execution/flashblocks/src/rpc/types.rs).
 * - BaseReceipt (crates/common/consensus/src/receipts/receipt.rs) is internally tagged:
 *   { "type": "0x2", "status": "0x1", "cumulativeGasUsed": "0x..", "logs": [{ address, topics, data }] },
 *   deposits add depositNonce / depositReceiptVersion. Older op-rbuilder streams used the externally
 *   tagged form { "Eip1559": { ... } } (also Legacy / Eip2930 / Eip7702 / Deposit); both are accepted.
 * - Encoding: the websocket-proxy (node-reth bin/websocket-proxy/src/main.rs) forwards every
 *   message as a binary frame holding either the UTF-8 JSON or, with --enable-compression, its
 *   brotli compression; clients tell them apart by a leading '{' (crates/common/flashblocks/src/block.rs).
 */

export interface RawLog {
  /** Lowercase. */
  address: Hex;
  topics: Hex[];
  data: Hex;
  /** Lowercase. */
  transactionHash: Hex;
}

export interface Flashblock {
  blockNumber: bigint;
  /** 0 = first flashblock of the block (the one carrying `base`). */
  index: number;
  payloadId: string;
  /** Only known from index 0's `base`. */
  baseFeePerGas?: bigint;
  /** Hashes of this flashblock's new transactions, in block order. */
  transactionHashes: Hex[];
  /** Logs of successful transactions, in execution order. */
  logs: RawLog[];
  /** False when metadata carried no receipts map (post-Azul builders), so `logs` says nothing. */
  receiptsIncluded?: boolean;
}

/** Decompression cap: guards against brotli bombs; node-reth's own client caps at 5 MiB. */
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** First non-whitespace byte is '{' or '[': plain JSON (brotli output is not expected to start so). */
function looksLikeJson(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x7b || b === 0x5b;
  }
  return false;
}

/** JSON text, UTF-8 JSON bytes, or brotli-compressed JSON bytes. Throws on anything else. */
export function decodeMessage(data: string | ArrayBuffer | Uint8Array): unknown {
  if (typeof data === "string") return JSON.parse(data);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (looksLikeJson(bytes)) {
    try {
      return JSON.parse(utf8.decode(bytes));
    } catch {
      // A brotli stream that happens to start with '{': fall through.
    }
  }
  return JSON.parse(brotliDecompressSync(bytes, { maxOutputLength: MAX_DECODED_BYTES }).toString("utf8"));
}

/** Reads `snake_case`, falling back to the camelCase spelling some relays use. */
function field(obj: Json | undefined, snake: string): unknown {
  if (!obj) return undefined;
  if (snake in obj) return obj[snake];
  return obj[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
}

/** Hex quantity, decimal string or JSON number. */
function toBigInt(v: unknown): bigint | undefined {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
    if (typeof v === "string" && v.length > 0) return BigInt(v);
  } catch {
    // Not a number.
  }
  return undefined;
}

/** EIP-658 status in any of its encodings; a missing status (pre-Byzantium `root`) counts as success. */
function succeeded(receipt: Json): boolean {
  const status = receipt.status;
  if (status === undefined || status === null) return true;
  if (typeof status === "boolean") return status;
  return toBigInt(status) !== 0n;
}

const RECEIPT_FIELDS = ["logs", "status", "cumulativeGasUsed", "cumulative_gas_used", "type"];

/** Strips the externally tagged envelope ({"Eip1559": {...}}) if present. */
function receiptBody(receipt: unknown): Json | undefined {
  if (!isObject(receipt)) return undefined;
  if (RECEIPT_FIELDS.some((k) => k in receipt)) return receipt;
  const keys = Object.keys(receipt);
  return keys.length === 1 ? receiptBody(receipt[keys[0]!]) : undefined;
}

function hexOf(v: unknown): Hex | undefined {
  return typeof v === "string" && isHex(v, { strict: true }) ? (v.toLowerCase() as Hex) : undefined;
}

function receiptLogs(receipt: unknown, txHash: Hex, out: RawLog[]): void {
  const body = receiptBody(receipt);
  if (!body || !succeeded(body) || !Array.isArray(body.logs)) return;
  for (const entry of body.logs) {
    if (!isObject(entry)) continue;
    // alloy's Log flattens LogData; tolerate the unflattened { address, data: { topics, data } } too.
    const inner = isObject(entry.data) ? entry.data : entry;
    const address = hexOf(entry.address);
    const data = hexOf(inner.data);
    const topics = Array.isArray(inner.topics) ? inner.topics.map(hexOf) : undefined;
    if (!address || data === undefined || !topics || topics.some((t) => t === undefined)) continue;
    out.push({ address, topics: topics as Hex[], data, transactionHash: txHash });
  }
}

/** A FlashblocksPayloadV1 as a Flashblock, or null for anything that is not one (never throws). */
export function parseFlashblock(message: unknown): Flashblock | null {
  try {
    if (!isObject(message)) return null;
    const diff = field(message, "diff");
    const index = field(message, "index");
    const payloadId = field(message, "payload_id");
    if (!isObject(diff) || typeof payloadId !== "string") return null;
    const indexNum = typeof index === "number" ? index : Number(toBigInt(index) ?? Number.NaN);
    if (!Number.isSafeInteger(indexNum) || indexNum < 0) return null;
    const rawTxs = field(diff, "transactions") ?? [];
    if (!Array.isArray(rawTxs)) return null;

    const base = field(message, "base");
    const baseObj = isObject(base) ? base : undefined;
    const meta = field(message, "metadata");
    const metaObj = isObject(meta) ? meta : undefined;
    const blockNumber = toBigInt(field(metaObj, "block_number")) ?? toBigInt(field(baseObj, "block_number"));
    if (blockNumber === undefined) return null;

    // Typed (EIP-2718) txs hash the whole envelope, legacy txs their RLP: either way the bytes as sent.
    const transactionHashes: Hex[] = [];
    for (const raw of rawTxs) {
      if (typeof raw !== "string" || !isHex(raw, { strict: true })) return null;
      transactionHashes.push(keccak256(raw as Hex));
    }

    // Execution order comes from diff.transactions; the receipts map's key order is meaningless.
    const logs: RawLog[] = [];
    const receipts = field(metaObj, "receipts");
    const receiptsIncluded = isObject(receipts);
    if (receiptsIncluded) {
      const byHash = new Map<string, unknown>();
      for (const [hash, receipt] of Object.entries(receipts)) byHash.set(hash.toLowerCase(), receipt);
      for (const hash of transactionHashes) {
        if (!byHash.has(hash)) continue;
        receiptLogs(byHash.get(hash), hash, logs);
        byHash.delete(hash);
      }
      // Receipts with no matching tx (should not happen): keep them rather than drop state changes.
      for (const [hash, receipt] of byHash) {
        const txHash = hexOf(hash);
        if (txHash) receiptLogs(receipt, txHash, logs);
      }
    }

    const fb: Flashblock = {
      blockNumber,
      index: indexNum,
      payloadId,
      transactionHashes,
      logs,
      receiptsIncluded,
    };
    const baseFee = toBigInt(field(baseObj, "base_fee_per_gas"));
    if (baseFee !== undefined) fb.baseFeePerGas = baseFee;
    return fb;
  } catch {
    return null;
  }
}

export interface FlashblocksOptions {
  url: string;
  onFlashblock: (fb: Flashblock) => void;
  onStatus?: (status: "open" | "closed" | "error", detail?: string) => void;
  /** Reconnect if no message arrives for this long (default 10_000). */
  staleMs?: number;
  /** Cap of the exponential reconnect backoff (default 10_000). */
  maxBackoffMs?: number;
}

const INITIAL_BACKOFF_MS = 250;

/** Websocket client for the flashblocks feed: reconnects with exponential backoff and on silence. */
export class FlashblocksStream {
  readonly stats = { messages: 0, flashblocks: 0, reconnects: 0, parseErrors: 0 };
  private readonly staleMs: number;
  private readonly maxBackoffMs: number;
  private ws: WebSocket | undefined;
  private open = false;
  private running = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: FlashblocksOptions) {
    this.staleMs = opts.staleMs ?? 10_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
  }

  get connected(): boolean {
    return this.open;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.staleTimer);
    this.reconnectTimer = this.staleTimer = undefined;
    this.drop(1000, "stopped");
  }

  private status(status: "open" | "closed" | "error", detail?: string): void {
    try {
      this.opts.onStatus?.(status, detail);
    } catch {
      // A failing observer must not break the connection loop.
    }
  }

  private connect(): void {
    if (!this.running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.status("error", err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // Armed before open too, so a handshake that hangs is also abandoned.
    this.armWatchdog();
    // Every handler checks it still owns the stream: a dropped socket's late events are ignored.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.status("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      // Backoff resets on data rather than on open, so a server that accepts then drops can't hot-loop us.
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.armWatchdog();
      this.handle(ev.data);
    };
    ws.onerror = (ev: Event) => {
      if (this.ws !== ws) return;
      this.status("error", (ev as Event & { message?: string }).message || "websocket error");
      // Node 22's WebSocket (undici) fires no close event after a failed handshake and stays
      // CONNECTING, so an error is treated as terminal here rather than waiting for onclose.
      this.drop(1000, "error");
      this.scheduleReconnect();
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.open = false;
      clearTimeout(this.staleTimer);
      this.status("closed", `${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`);
      this.scheduleReconnect();
    };
  }

  private handle(data: unknown): void {
    this.stats.messages++;
    let fb: Flashblock | null = null;
    try {
      fb = parseFlashblock(decodeMessage(data as string | ArrayBuffer));
    } catch {
      fb = null;
    }
    if (!fb) {
      this.stats.parseErrors++;
      return;
    }
    this.stats.flashblocks++;
    try {
      this.opts.onFlashblock(fb);
    } catch (err) {
      this.status("error", `onFlashblock threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private armWatchdog(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = undefined;
      if (!this.running) return;
      this.status("error", `stale: no message for ${this.staleMs}ms`);
      this.drop(4000, "stale");
      this.scheduleReconnect();
    }, this.staleMs);
  }

  /** Detaches and closes the current socket without triggering its close handler. */
  private drop(code: number, reason: string): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    const wasOpen = this.open;
    this.open = false;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
    if (wasOpen) this.status("closed", reason);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(this.backoffMs, this.maxBackoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.stats.reconnects++;
      this.connect();
    }, delay);
  }
}
