import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as WsSocket, WebSocketServer } from "ws";
import type { Flashblock } from "../../src/flashblocks.js";
import { PendingLogsStream } from "../../src/pendingLogs.js";

const TOPIC = `0x${"1c".repeat(32)}` as Hex;

/** Minimal Flashblocks-aware RPC: answers eth_subscribe("pendingLogs") and lets tests push logs. */
function rpcServer(opts: { reject?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const sockets: WsSocket[] = [];
  const requests: unknown[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      requests.push(req);
      if (opts.reject) socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unsupported subscription" } }));
      else socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xsub1" }));
    });
  });
  const ready = new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  return {
    ready,
    requests,
    sockets,
    url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    push(socket: WsSocket, block: number, tx: number, logIndex: number, subscription = "0xsub1") {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscription",
          params: {
            subscription,
            result: {
              address: `0x${"AB".repeat(20)}`,
              topics: [TOPIC],
              data: `0x${logIndex.toString(16).padStart(64, "0")}`,
              blockNumber: `0x${block.toString(16)}`,
              transactionHash: `0x${tx.toString(16).padStart(64, "0")}`,
              logIndex: `0x${logIndex.toString(16)}`,
              removed: false,
            },
          },
        }),
      );
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3_000) {
  for (let t = 0; t < ms && !cond(); t += 10) await wait(10);
  expect(cond()).toBe(true);
}

describe("PendingLogsStream", () => {
  let stream: PendingLogsStream | undefined;
  let server: ReturnType<typeof rpcServer> | undefined;
  afterEach(async () => {
    stream?.stop();
    await server?.close();
  });

  it("subscribes with the topic filter and groups one flashblock's burst into a batch", async () => {
    server = rpcServer();
    await server.ready;
    const batches: Flashblock[] = [];
    stream = new PendingLogsStream({ url: server.url(), topics: [TOPIC], onBatch: (b) => batches.push(b), batchMs: 20 });
    stream.start();
    await until(() => stream!.connected);
    expect(server.requests[0]).toMatchObject({ method: "eth_subscribe", params: ["pendingLogs", { topics: [[TOPIC]] }] });

    const socket = server.sockets[0]!;
    server.push(socket, 100, 1, 0);
    server.push(socket, 100, 1, 1);
    server.push(socket, 100, 2, 2);
    await until(() => batches.length === 1);
    expect(batches[0]!.blockNumber).toBe(100n);
    expect(batches[0]!.logs.map((l) => BigInt(l.data))).toEqual([0n, 1n, 2n]);
    expect(batches[0]!.transactionHashes).toHaveLength(2);
    expect(batches[0]!.logs[0]!.address).toBe(`0x${"ab".repeat(20)}`); // lowercased

    // A log for the next block ends the previous burst right away.
    server.push(socket, 101, 3, 0);
    server.push(socket, 102, 4, 0);
    await until(() => batches.length === 3);
    expect(batches.map((b) => b.blockNumber)).toEqual([100n, 101n, 102n]);
  });

  it("ignores notifications for other subscriptions", async () => {
    server = rpcServer();
    await server.ready;
    const batches: Flashblock[] = [];
    stream = new PendingLogsStream({ url: server.url(), topics: [TOPIC], onBatch: (b) => batches.push(b), batchMs: 5 });
    stream.start();
    await until(() => stream!.connected);
    server.push(server.sockets[0]!, 5, 1, 0, "0xother");
    await wait(50);
    expect(batches).toHaveLength(0);
  });

  it("reconnects and resubscribes after the server drops the connection", async () => {
    server = rpcServer();
    await server.ready;
    const batches: Flashblock[] = [];
    stream = new PendingLogsStream({ url: server.url(), topics: [TOPIC], onBatch: (b) => batches.push(b), batchMs: 5 });
    stream.start();
    await until(() => stream!.connected);
    server.sockets[0]!.terminate();
    await until(() => server!.sockets.length === 2 && stream!.connected);
    server.push(server.sockets[1]!, 7, 1, 0);
    await until(() => batches.length === 1);
    expect(stream.stats.reconnects).toBeGreaterThanOrEqual(1);
  });

  it("backs off when the endpoint is not Flashblocks-aware", async () => {
    server = rpcServer({ reject: true });
    await server.ready;
    const statuses: string[] = [];
    stream = new PendingLogsStream({ url: server.url(), topics: [TOPIC], onBatch: () => {}, onStatus: (s, d) => statuses.push(`${s}:${d ?? ""}`), maxBackoffMs: 60_000 });
    stream.start();
    await until(() => statuses.some((s) => s.includes("pendingLogs rejected")));
    await wait(300);
    // Rejected subscriptions wait the maximum backoff instead of reconnecting immediately.
    expect(server.sockets.length).toBe(1);
    expect(stream.connected).toBe(false);
  });

  it("stop() flushes the pending burst and cancels timers", async () => {
    server = rpcServer();
    await server.ready;
    const batches: Flashblock[] = [];
    stream = new PendingLogsStream({ url: server.url(), topics: [TOPIC], onBatch: (b) => batches.push(b), batchMs: 10_000 });
    stream.start();
    await until(() => stream!.connected);
    server.push(server.sockets[0]!, 9, 1, 0);
    await until(() => stream!.stats.logs === 1);
    stream.stop();
    expect(batches).toHaveLength(1);
    expect(stream.connected).toBe(false);
  });
});
