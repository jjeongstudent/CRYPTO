import { brotliCompressSync } from "node:zlib";
import { type Hex, keccak256 } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as WsSocket, WebSocketServer } from "ws";
import { type Flashblock, FlashblocksStream, decodeMessage, parseFlashblock } from "../../src/flashblocks.js";

const ZERO32 = `0x${"00".repeat(32)}`;
const BLOOM = `0x${"00".repeat(256)}`;
const POOL_A = "0xAAAA000000000000000000000000000000000001";
const POOL_B = "0xbbbb000000000000000000000000000000000002";
const TOPIC_SWAP = "0xC42079F94A6350D7E6235F29174924F928CC2AC818EB64FED8004E115FBCCA67";
const TOPIC_SYNC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";

// Raw txs only need to be byte strings: the parser hashes them, it never decodes them.
const TX_DEPOSIT = "0x7ef8f8a0" + "11".repeat(40); // EIP-2718 typed envelope (deposit type 0x7e)
const TX_1559 = "0x02f87083014a3401" + "22".repeat(40);
const TX_LEGACY = "0xf86c098504a817c800825208" + "33".repeat(40);
const TX_FAILED = "0x02f87083014a3402" + "44".repeat(40);
const hash = (raw: string) => keccak256(raw as Hex);

function log(address: string, topics: string[], data = "0x01") {
  return { address, topics, data };
}

/** Shaped like node-reth's FlashblocksPayloadV1 (crates/common/flashblocks/src/payload.rs). */
function payload(opts: {
  index?: number;
  txs?: string[];
  receipts?: Record<string, unknown>;
  blockNumber?: unknown;
  base?: Record<string, unknown> | null;
}) {
  const index = opts.index ?? 0;
  const metadata: Record<string, unknown> = { prev_flashblock_id: "1233-10" };
  if (opts.blockNumber !== undefined) metadata.block_number = opts.blockNumber;
  if (opts.receipts) {
    metadata.receipts = opts.receipts;
    metadata.new_account_balances = {};
  }
  const msg: Record<string, unknown> = {
    payload_id: "0x0123456789abcdef",
    index,
    diff: {
      state_root: ZERO32,
      receipts_root: ZERO32,
      logs_bloom: BLOOM,
      gas_used: "0x5208",
      block_hash: ZERO32,
      transactions: opts.txs ?? [],
      withdrawals: [],
      withdrawals_root: ZERO32,
    },
    metadata,
  };
  if (opts.base !== null && (opts.base || index === 0)) {
    msg.base = {
      parent_beacon_block_root: ZERO32,
      parent_hash: ZERO32,
      fee_recipient: "0x4200000000000000000000000000000000000011",
      prev_randao: ZERO32,
      block_number: "0x4d2",
      gas_limit: "0x8f0d180",
      timestamp: "0x6553f100",
      extra_data: "0x",
      base_fee_per_gas: "0x5f5e100",
      ...opts.base,
    };
  }
  return msg;
}

/** Verbatim V0_5_0_PAYLOAD_JSON from node-reth crates/common/flashblocks/src/block.rs (bloom shortened). */
const NODE_RETH_V0_5_0 = `{
  "payload_id": "0x0000000000000000",
  "index": 0,
  "base": {
    "parent_beacon_block_root": "0x0101010101010101010101010101010101010101010101010101010101010101",
    "parent_hash": "0x0202020202020202020202020202020202020202020202020202020202020202",
    "fee_recipient": "0x0000000000000000000000000000000000000000",
    "prev_randao": "0x0303030303030303030303030303030303030303030303030303030303030303",
    "block_number": "0x9",
    "gas_limit": "0xf4240",
    "timestamp": "0x6553f100",
    "extra_data": "0xaabb",
    "base_fee_per_gas": "0xa"
  },
  "diff": {
    "state_root": "0x0404040404040404040404040404040404040404040404040404040404040404",
    "receipts_root": "0x0505050505050505050505050505050505050505050505050505050505050505",
    "logs_bloom": "0x00",
    "gas_used": "0x7a120",
    "block_hash": "0x0606060606060606060606060606060606060606060606060606060606060606",
    "transactions": ["0x0102"],
    "withdrawals": [],
    "withdrawals_root": "0x0707070707070707070707070707070707070707070707070707070707070707",
    "blob_gas_used": "0x2c"
  },
  "metadata": {
    "receipts": {
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
        "type": "0x2",
        "status": true,
        "cumulativeGasUsed": "0x5208",
        "logs": [{ "address": "0x00000000000000000000000000000000000000ff", "topics": [], "data": "0x" }]
      }
    },
    "new_account_balances": { "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": "0xde0b6b3a7640000" },
    "block_number": 1234,
    "access_list": null
  }
}`;

