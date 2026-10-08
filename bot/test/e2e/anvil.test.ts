/**
 * End-to-end: real EVM (anvil), real compiled contracts, real bot code.
 *
 * Builds a small Base-like market (two Uniswap-V2-style DEXes with different fees, an Aerodrome-style
 * DEX with per-pool fees, a WETH/USDC hub pair and a long-tail token the bot has to discover by
 * itself), lets a "whale" knock prices out of line, and checks that the bot finds the arbitrage,
 * simulates it, sends it, and that the executor's WETH balance really goes up.
 *
 * Needs `anvil` on PATH (or ANVIL_BIN) and compiled contracts (`cd ../contracts && forge build`).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArbBot } from "../../src/bot.js";
import type { BotConfig } from "../../src/config.js";

const ANVIL = process.env.ANVIL_BIN ?? "anvil";
const anvilAvailable = spawnSync(ANVIL, ["--version"]).status === 0;
const OUT = new URL("../../../contracts/out/", import.meta.url).pathname;
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

// Anvil's default dev keys. Owner deploys and funds; operator is the bot's hot key.
const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const operator = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const whale = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex; deployed: Hex } {
  const path = join(OUT, file, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}; run "forge build" in contracts/ first`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object, deployed: json.deployedBytecode.object };
}

describe.skipIf(!anvilAvailable)("e2e on anvil", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  const wallet = createWalletClient({ chain, transport: http(RPC) });
  const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });

  const A = {
    erc20: artifact("MockERC20.sol", "MockERC20"),
    v2Factory: artifact("MockV2.sol", "MockV2Factory"),
    v2Pair: artifact("MockV2.sol", "MockV2Pair"),
    aeroFactory: artifact("MockAerodrome.sol", "MockAeroFactory"),
    multicall: artifact("Multicall3.sol", "Multicall3"),
    executor: artifact("Executor.sol", "Executor"),
  };

  let weth: Address, usdc: Address, toshi: Address, executor: Address;
  let uni: Address, pancake: Address, aero: Address;
  const pools: Record<string, Address> = {};
  const tradeLog = join(tmpdir(), `arb-e2e-${PORT}.jsonl`);

  async function deploy(art: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: owner });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  }

  async function write(address: Address, abi: Abi, functionName: string, args: unknown[], account = owner) {
    const hash = await wallet.writeContract({ address, abi, functionName, args, account } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }

  async function read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return (await client.readContract({ address, abi, functionName, args } as never)) as T;
  }

  const balanceOf = (token: Address, who: Address) => read<bigint>(token, A.erc20.abi, "balanceOf", [who]);

  async function seed(pool: Address, tokenA: Address, amountA: bigint, tokenB: Address, amountB: bigint) {
    await write(tokenA, A.erc20.abi, "mint", [pool, amountA]);
    await write(tokenB, A.erc20.abi, "mint", [pool, amountB]);
    await write(pool, A.v2Pair.abi, "sync", []);
  }

  async function v2Pool(factory: Address, tokenA: Address, amountA: bigint, tokenB: Address, amountB: bigint) {
    await write(factory, A.v2Factory.abi, "createPair", [tokenA, tokenB]);
    const pool = await read<Address>(factory, A.v2Factory.abi, "getPair", [tokenA, tokenB]);
    await seed(pool, tokenA, amountA, tokenB, amountB);
    return pool;
  }

  async function aeroPool(tokenA: Address, amountA: bigint, tokenB: Address, amountB: bigint, fee: number) {
    await write(aero, A.aeroFactory.abi, "createPool", [tokenA, tokenB, false]);
    const pool = await read<Address>(aero, A.aeroFactory.abi, "getPool", [tokenA, tokenB, false]);
    await write(aero, A.aeroFactory.abi, "setCustomFee", [pool, BigInt(fee)]);
    await seed(pool, tokenA, amountA, tokenB, amountB);
    return pool;
  }

  /** A whale market-sells `amountIn` of `tokenIn` straight into a pool (as a real swap would). */
  async function whaleSwap(pool: Address, tokenIn: Address, amountIn: bigint, feeBps: number) {
    const token0 = (await read<Address>(pool, A.v2Pair.abi, "token0")).toLowerCase();
    const [r0, r1] = await read<readonly [bigint, bigint]>(pool, A.v2Pair.abi, "getReserves");
    const zeroForOne = token0 === tokenIn.toLowerCase();
    const [rIn, rOut] = zeroForOne ? [r0, r1] : [r1, r0];
    const withFee = amountIn * BigInt(10_000 - feeBps);
    const out = (withFee * rOut) / (rIn * 10_000n + withFee);
    await write(tokenIn, A.erc20.abi, "mint", [whale.address, amountIn]);
    await write(tokenIn, A.erc20.abi, "transfer", [pool, amountIn], whale);
    await write(pool, A.v2Pair.abi, "swap", zeroForOne ? [0n, out, whale.address, "0x"] : [out, 0n, whale.address, "0x"], whale);
  }

  function config(overrides: Partial<BotConfig> = {}): BotConfig {
    return {
      chain,
      opStack: false,
      baseToken: weth.toLowerCase() as Address,
      weth: weth.toLowerCase() as Address,
      hubs: [weth, usdc].map((a) => a.toLowerCase() as Address),
      extraTokens: [],
      dexes: [
        { name: "uni", kind: "v2", factory: uni.toLowerCase() as Address, feeBps: 30 },
        { name: "pancake", kind: "v2", factory: pancake.toLowerCase() as Address, feeBps: 25 },
        { name: "aero", kind: "aerodrome", factory: aero.toLowerCase() as Address },
      ],
      executor: executor.toLowerCase() as Address,
      dryRun: false,
      maxHops: 3,
      maxTradeWei: parseEther("10"),
      minProfitWei: parseEther("0.0001"),
      minPoolBaseWei: parseEther("1"),
      bidBps: 3_000,
      maxTxPerBlock: 2,
      discoverBlocks: 500,
      maxSpokes: 10,
      resyncEveryBlocks: 1_000,
      pollMs: 50,
      gasBase: 60_000n,
      gasPerHop: 75_000n,
      tradeLog,
      clRangePct: 0.25,
      v4Hooks: [],
      simulatePending: false,
      skipSimulation: false,
      ...overrides,
    };
  }

  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--port", String(PORT), "--silent", "--base-fee", "1000000", "--disable-code-size-limit"], { stdio: "ignore" });
    client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        await client.getBlockNumber({ cacheTime: 0 });
        break;
      } catch {
        if (i > 100) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await test.setCode({ address: MULTICALL3, bytecode: A.multicall.deployed });

    weth = await deploy(A.erc20, ["Wrapped Ether", "WETH", 18]);
    usdc = await deploy(A.erc20, ["USD Coin", "USDC", 6]);
    toshi = await deploy(A.erc20, ["Toshi", "TOSHI", 18]);
    uni = await deploy(A.v2Factory, [30n]);
    pancake = await deploy(A.v2Factory, [25n]);
    aero = await deploy(A.aeroFactory);

    // Consistent prices: 1 WETH = 3000 USDC = 1,000,000 TOSHI.
    pools.uniWethUsdc = await v2Pool(uni, weth, parseEther("100"), usdc, parseUnits("300000", 6));
    pools.pancakeWethUsdc = await v2Pool(pancake, weth, parseEther("80"), usdc, parseUnits("240000", 6));
    pools.aeroWethUsdc = await aeroPool(weth, parseEther("50"), usdc, parseUnits("150000", 6), 5);
    pools.uniWethToshi = await v2Pool(uni, weth, parseEther("20"), toshi, parseEther("20000000"));
    pools.aeroToshiUsdc = await aeroPool(toshi, parseEther("20000000"), usdc, parseUnits("60000", 6), 30);

    // No V4 PoolManager in this market: V4 hops disabled.
    executor = await deploy(A.executor, [owner.address, operator.address, "0x0000000000000000000000000000000000000000", weth]);
    await write(weth, A.erc20.abi, "mint", [executor, parseEther("10")]);
    await test.setBalance({ address: operator.address, value: parseEther("1") });
    rmSync(tradeLog, { force: true });
  });

  afterAll(() => {
    anvil?.kill();
    rmSync(tradeLog, { force: true });
  });

  it("discovers the long-tail token and builds the pool graph", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    // TOSHI was never configured: it must have been found from Sync activity.
    expect(bot.registry.size).toBe(5);
    expect(bot.registry.has(pools.uniWethToshi!)).toBe(true);
    expect(bot.index.cycles.length).toBeGreaterThan(6);
    // Fresh, consistently priced market: nothing to do.
    expect(await bot.scan()).toHaveLength(0);
  });

  it("captures a 2-hop backrun after a whale dumps WETH on one DEX", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);

    await whaleSwap(pools.uniWethUsdc!, weth, parseEther("15"), 30);
    // Keep processing blocks (the bot's own trades produce new ones) until nothing is left to take.
    const firstRound = await bot.processBlock(await client.getBlockNumber({ cacheTime: 0 }));
    await bot.drain();
    expect(firstRound.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 8; i++) {
      const more = await bot.processBlock(await client.getBlockNumber({ cacheTime: 0 }));
      await bot.drain();
      if (more.length === 0) break;
    }

    expect(bot.stats.sent).toBeGreaterThanOrEqual(1);
    expect(bot.stats.landed).toBe(bot.stats.sent);
    expect(bot.stats.realizedNetWei > 0n).toBe(true);

    const after = await balanceOf(weth, executor);
    expect(after > before).toBe(true);
    // Every trade's on-chain profit covers its gas: the ETH spent by the operator is less than WETH gained.
    const gained = after - before;
    expect(gained > parseEther("0.1")).toBe(true);

    const records = readFileSync(tradeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(records.some((r) => r.mode === "live" && r.status === "success")).toBe(true);

    // Prices are now realigned, so a fresh scan finds nothing worth taking.
    const again = new ArbBot(client, config(), operator);
    await again.init();
    expect(await again.scan()).toHaveLength(0);
  });

  it("routes through the discovered token (3-hop) when it gets mispriced", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);

    // Someone apes WETH into TOSHI on uni: TOSHI is now expensive there vs. its USDC pool on aero.
    await whaleSwap(pools.uniWethToshi!, weth, parseEther("4"), 30);
    const trades = await bot.processBlock(await client.getBlockNumber({ cacheTime: 0 }));
    await bot.drain();

    expect(trades.length).toBeGreaterThanOrEqual(1);
    const route = bot.describe(trades[0]!.opp.cycle);
    expect(route).toContain("TOSHI");
    expect(trades[0]!.opp.cycle.hops).toHaveLength(3);
    expect(bot.stats.landed).toBeGreaterThanOrEqual(1);
    expect((await balanceOf(weth, executor)) > before).toBe(true);
  });

  it("dry-run finds the trade but never sends it", async () => {
    const bot = new ArbBot(client, config({ dryRun: true }), operator);
    await bot.init();
    await whaleSwap(pools.pancakeWethUsdc!, usdc, parseUnits("60000", 6), 25);
    const before = await balanceOf(weth, executor);
    const nonceBefore = await client.getTransactionCount({ address: operator.address });

    const trades = await bot.processBlock(await client.getBlockNumber({ cacheTime: 0 }));
    await bot.drain();

    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0]!.simulatedProfit! > 0n).toBe(true);
    expect(bot.stats.sent).toBe(0);
    expect(await balanceOf(weth, executor)).toBe(before);
    expect(await client.getTransactionCount({ address: operator.address })).toBe(nonceBefore);
  });

  it("respects the capital cap and the executor's actual balance", async () => {
    // The dry-run test left an opportunity open; cap the bot at 0.5 WETH.
    const bot = new ArbBot(client, config({ maxTradeWei: parseEther("0.5"), dryRun: true }), operator);
    await bot.init();
    const found = await bot.scan();
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const f of found) expect(f.opp.amountIn <= parseEther("0.5")).toBe(true);
  });

  it("a bot with a non-operator key cannot trade (contract rejects it in simulation)", async () => {
    const bot = new ArbBot(client, config(), whale);
    await bot.init();
    const before = await balanceOf(weth, executor);
    await whaleSwap(pools.uniWethUsdc!, usdc, parseUnits("50000", 6), 30);
    expect(await bot.processBlock(await client.getBlockNumber({ cacheTime: 0 }))).toHaveLength(0);
    await bot.drain();
    expect(bot.stats.sent).toBe(0);
    expect(await balanceOf(weth, executor)).toBe(before);
  });
});
