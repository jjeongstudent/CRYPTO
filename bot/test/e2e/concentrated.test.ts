/**
 * End-to-end against the REAL Uniswap V3 factory/pools and the REAL Uniswap V4 PoolManager (compiled
 * from the v3-core / v4-core submodules), plus a V2-style pair, the real executor, and the bot.
 *
 * The strongest assertion here is exactness: after loading pools from chain and following their
 * events, the bot's local quote for every concentrated hop must equal what the pool actually does,
 * and its predicted profit must equal the on-chain simulation to the wei.
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
import { WebSocketServer } from "ws";
import { ArbBot } from "../../src/bot.js";
import { getTickAtSqrtRatio, quoteExactInput, wordOf } from "../../src/clmath.js";
import type { BotConfig } from "../../src/config.js";
import { FlashblocksStream } from "../../src/flashblocks.js";
import { ALL_TOPICS } from "../../src/events.js";
import { PendingLogsStream } from "../../src/pendingLogs.js";
import { isqrt } from "../../src/math.js";
import { clSwapFee, hopQuote } from "../../src/quote.js";
import type { ClPool, Pool } from "../../src/types.js";

const ANVIL = process.env.ANVIL_BIN ?? "anvil";
const anvilAvailable = spawnSync(ANVIL, ["--version"]).status === 0;
const OUT = new URL("../../../contracts/out/", import.meta.url).pathname;
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

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

function artifact(path: string): { abi: Abi; bytecode: Hex; deployed: Hex } {
  const full = join(OUT, path);
  if (!existsSync(full)) throw new Error(`missing ${full}; run "forge build" in contracts/ first`);
  const json = JSON.parse(readFileSync(full, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object, deployed: json.deployedBytecode.object };
}

interface Key {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

describe.skipIf(!anvilAvailable)("e2e with real Uniswap V3 + V4", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  const wallet = createWalletClient({ chain, transport: http(RPC) });
  const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });

  const A = {
    erc20: artifact("MockERC20.sol/MockERC20.json"),
    weth: artifact("MockWETH.sol/MockWETH.json"),
    v2Factory: artifact("MockV2.sol/MockV2Factory.json"),
    v2Pair: artifact("MockV2.sol/MockV2Pair.json"),
    multicall: artifact("Multicall3.sol/Multicall3.json"),
    executor: artifact("Executor.sol/Executor.json"),
    v3Factory: artifact("UniswapV3Factory.sol/UniswapV3Factory.json"),
    v3Pool: artifact("UniswapV3Pool.sol/UniswapV3Pool.json"),
    poolManager: artifact("PoolManager.sol/PoolManager.json"),
    v3Helper: artifact("V3Helper.sol/V3Helper.json"),
    v4Helper: artifact("V4Helper.sol/V4Helper.json"),
  };

  let weth: Address, usdc: Address, toshi: Address;
  let v2Factory: Address, v3Factory: Address, poolManager: Address, v3h: Address, v4h: Address, executor: Address;
  let v2WethUsdc: Address, v2ToshiUsdc: Address, v3WethUsdc: Address;
  let v4EthUsdc: Key, v4ToshiWeth: Key;
  const tradeLog = join(tmpdir(), `arb-e2e-cl-${PORT}.jsonl`);

  async function deploy(art: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: owner });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  async function write(address: Address, abi: Abi, functionName: string, args: unknown[], account = owner, value?: bigint) {
    const hash = await wallet.writeContract({ address, abi, functionName, args, account, value } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return receipt;
  }

  async function read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return (await client.readContract({ address, abi, functionName, args } as never)) as T;
  }

  const balanceOf = (token: Address, who: Address) => read<bigint>(token, A.erc20.abi, "balanceOf", [who]);
  const head = () => client.getBlockNumber({ cacheTime: 0 });

  /** sqrtPriceX96 for a raw price of `amount1` token1 per `amount0` token0. */
  const sqrtPrice = (amount0: bigint, amount1: bigint) => isqrt((amount1 << 192n) / amount0);
  const align = (tick: number, spacing: number) => Math.floor(tick / spacing) * spacing;

  /** Sorts a token pair and returns the sqrtPrice for "1 unit of a = `b` units of b". */
  function ordered(a: Address, amountA: bigint, b: Address, amountB: bigint) {
    return BigInt(a) < BigInt(b) ? { token0: a, token1: b, sqrt: sqrtPrice(amountA, amountB) } : { token0: b, token1: a, sqrt: sqrtPrice(amountB, amountA) };
  }

  async function v2Pool(tokenA: Address, amountA: bigint, tokenB: Address, amountB: bigint) {
    await write(v2Factory, A.v2Factory.abi, "createPair", [tokenA, tokenB]);
    const pair = await read<Address>(v2Factory, A.v2Factory.abi, "getPair", [tokenA, tokenB]);
    await write(tokenA, A.erc20.abi, "mint", [pair, amountA]);
    await write(tokenB, A.erc20.abi, "mint", [pair, amountB]);
    await write(pair, A.v2Pair.abi, "sync", []);
    return pair;
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
        { name: "v2", kind: "v2", factory: v2Factory.toLowerCase() as Address, feeBps: 30 },
        { name: "uni-v3", kind: "v3", factory: v3Factory.toLowerCase() as Address, feeTiers: [500, 3000] },
        {
          name: "uni-v4",
          kind: "v4",
          factory: poolManager.toLowerCase() as Address,
          v4Keys: [
            [3000, 60],
            [10_000, 200],
          ],
        },
      ],
      executor: executor.toLowerCase() as Address,
      dryRun: false,
      maxHops: 3,
      maxTradeWei: parseEther("20"),
      minProfitWei: parseEther("0.0001"),
      minPoolBaseWei: parseEther("1"),
      bidBps: 3_000,
      maxTxPerBlock: 2,
      discoverBlocks: 1_000,
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

  /** Runs the bot block by block until it finds nothing more to do. */
  async function runUntilQuiet(bot: ArbBot, maxBlocks = 8) {
    const all = [];
    for (let i = 0; i < maxBlocks; i++) {
      const trades = await bot.processBlock(await head());
      await bot.drain();
      all.push(...trades);
      if (trades.length === 0) break;
    }
    return all;
  }

  /** The exact on-chain output of an exact-input swap, via the helpers as eth_call quoters. */
  async function onchainQuote(pool: ClPool, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
    if (pool.v4) {
      const key = { currency0: pool.v4.currency0, currency1: pool.v4.currency1, fee: pool.v4.fee, tickSpacing: pool.v4.tickSpacing, hooks: pool.v4.hooks };
      const sim = await client.simulateContract({ address: v4h, abi: A.v4Helper.abi, functionName: "swapExactIn", args: [key, zeroForOne, amountIn, whale.address], account: owner });
      return sim.result as bigint;
    }
    const sim = await client.simulateContract({ address: v3h, abi: A.v3Helper.abi, functionName: "swapExactIn", args: [pool.id, zeroForOne, amountIn, whale.address], account: owner });
    return sim.result as bigint;
  }

  function clPools(bot: ArbBot): ClPool[] {
    return bot.registry.all().filter((p): p is ClPool => p.family === "cl");
  }

  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--port", String(PORT), "--silent", "--base-fee", "1000000", "--disable-code-size-limit"], { stdio: "ignore" });
    client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        await client.getBlockNumber();
        break;
      } catch {
        if (i > 100) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await test.setCode({ address: MULTICALL3, bytecode: A.multicall.deployed });

    weth = await deploy(A.weth);
    usdc = await deploy(A.erc20, ["USD Coin", "USDC", 6]);
    toshi = await deploy(A.erc20, ["Toshi", "TOSHI", 18]);
    v2Factory = await deploy(A.v2Factory, [30n]);
    v3Factory = await deploy(A.v3Factory);
    poolManager = await deploy(A.poolManager, [owner.address]);
    v3h = await deploy(A.v3Helper);
    v4h = await deploy(A.v4Helper, [poolManager]);
    executor = await deploy(A.executor, [owner.address, operator.address, poolManager, weth]);

    // MockWETH mints without deposits; give it ETH so unwraps (V4 native hops) can pay out.
    await test.setBalance({ address: weth, value: parseEther("1000000") });
    await test.setBalance({ address: v4h, value: parseEther("100000") });
    await test.setBalance({ address: operator.address, value: parseEther("10") });
    for (const [token, amount] of [
      [weth, parseEther("100000")],
      [usdc, parseUnits("1000000000", 6)],
      [toshi, parseEther("1000000000000")],
    ] as const) {
      await write(token, A.erc20.abi, "mint", [v3h, amount]);
      await write(token, A.erc20.abi, "mint", [v4h, amount]);
    }
    await write(weth, A.erc20.abi, "mint", [executor, parseEther("20")]);

    // Consistent prices everywhere: 1 WETH = 3000 USDC = 1,000,000 TOSHI.
    v2WethUsdc = await v2Pool(weth, parseEther("100"), usdc, parseUnits("300000", 6));
    v2ToshiUsdc = await v2Pool(toshi, parseEther("100000000"), usdc, parseUnits("300000", 6));

    // Uniswap V3 WETH/USDC 0.05%: a wide position plus several overlapping concentrated ones.
    const v3 = ordered(weth, parseEther("1"), usdc, parseUnits("3000", 6));
    await write(v3Factory, A.v3Factory.abi, "createPool", [weth, usdc, 500]);
    v3WethUsdc = await read<Address>(v3Factory, A.v3Factory.abi, "getPool", [weth, usdc, 500]);
    await write(v3WethUsdc, A.v3Pool.abi, "initialize", [v3.sqrt]);
    const t3 = getTickAtSqrtRatio(v3.sqrt);
    const positions: [number, number, bigint][] = [
      [-887_270, 887_270, 3n * 10n ** 15n],
      [align(t3, 10) - 600, align(t3, 10) + 600, 4n * 10n ** 16n],
      [align(t3, 10) - 3_000, align(t3, 10) + 1_200, 2n * 10n ** 16n],
      [align(t3, 10) - 120, align(t3, 10) + 4_000, 1n * 10n ** 16n],
      [align(t3, 10) + 50, align(t3, 10) + 900, 5n * 10n ** 15n],
    ];
    for (const [lower, upper, liquidity] of positions) await write(v3h, A.v3Helper.abi, "mint", [v3WethUsdc, lower, upper, liquidity]);

    // Uniswap V4 native ETH/USDC 0.30%, hookless.
    const ethUsdc = ordered(ZERO, parseEther("1"), usdc, parseUnits("3000", 6));
    v4EthUsdc = { currency0: ethUsdc.token0, currency1: ethUsdc.token1, fee: 3000, tickSpacing: 60, hooks: ZERO };
    await write(poolManager, A.poolManager.abi, "initialize", [v4EthUsdc, ethUsdc.sqrt]);
    const t4 = getTickAtSqrtRatio(ethUsdc.sqrt);
    await write(v4h, A.v4Helper.abi, "modifyLiquidity", [v4EthUsdc, -887_220, 887_220, 2n * 10n ** 15n]);
    await write(v4h, A.v4Helper.abi, "modifyLiquidity", [v4EthUsdc, align(t4, 60) - 1_200, align(t4, 60) + 1_200, 3n * 10n ** 16n]);

    // Uniswap V4 TOSHI/WETH (both ERC20) 1%.
    const toshiWeth = ordered(weth, parseEther("1"), toshi, parseEther("1000000"));
    v4ToshiWeth = { currency0: toshiWeth.token0, currency1: toshiWeth.token1, fee: 10_000, tickSpacing: 200, hooks: ZERO };
    await write(poolManager, A.poolManager.abi, "initialize", [v4ToshiWeth, toshiWeth.sqrt]);
    const tt = getTickAtSqrtRatio(toshiWeth.sqrt);
    await write(v4h, A.v4Helper.abi, "modifyLiquidity", [v4ToshiWeth, align(tt, 200) - 20_000, align(tt, 200) + 20_000, 8n * 10n ** 21n]);

    rmSync(tradeLog, { force: true });
  });

  afterAll(() => {
    anvil?.kill();
    rmSync(tradeLog, { force: true });
  });

  it("loads V3 and V4 pools and quotes them exactly like the chain", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    const ids = new Set(bot.registry.all().map((p: Pool) => p.id));
    expect(ids.has(v3WethUsdc.toLowerCase() as Hex)).toBe(true);
    expect(ids.has(v2WethUsdc.toLowerCase() as Hex)).toBe(true);
    expect(ids.has(v2ToshiUsdc.toLowerCase() as Hex)).toBe(true); // TOSHI discovered from activity
    const cls = clPools(bot);
    expect(cls.filter((p) => p.v4)).toHaveLength(2);
    // Native ETH shows up as WETH in the graph.
    expect(cls.some((p) => p.v4?.currency0 === ZERO && (p.token0 === weth.toLowerCase() || p.token1 === weth.toLowerCase()))).toBe(true);

    let exact = 0;
    for (const pool of cls) {
      for (const zeroForOne of [true, false]) {
        const tokenIn = zeroForOne ? pool.token0 : pool.token1;
        const unit = tokenIn === usdc.toLowerCase() ? 10n ** 6n : tokenIn === toshi.toLowerCase() ? 10n ** 22n : 10n ** 18n;
        for (const amount of [unit / 1000n, unit, unit * 7n, unit * 37n, unit * 1_000n]) {
          const local = hopQuote({ pool, zeroForOne }, amount);
          const chainOut = await onchainQuote(pool, zeroForOne, amount);
          const label = `${pool.kind} ${pool.id} zf1=${zeroForOne} in=${amount}`;
          const { complete } = quoteExactInput({ ...pool.state, fee: clSwapFee(pool, zeroForOne) }, zeroForOne, amount);
          if (complete) {
            expect(local, label).toBe(chainOut);
            exact++;
          } else {
            // Past the loaded tick window the bot only counts what it can prove: never more than the chain.
            expect(local <= chainOut, label).toBe(true);
          }
        }
      }
    }
    expect(exact).toBeGreaterThanOrEqual(20);
    // Balanced market: nothing to do.
    expect(await bot.scan()).toHaveLength(0);
  });

  it("backruns a whale on Uniswap V3 and predicts the profit to the wei", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);
    const v3 = bot.registry.get(v3WethUsdc.toLowerCase() as Hex) as ClPool;
    const wethIs0 = v3.token0 === weth.toLowerCase();
    // Whale dumps 40 WETH into the V3 pool: WETH is now cheap there.
    await write(v3h, A.v3Helper.abi, "swapExactIn", [v3WethUsdc, wethIs0, parseEther("40"), whale.address]);

    const first = await bot.processBlock(await head());
    await bot.drain();
    expect(first.length).toBeGreaterThanOrEqual(1);
    for (const t of first) expect(t.simulatedProfit).toBe(t.opp.grossProfit);
    expect(first.some((t) => t.opp.cycle.hops.some((h) => h.pool.id === v3.id))).toBe(true);
    await runUntilQuiet(bot);

    expect(bot.stats.landed).toBe(bot.stats.sent);
    expect(bot.stats.realizedNetWei > 0n).toBe(true);
    expect((await balanceOf(weth, executor)) > before).toBe(true);
    expect(await client.getBalance({ address: executor })).toBe(0n);
  });

  it("arbitrages a native-ETH Uniswap V4 pool (wrapping/unwrapping in the executor)", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);
    // Whale buys ETH with USDC on V4: ETH is now expensive there.
    const usdcIs0 = v4EthUsdc.currency0 === usdc;
    await write(v4h, A.v4Helper.abi, "swapExactIn", [v4EthUsdc, usdcIs0, parseUnits("60000", 6), whale.address]);

    const trades = await runUntilQuiet(bot);
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades.some((t) => t.opp.cycle.hops.some((h) => h.pool.family === "cl" && h.pool.v4?.currency0 === ZERO))).toBe(true);
    for (const t of trades) expect(t.simulatedProfit).toBe(t.opp.grossProfit);
    const after = await balanceOf(weth, executor);
    expect(after > before).toBe(true);
    expect(await client.getBalance({ address: executor })).toBe(0n);
    // Realized PnL must count the executor's WETH wraps/unwraps around native-ETH hops.
    expect(bot.stats.landed).toBe(bot.stats.sent);
    const records = readFileSync(tradeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(-bot.stats.sent);
    const realized = records.reduce((sum, r) => sum + BigInt(r.realizedProfit), 0n);
    expect(realized).toBe(after - before);
  });

  it("routes three hops through a mispriced V4 ERC20 pool", async () => {
    const bot = new ArbBot(client, config(), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);
    // Someone apes WETH into TOSHI on V4: TOSHI is expensive there vs its V2 USDC pair.
    const wethIs0 = v4ToshiWeth.currency0 === weth;
    await write(v4h, A.v4Helper.abi, "swapExactIn", [v4ToshiWeth, wethIs0, parseEther("2"), whale.address]);

    const trades = await runUntilQuiet(bot);
    expect(trades.length).toBeGreaterThanOrEqual(1);
    const three = trades.find((t) => t.opp.cycle.hops.length === 3);
    expect(three, trades.map((t) => bot.describe(t.opp.cycle)).join(" | ")).toBeDefined();
    expect(bot.describe(three!.opp.cycle)).toContain("TOSHI");
    for (const t of trades) expect(t.simulatedProfit).toBe(t.opp.grossProfit);
    expect((await balanceOf(weth, executor)) > before).toBe(true);
  });

  it("follows Mint/Burn and ModifyLiquidity events to exactly the on-chain state", async () => {
    const bot = new ArbBot(client, config({ dryRun: true }), operator);
    await bot.init();
    const v3 = bot.registry.get(v3WethUsdc.toLowerCase() as Hex) as ClPool;
    const t = v3.state.tick;
    // New positions in range, partly in range, and burns of existing ones.
    await write(v3h, A.v3Helper.abi, "mint", [v3WethUsdc, align(t, 10) - 200, align(t, 10) + 300, 7n * 10n ** 15n]);
    await write(v3h, A.v3Helper.abi, "mint", [v3WethUsdc, align(t, 10) + 20, align(t, 10) + 2_000, 2n * 10n ** 15n]);
    await write(v3h, A.v3Helper.abi, "burn", [v3WethUsdc, align(t, 10) - 200, align(t, 10) + 300, 3n * 10n ** 15n]);
    const v4 = clPools(bot).find((p) => p.v4?.currency0 === ZERO)!;
    const t4 = v4.state.tick;
    await write(v4h, A.v4Helper.abi, "modifyLiquidity", [v4EthUsdc, align(t4, 60) - 600, align(t4, 60) + 600, 5n * 10n ** 15n]);
    await write(v4h, A.v4Helper.abi, "modifyLiquidity", [v4EthUsdc, align(t4, 60) - 600, align(t4, 60) + 600, -2n * 10n ** 15n]);
    await bot.processBlock(await head());
    await bot.drain();

    const fresh = new ArbBot(client, config({ dryRun: true }), operator);
    await fresh.init();
    for (const pool of clPools(bot)) {
      const truth = fresh.registry.get(pool.id) as ClPool;
      expect(pool.state.sqrtPriceX96).toBe(truth.state.sqrtPriceX96);
      expect(pool.state.tick).toBe(truth.state.tick);
      expect(pool.state.liquidity).toBe(truth.state.liquidity);
      const lo = Math.max(pool.state.wordLo, truth.state.wordLo);
      const hi = Math.min(pool.state.wordHi, truth.state.wordHi);
      const inWindow = (x: { tick: number }) => wordOf(x.tick, pool.state.tickSpacing) >= lo && wordOf(x.tick, pool.state.tickSpacing) <= hi;
      expect(pool.state.ticks.filter(inWindow)).toEqual(truth.state.ticks.filter(inWindow));
    }
  });

  it("trades on a Flashblock before the sealed block, without double-applying liquidity deltas", async () => {
    const bot = new ArbBot(client, config({ simulatePending: true }), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);
    const v3 = bot.registry.get(v3WethUsdc.toLowerCase() as Hex) as ClPool;
    const wethIs0 = v3.token0 === weth.toLowerCase();
    const t = v3.state.tick;

    // Two transactions the sequencer pre-confirms: a new in-range position (a liquidity delta) and a whale dump.
    const mint = await write(v3h, A.v3Helper.abi, "mint", [v3WethUsdc, align(t, 10) - 300, align(t, 10) + 300, 6n * 10n ** 15n]);
    const dump = await write(v3h, A.v3Helper.abi, "swapExactIn", [v3WethUsdc, wethIs0, parseEther("30"), whale.address]);
    const block = await client.getBlock({ blockNumber: dump.blockNumber });
    const txs = [mint, dump];
    const raw = await Promise.all(txs.map((r) => client.request({ method: "eth_getRawTransactionByHash", params: [r.transactionHash] } as never) as Promise<Hex>));
    const receipts = Object.fromEntries(
      txs.map((r) => [
        r.transactionHash,
        {
          Eip1559: {
            status: "0x1",
            cumulativeGasUsed: `0x${r.cumulativeGasUsed.toString(16)}`,
            logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
          },
        },
      ]),
    );
    // Shape of a Base flashblocks websocket message (FlashblocksPayloadV1).
    const message = {
      payload_id: "0x0000000000000001",
      index: 0,
      base: {
        parent_hash: block.parentHash,
        fee_recipient: block.miner,
        block_number: `0x${dump.blockNumber.toString(16)}`,
        gas_limit: `0x${block.gasLimit.toString(16)}`,
        timestamp: `0x${block.timestamp.toString(16)}`,
        base_fee_per_gas: `0x${(block.baseFeePerGas ?? 0n).toString(16)}`,
      },
      diff: { state_root: block.stateRoot, block_hash: block.hash, gas_used: `0x${block.gasUsed.toString(16)}`, transactions: raw, withdrawals: [] },
      metadata: { block_number: Number(dump.blockNumber), new_account_balances: {}, receipts },
    };

    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    server.on("connection", (socket) => socket.send(JSON.stringify(message)));
    const port = (server.address() as { port: number }).port;
    const pending: Promise<unknown>[] = [];
    const stream = new FlashblocksStream({
      url: `ws://127.0.0.1:${port}`,
      onFlashblock: (fb) => {
        pending.push(bot.processFlashblock(fb));
      },
    });
    try {
      stream.start();
      for (let i = 0; i < 200 && bot.stats.flashblocks === 0; i++) await new Promise((r) => setTimeout(r, 25));
      await Promise.all(pending);
      await bot.drain();
    } finally {
      stream.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Traded purely on the flashblock: no sealed block was processed yet.
    expect(bot.stats.flashblocks).toBe(1);
    expect(bot.stats.blocks).toBe(0);
    expect(bot.stats.landed).toBeGreaterThanOrEqual(1);
    expect((await balanceOf(weth, executor)) > before).toBe(true);

    // The sealed blocks now arrive: the Mint must not be applied a second time.
    await runUntilQuiet(bot);
    const fresh = new ArbBot(client, config({ dryRun: true }), operator);
    await fresh.init();
    const truth = fresh.registry.get(v3.id) as ClPool;
    expect(v3.state.liquidity).toBe(truth.state.liquidity);
    expect(v3.state.sqrtPriceX96).toBe(truth.state.sqrtPriceX96);
    const minted = (x: ClPool) => x.state.ticks.find((tk) => tk.tick === align(t, 10) - 300);
    expect(minted(v3)).toEqual(minted(truth));
  });

  it("trades on pendingLogs from a Flashblocks-aware RPC (the post-Azul path)", async () => {
    const bot = new ArbBot(client, config({ simulatePending: true }), operator);
    await bot.init();
    const before = await balanceOf(weth, executor);
    const v3 = bot.registry.get(v3WethUsdc.toLowerCase() as Hex) as ClPool;
    const wethIs0 = v3.token0 === weth.toLowerCase();
    const t = v3.state.tick;
    const mint = await write(v3h, A.v3Helper.abi, "mint", [v3WethUsdc, align(t, 10) - 500, align(t, 10) + 500, 4n * 10n ** 15n]);
    const dump = await write(v3h, A.v3Helper.abi, "swapExactIn", [v3WethUsdc, !wethIs0, parseUnits("90000", 6), whale.address]);

    // A Flashblocks-aware RPC: confirms eth_subscribe("pendingLogs") and streams matching logs one per message.
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const req = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xfb" }));
        const wanted = new Set<string>(req.params[1].topics[0]);
        for (const r of [mint, dump]) {
          for (const l of r.logs) {
            if (!l.topics[0] || !wanted.has(l.topics[0])) continue;
            const result = { ...l, blockNumber: `0x${dump.blockNumber.toString(16)}`, logIndex: `0x${(l.logIndex ?? 0).toString(16)}`, transactionIndex: "0x0", removed: false };
            delete (result as { blockHash?: unknown }).blockHash;
            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xfb", result } }, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
          }
        }
      });
    });
    const port = (server.address() as { port: number }).port;
    const pending: Promise<unknown>[] = [];
    const stream = new PendingLogsStream({ url: `ws://127.0.0.1:${port}`, topics: ALL_TOPICS, onBatch: (b) => pending.push(bot.processFlashblock(b)) });
    try {
      stream.start();
      for (let i = 0; i < 200 && bot.stats.flashblocks === 0; i++) await new Promise((r) => setTimeout(r, 25));
      await Promise.all(pending);
      await bot.drain();
    } finally {
      stream.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(bot.stats.flashblocks).toBe(1);
    expect(bot.stats.blocks).toBe(0);
    expect(bot.stats.landed).toBeGreaterThanOrEqual(1);
    expect((await balanceOf(weth, executor)) > before).toBe(true);

    await runUntilQuiet(bot);
    const fresh = new ArbBot(client, config({ dryRun: true }), operator);
    await fresh.init();
    const truth = fresh.registry.get(v3.id) as ClPool;
    expect(v3.state.liquidity).toBe(truth.state.liquidity);
    const minted = (x: ClPool) => x.state.ticks.find((tk) => tk.tick === align(t, 10) - 500);
    expect(minted(v3)).toEqual(minted(truth));
  });
});