describe("parseFlashblock", () => {
  it("parses node-reth's pinned v0.5.0 wire format", () => {
    const fb = parseFlashblock(JSON.parse(NODE_RETH_V0_5_0));
    expect(fb).not.toBeNull();
    // metadata.block_number (plain number) is authoritative; base.block_number is only a fallback.
    expect(fb!.blockNumber).toBe(1234n);
    expect(fb!.index).toBe(0);
    expect(fb!.payloadId).toBe("0x0000000000000000");
    expect(fb!.baseFeePerGas).toBe(10n);
    expect(fb!.transactionHashes).toEqual([hash("0x0102")]);
    expect(fb!.receiptsIncluded).toBe(true);
    // Its receipt key matches no listed tx: still kept, appended after.
    expect(fb!.logs).toEqual([
      { address: "0x00000000000000000000000000000000000000ff", topics: [], data: "0x", transactionHash: `0x${"aa".repeat(32)}` },
    ]);
  });

  it("orders logs by diff.transactions, not by receipt map order, and skips failed receipts", () => {
    const txs = [TX_DEPOSIT, TX_1559, TX_FAILED, TX_LEGACY];
    // Map deliberately in reverse execution order, with mixed-case keys.
    const receipts = {
      [hash(TX_LEGACY).toUpperCase().replace("0X", "0x")]: {
        type: "0x0",
        status: "0x1",
        cumulativeGasUsed: "0x30000",
        logs: [log(POOL_B, [TOPIC_SYNC], "0x03")],
      },
      [hash(TX_FAILED)]: { type: "0x2", status: "0x0", cumulativeGasUsed: "0x20000", logs: [log(POOL_A, [TOPIC_SWAP], "0xff")] },
      [hash(TX_1559)]: {
        type: "0x2",
        status: "0x1",
        cumulativeGasUsed: "0x10000",
        logs: [log(POOL_A, [TOPIC_SWAP], "0x01"), log(POOL_B, [TOPIC_SYNC], "0x02")],
      },
      [hash(TX_DEPOSIT)]: { type: "0x7e", status: "0x1", cumulativeGasUsed: "0xb000", logs: [], depositNonce: "0x1", depositReceiptVersion: "0x1" },
    };
    const fb = parseFlashblock(payload({ txs, receipts, blockNumber: 1234 }))!;
    expect(fb.transactionHashes).toEqual(txs.map(hash));
    expect(fb.logs.map((l) => [l.transactionHash, l.address, l.data])).toEqual([
      [hash(TX_1559), POOL_A.toLowerCase(), "0x01"],
      [hash(TX_1559), POOL_B, "0x02"],
      [hash(TX_LEGACY), POOL_B, "0x03"],
    ]);
    expect(fb.logs[0]!.topics).toEqual([TOPIC_SWAP.toLowerCase()]);
  });

  it("accepts externally tagged (op-rbuilder) and flat receipts with every status encoding", () => {
    const txs = [TX_DEPOSIT, TX_1559, TX_LEGACY, TX_FAILED];
    const receipts = {
      [hash(TX_FAILED)]: { Eip1559: { status: false, cumulativeGasUsed: "0x4", logs: [log(POOL_A, [TOPIC_SWAP])] } },
      [hash(TX_LEGACY)]: { status: 1, cumulative_gas_used: "0x3", logs: [log(POOL_B, [TOPIC_SYNC], "0x03")] },
      [hash(TX_1559)]: { Eip1559: { status: "0x1", cumulativeGasUsed: "0x2", logs: [log(POOL_A, [TOPIC_SWAP], "0x02")] } },
      [hash(TX_DEPOSIT)]: {
        Deposit: { status: true, cumulativeGasUsed: "0x1", logs: [log(POOL_B, [TOPIC_SYNC], "0x01")], depositNonce: "0x5" },
      },
    };
    const fb = parseFlashblock(payload({ txs, receipts, blockNumber: 7 }))!;
    expect(fb.logs.map((l) => l.data)).toEqual(["0x01", "0x02", "0x03"]);
    expect(fb.logs.map((l) => l.transactionHash)).toEqual([hash(TX_DEPOSIT), hash(TX_1559), hash(TX_LEGACY)]);
  });

  it("treats status 0 / false / 0x0 alike and a missing status (root receipts) as success", () => {
    const txs = [TX_1559, TX_LEGACY, TX_FAILED, TX_DEPOSIT];
    const receipts = {
      [hash(TX_1559)]: { status: 0, logs: [log(POOL_A, [])] },
      [hash(TX_LEGACY)]: { Legacy: { root: ZERO32, cumulativeGasUsed: "0x1", logs: [log(POOL_B, [], "0x0b")] } },
      [hash(TX_FAILED)]: { Eip7702: { status: "0x0", cumulativeGasUsed: "0x1", logs: [log(POOL_A, [])] } },
      [hash(TX_DEPOSIT)]: { Eip2930: { status: false, cumulativeGasUsed: "0x1", logs: [log(POOL_A, [])] } },
    };
    const fb = parseFlashblock(payload({ txs, receipts, blockNumber: 7 }))!;
    expect(fb.logs).toEqual([{ address: POOL_B, topics: [], data: "0x0b", transactionHash: hash(TX_LEGACY) }]);
  });

  it("appends receipts whose tx is not in this flashblock after the ordered ones, in stable order", () => {
    const orphanA = `0x${"0a".repeat(32)}`;
    const orphanB = `0x${"0b".repeat(32)}`;
    const receipts = {
      [orphanB]: { status: "0x1", logs: [log(POOL_A, [], "0xb0")] },
      [hash(TX_1559)]: { status: "0x1", logs: [log(POOL_A, [], "0x10")] },
      [orphanA]: { status: "0x1", logs: [log(POOL_A, [], "0xa0")] },
    };
    const fb = parseFlashblock(payload({ txs: [TX_1559], receipts, blockNumber: 7 }))!;
    expect(fb.logs.map((l) => l.data)).toEqual(["0x10", "0xb0", "0xa0"]);
    expect(fb.logs.map((l) => l.transactionHash)).toEqual([hash(TX_1559), orphanB, orphanA]);
  });

  it("hashes typed transactions over the envelope bytes as sent", () => {
    const fb = parseFlashblock(payload({ txs: [TX_DEPOSIT.toUpperCase().replace("0X", "0x")], blockNumber: 1 }))!;
    expect(fb.transactionHashes).toEqual([keccak256(TX_DEPOSIT as Hex)]);
  });

  it("reads hex and numeric block numbers, falling back to base.block_number", () => {
    expect(parseFlashblock(payload({ blockNumber: 1234 }))!.blockNumber).toBe(1234n);
    expect(parseFlashblock(payload({ blockNumber: "0x4d3" }))!.blockNumber).toBe(1235n);
    expect(parseFlashblock(payload({ blockNumber: "1236" }))!.blockNumber).toBe(1236n);
    // No metadata.block_number: base's hex quantity.
    expect(parseFlashblock(payload({}))!.blockNumber).toBe(0x4d2n);
    // Neither: not usable.
    expect(parseFlashblock(payload({ index: 3 }))).toBeNull();
  });

  it("takes baseFeePerGas from index 0's base only", () => {
    expect(parseFlashblock(payload({ blockNumber: 1 }))!.baseFeePerGas).toBe(100_000_000n);
    expect(parseFlashblock(payload({ blockNumber: 1, base: { base_fee_per_gas: "1000" } }))!.baseFeePerGas).toBe(1000n);
    const later = parseFlashblock(payload({ index: 4, blockNumber: 1 }))!;
    expect(later.index).toBe(4);
    expect(later.baseFeePerGas).toBeUndefined();
    expect("baseFeePerGas" in later).toBe(false);
  });

  it("flags post-Azul payloads whose metadata carries no receipts", () => {
    const fb = parseFlashblock(payload({ index: 2, txs: [TX_1559, TX_LEGACY], blockNumber: 99 }))!;
    expect(fb.transactionHashes).toEqual([hash(TX_1559), hash(TX_LEGACY)]);
    expect(fb.logs).toEqual([]);
    expect(fb.receiptsIncluded).toBe(false);
  });

  it("accepts camelCase field spellings", () => {
    const fb = parseFlashblock({
      payloadId: "0x01",
      index: "0x1",
      diff: { transactions: [TX_1559] },
      metadata: { blockNumber: "0x10", receipts: { [hash(TX_1559)]: { status: "0x1", logs: [log(POOL_A, [TOPIC_SWAP])] } } },
    })!;
    expect(fb).toMatchObject({ payloadId: "0x01", index: 1, blockNumber: 16n });
    expect(fb.logs).toHaveLength(1);
  });

  it("returns null for anything that is not a flashblock payload", () => {
    const good = payload({ txs: [TX_1559], blockNumber: 5 });
    expect(parseFlashblock(good)).not.toBeNull();
    for (const bad of [
      null,
      undefined,
      42,
      "flashblock",
      [],
      {},
      { jsonrpc: "2.0", id: 1, result: "0x1" },
      { ...good, diff: undefined },
      { ...good, payload_id: undefined },
      { ...good, index: -1 },
      { ...good, index: "nope" },
      { ...good, diff: { transactions: "0x00" } },
      { ...good, diff: { transactions: ["not hex"] } },
      { ...good, diff: { transactions: [7] } },
    ]) {
      expect(parseFlashblock(bad)).toBeNull();
    }
  });

  it("skips malformed log entries without dropping the rest", () => {
    const receipts = {
      [hash(TX_1559)]: {
        status: "0x1",
        logs: [{ address: "zz", topics: [], data: "0x" }, log(POOL_A, ["0x12"], "0x"), { address: POOL_A, topics: [5], data: "0x" }, "junk"],
      },
    };
    const fb = parseFlashblock(payload({ txs: [TX_1559], receipts, blockNumber: 1 }))!;
    expect(fb.logs).toEqual([{ address: POOL_A.toLowerCase(), topics: ["0x12"], data: "0x", transactionHash: hash(TX_1559) }]);
  });
});

describe("decodeMessage", () => {
  const msg = payload({ txs: [TX_1559], blockNumber: 77 });
  const json = JSON.stringify(msg);

  it("decodes JSON text and UTF-8 JSON bytes (the proxy's uncompressed binary frames)", () => {
    expect(decodeMessage(json)).toEqual(msg);
    const bytes = new TextEncoder().encode(`\n ${json}`);
    expect(decodeMessage(bytes)).toEqual(msg);
    expect(decodeMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).toEqual(msg);
  });

  it("decodes brotli-compressed JSON (the proxy's --enable-compression frames)", () => {
    const compressed = brotliCompressSync(Buffer.from(json));
    expect(decodeMessage(compressed)).toEqual(msg);
    const ab = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
    expect(decodeMessage(ab)).toEqual(msg);
    expect(parseFlashblock(decodeMessage(new Uint8Array(ab)))!.blockNumber).toBe(77n);
  });

  it("throws on bytes that are neither", () => {
    expect(() => decodeMessage(new TextEncoder().encode("not brotli data"))).toThrow();
    expect(() => decodeMessage("{oops")).toThrow();
  });
});

interface TestServer {
  url: string;
  sockets: WsSocket[];
  close: () => Promise<void>;
}

async function startServer(onConnection: (socket: WsSocket, n: number) => void): Promise<TestServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const sockets: WsSocket[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    onConnection(socket, sockets.length);
  });
  const { port } = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of wss.clients) s.terminate();
        wss.close(() => resolve());
      }),
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (n: number, index = 0) => JSON.stringify(payload({ index, txs: [TX_1559], blockNumber: n }));

describe("FlashblocksStream", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function setup(onConnection: (socket: WsSocket, n: number) => void, opts: { staleMs?: number } = {}) {
    const server = await startServer(onConnection);
    cleanup.push(server.close);
    const received: Flashblock[] = [];
    const statuses: string[] = [];
    const stream = new FlashblocksStream({
      url: server.url,
      onFlashblock: (fb) => received.push(fb),
      onStatus: (s, detail) => statuses.push(detail ? `${s}:${detail}` : s),
      maxBackoffMs: 100,
      ...opts,
    });
    cleanup.push(() => stream.stop());
    return { server, stream, received, statuses };
  }

  it("delivers text, binary and brotli frames and counts undecodable ones", async () => {
    const { stream, received } = await setup((socket) => {
      socket.send(frame(100, 0)); // text frame
      socket.send(Buffer.from(frame(100, 1))); // binary, uncompressed
      socket.send(brotliCompressSync(Buffer.from(frame(100, 2)))); // binary, brotli
      socket.send("not json");
      socket.send(JSON.stringify({ hello: "world" }));
    });
    stream.start();
    await waitFor(() => stream.stats.messages === 5);
    expect(received.map((fb) => [fb.blockNumber, fb.index])).toEqual([
      [100n, 0],
      [100n, 1],
      [100n, 2],
    ]);
    expect(received[0]!.transactionHashes).toEqual([hash(TX_1559)]);
    expect(stream.stats).toEqual({ messages: 5, flashblocks: 3, reconnects: 0, parseErrors: 2 });
    expect(stream.connected).toBe(true);
  });

  it("survives a throwing onFlashblock handler", async () => {
    const server = await startServer((socket) => {
      socket.send(frame(1));
      socket.send(frame(2));
    });
    cleanup.push(server.close);
    const seen: bigint[] = [];
    const statuses: string[] = [];
    const stream = new FlashblocksStream({
      url: server.url,
      onFlashblock: (fb) => {
        seen.push(fb.blockNumber);
        if (fb.blockNumber === 1n) throw new Error("boom");
      },
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ""}`),
    });
    cleanup.push(() => stream.stop());
    stream.start();
    await waitFor(() => seen.length === 2);
    expect(statuses).toContain("error:onFlashblock threw: boom");
    expect(stream.connected).toBe(true);
  });

  it("reconnects after the server drops the connection", async () => {
    const { stream, received, statuses, server } = await setup((socket, n) => {
      socket.send(frame(n));
      if (n === 1) setTimeout(() => socket.terminate(), 20);
    });
    stream.start();
    await waitFor(() => received.length === 2);
    expect(received.map((fb) => fb.blockNumber)).toEqual([1n, 2n]);
    expect(server.sockets).toHaveLength(2);
    expect(stream.stats.reconnects).toBe(1);
    expect(statuses.filter((s) => s === "open")).toHaveLength(2);
    expect(statuses.some((s) => s.startsWith("closed"))).toBe(true);
    await waitFor(() => stream.connected);
  });

  it("keeps retrying with backoff while the server is unreachable", async () => {
    // Grab a free port, then close it so connections are refused.
    const probe = await startServer(() => {});
    const url = probe.url;
    await probe.close();
    const statuses: string[] = [];
    const stream = new FlashblocksStream({ url, onFlashblock: () => {}, onStatus: (s) => statuses.push(s), maxBackoffMs: 50 });
    cleanup.push(() => stream.stop());
    stream.start();
    await waitFor(() => stream.stats.reconnects >= 3);
    expect(stream.connected).toBe(false);
    expect(statuses).not.toContain("open");
  });

  it("reconnects a connection that goes silent (stale watchdog)", async () => {
    const { stream, server, statuses } = await setup(
      (socket, n) => {
        if (n === 1) socket.send(frame(1)); // then nothing more
      },
      { staleMs: 250 },
    );
    stream.start();
    await waitFor(() => server.sockets.length >= 2);
    expect(statuses).toContain("error:stale: no message for 250ms");
    expect(stream.stats.reconnects).toBeGreaterThanOrEqual(1);
    // The abandoned socket was closed from our side.
    await waitFor(() => server.sockets[0]!.readyState === server.sockets[0]!.CLOSED);
  });

  it("does not trip the watchdog while messages keep flowing", async () => {
    const timers: ReturnType<typeof setInterval>[] = [];
    cleanup.push(() => timers.forEach(clearInterval));
    const { stream, server } = await setup(
      (socket) => {
        let n = 0;
        timers.push(setInterval(() => socket.readyState === socket.OPEN && socket.send(frame(++n)), 50));
      },
      { staleMs: 250 },
    );
    stream.start();
    await sleep(800);
    expect(server.sockets).toHaveLength(1);
    expect(stream.stats.reconnects).toBe(0);
    expect(stream.stats.flashblocks).toBeGreaterThan(5);
  });

  it("stop() closes the socket and cancels every timer", async () => {
    const { stream, server, received } = await setup((socket) => socket.send(frame(1)), { staleMs: 200 });
    stream.start();
    await waitFor(() => received.length === 1 && stream.connected);
    const serverClosed = new Promise<number>((resolve) => server.sockets[0]!.once("close", (code) => resolve(code)));
    stream.stop();
    expect(stream.connected).toBe(false);
    expect(await serverClosed).toBe(1000);
    // Neither the watchdog nor a reconnect fires afterwards.
    await sleep(500);
    expect(server.sockets).toHaveLength(1);
    expect(stream.stats.reconnects).toBe(0);
    stream.stop(); // idempotent
  });

  it("stop() during the reconnect backoff cancels the pending reconnect", async () => {
    const { stream, server, statuses } = await setup((socket) => {
      socket.send(frame(1));
      setTimeout(() => socket.terminate(), 20);
    });
    stream.start();
    await waitFor(() => statuses.some((s) => s.startsWith("closed")));
    stream.stop();
    await sleep(400);
    expect(server.sockets).toHaveLength(1);
    expect(stream.stats.reconnects).toBe(0);
  });

  it("can be restarted after stop()", async () => {
    const { stream, server, received } = await setup((socket, n) => socket.send(frame(n)));
    stream.start();
    await waitFor(() => received.length === 1);
    stream.stop();
    stream.start();
    await waitFor(() => received.length === 2);
    expect(server.sockets).toHaveLength(2);
  });
});
