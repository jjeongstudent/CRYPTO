/**
 * Parity: src/clmath.ts against the real Uniswap V3 code on a real EVM (anvil).
 *
 * The real v3-core libraries are exposed through contracts/test/harness/V3Harness.sol and real
 * UniswapV3Pools are created through the real UniswapV3Factory. Every comparison requires exact
 * equality (or both sides reverting).
 *
 * Needs `anvil` on PATH (or ANVIL_BIN) and compiled contracts (`cd ../contracts && forge build`);
 * ARTIFACTS_DIR overrides the forge out/ directory.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClState,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  applyLiquidityDelta,
  computeSwapStepExactIn,
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  quoteExactInput,
  wordOf,
} from "../../src/clmath.js";

const ANVIL = process.env.ANVIL_BIN ?? "anvil";
const anvilAvailable = spawnSync(ANVIL, ["--version"]).status === 0;
const OUT = process.env.ARTIFACTS_DIR ?? new URL("../../../contracts/out/", import.meta.url).pathname;
const PORT = 20545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const path = join(OUT, file, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}; run "forge build" in contracts/ first`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
  const bits = (n: number): bigint => {
    let v = 0n;
    for (let i = 0; i < n; i += 32) v = (v << 32n) | BigInt(Math.floor(next() * 2 ** 32));
    return v & ((1n << BigInt(n)) - 1n);
  };
  /** Log-uniform-ish: a random bit length in [minBits, maxBits], then random bits below it. */
  const big = (minBits: number, maxBits: number): bigint => {
    const n = int(minBits, maxBits);
    return n === 0 ? 0n : (1n << BigInt(n - 1)) | bits(n - 1);
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  return { next, int, bits, big, pick };
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

function ts<T>(f: () => T): Outcome<T> {
  try {
    return { ok: true, value: f() };
  } catch {
    return { ok: false };
  }
}

async function chainCall<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    // Only an EVM revert counts as "both revert"; transport errors must fail the test.
    if (err instanceof BaseError && /revert/i.test(err.message)) return { ok: false };
    throw err;
  }
}

/** Run async jobs in parallel chunks (the transport batches each chunk into few HTTP requests). */
async function inChunks<T, R>(items: readonly T[], size: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return results;
}

const POOL_KINDS = [
  { fee: 100, spacing: 1 },
  { fee: 500, spacing: 10 },
  { fee: 3000, spacing: 60 },
  { fee: 10000, spacing: 200 },
] as const;

describe.skipIf(!anvilAvailable)("clmath parity with real Uniswap V3 on anvil", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  const wallet = createWalletClient({ chain, transport: http(RPC) });

  const A = {
    factory: artifact("UniswapV3Factory.sol", "UniswapV3Factory"),
    math: artifact("V3Harness.sol", "V3MathHarness"),
    poolHarness: artifact("V3Harness.sol", "V3PoolHarness"),
  };
  let factory: Address;
  let math: Address;

  /** Anvil automines on submission; poll the receipt directly (viem's block watcher is slow / flaky here). */
  async function receipt(hash: Hex) {
    for (let i = 0; ; i++) {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (err) {
        if (i > 200) throw err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }

  async function deploy(art: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: owner });
    const r = await receipt(hash);
    expect(r.status).toBe("success");
    return r.contractAddress!;
  }

  async function write(address: Address, abi: Abi, functionName: string, args: unknown[]) {
    // Simulate first so a revert fails with its reason.
    await client.simulateContract({ address, abi, functionName, args, account: owner } as never);
    // Explicit gas: anvil's estimate can leave too little for the SSTORE stipend check after nested calls.
    const hash = await wallet.writeContract({ address, abi, functionName, args, account: owner, gas: 500_000_000n } as never);
    expect((await receipt(hash)).status).toBe("success");
  }

  const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const mathCall = <T>(functionName: string, args: unknown[]) => chainCall(read<T>(math, A.math.abi, functionName, args));

  beforeAll(async () => {
    anvil = spawn(
      ANVIL,
      ["--port", String(PORT), "--silent", "--disable-code-size-limit", "--gas-limit", "4000000000"],
      { stdio: "ignore" },
    );
    client = createPublicClient({ chain, transport: http(RPC, { batch: { batchSize: 200 } }) });
    for (let i = 0; i < 100; i++) {
      try {
        await client.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    factory = await deploy(A.factory);
    // Not enabled by default in v3-core's factory.
    await write(factory, A.factory.abi, "enableFeeAmount", [100, 1]);
    math = await deploy(A.math);
  });

  afterAll(() => {
    anvil?.kill();
  });

  // -------------------------------------------------------------------------------------------------
  // Libraries

  it("getSqrtRatioAtTick / getTickAtSqrtRatio match TickMath", async () => {
    const r = rng(1);
    const ticks = new Set<number>([MIN_TICK, MAX_TICK, MIN_TICK + 1, MAX_TICK - 1, 0, 1, -1, 2, -2]);
    for (let b = 0; b < 20; b++) for (const t of [1 << b, (1 << b) - 1, (1 << b) + 1]) {
      if (t <= MAX_TICK) ticks.add(t).add(-t);
    }
    for (const s of [1, 10, 60, 200]) for (let k = -5; k <= 5; k++) {
      ticks.add(s * 256 * k).add(Math.trunc(MAX_TICK / s) * s).add(-Math.trunc(MAX_TICK / s) * s);
    }
    while (ticks.size < 2500) ticks.add(r.int(MIN_TICK, MAX_TICK));
    for (let i = 0; i < 500; i++) ticks.add(r.int(-1000, 1000));
    const tickList = [...ticks];

    const sqrtResults = await inChunks(tickList, 200, (t) => mathCall<bigint>("getSqrtRatioAtTick", [t]));
    tickList.forEach((t, i) => expect(ts(() => getSqrtRatioAtTick(t)), `tick ${t}`).toEqual(sqrtResults[i]));
    for (const t of [MIN_TICK - 1, MAX_TICK + 1]) {
      expect((await mathCall("getSqrtRatioAtTick", [t])).ok).toBe(false);
      expect(ts(() => getSqrtRatioAtTick(t)).ok).toBe(false);
    }

    // Prices on, just below and just above tick boundaries, out-of-range edges, and random prices.
    const prices = new Set<bigint>([MIN_SQRT_RATIO - 1n, MIN_SQRT_RATIO, MIN_SQRT_RATIO + 1n, MAX_SQRT_RATIO - 1n, MAX_SQRT_RATIO]);
    for (const t of tickList) {
      const p = getSqrtRatioAtTick(t);
      prices.add(p).add(p - 1n).add(p + 1n);
    }
    for (let i = 0; i < 2000; i++) prices.add(MIN_SQRT_RATIO + (r.big(1, 160) % (MAX_SQRT_RATIO - MIN_SQRT_RATIO)));
    const priceList = [...prices];
    const tickResults = await inChunks(priceList, 200, (p) => mathCall<number>("getTickAtSqrtRatio", [p]));
    priceList.forEach((p, i) => expect(ts(() => getTickAtSqrtRatio(p)), `price ${p}`).toEqual(tickResults[i]));
    console.log(`TickMath: ${tickList.length + 2} ticks, ${priceList.length} prices compared`);
  });

  it("getAmount0Delta / getAmount1Delta / getNextSqrtPriceFromInput match SqrtPriceMath", async () => {
    const r = rng(2);
    const price = () =>
      r.next() < 0.5 ? getSqrtRatioAtTick(r.int(MIN_TICK, MAX_TICK)) : MIN_SQRT_RATIO + (r.big(1, 160) % (MAX_SQRT_RATIO - MIN_SQRT_RATIO));
    const liquidity = () => r.pick([0n, 1n, (1n << 128n) - 1n, r.big(1, 128), r.big(1, 128), r.big(40, 90)]);
    const amount = () => r.pick([0n, 1n, (1n << 256n) - 1n, (1n << 160n) - 1n, 1n << 160n, r.big(1, 256), r.big(1, 128), r.big(1, 80)]);

    const deltaCases = Array.from({ length: 1500 }, () => [price(), price(), liquidity(), r.next() < 0.5] as const);
    const d0 = await inChunks(deltaCases, 200, (c) => mathCall<bigint>("getAmount0Delta", [...c]));
    const d1 = await inChunks(deltaCases, 200, (c) => mathCall<bigint>("getAmount1Delta", [...c]));
    deltaCases.forEach((c, i) => {
      expect(ts(() => getAmount0Delta(...c)), `getAmount0Delta ${c}`).toEqual(d0[i]);
      expect(ts(() => getAmount1Delta(...c)), `getAmount1Delta ${c}`).toEqual(d1[i]);
    });

    const nextCases = Array.from({ length: 2000 }, () => [price(), liquidity(), amount(), r.next() < 0.5] as const);
    const next = await inChunks(nextCases, 200, (c) => mathCall<bigint>("getNextSqrtPriceFromInput", [...c]));
    let reverts = 0;
    nextCases.forEach((c, i) => {
      if (!next[i]!.ok) reverts++;
      expect(ts(() => getNextSqrtPriceFromInput(...c)), `getNextSqrtPriceFromInput ${c}`).toEqual(next[i]);
    });
    console.log(`SqrtPriceMath: ${deltaCases.length * 2} deltas, ${nextCases.length} next prices (${reverts} reverting) compared`);
  });

  it("computeSwapStepExactIn matches SwapMath.computeSwapStep", async () => {
    const r = rng(3);
    const price = () => getSqrtRatioAtTick(r.int(MIN_TICK, MAX_TICK)) + (r.next() < 0.5 ? r.bits(20) : 0n);
    const cases = Array.from({ length: 3000 }, () => {
      const cur = price();
      // Mostly nearby targets (the realistic case), sometimes anywhere, sometimes equal.
      const near = getSqrtRatioAtTick(Math.min(Math.max(getTickAtSqrtRatio(cur) + r.int(-3000, 3000), MIN_TICK), MAX_TICK));
      const target = r.pick([near, near, price(), cur]);
      const liquidity = r.pick([0n, 1n, (1n << 128n) - 1n, r.big(1, 128), r.big(30, 100), r.big(30, 100)]);
      const amount = r.pick([0n, 1n, (1n << 255n) - 1n, r.big(1, 255), r.big(1, 128), r.big(1, 90), r.big(1, 64)]);
      const fee = r.pick([0, 1, 100, 500, 3000, 10000, 100_000, 500_000, 999_999, r.int(0, 999_999)]);
      return [cur, target, liquidity, amount, fee] as const;
    });
    const chain = await inChunks(cases, 200, (c) =>
      mathCall<readonly [bigint, bigint, bigint, bigint]>("computeSwapStep", [...c]),
    );
    cases.forEach((c, i) => {
      const got = ts(() => {
        const s = computeSwapStepExactIn(...c);
        return [s.sqrtPriceNextX96, s.amountIn, s.amountOut, s.feeAmount];
      });
      expect(got, `computeSwapStep ${c}`).toEqual(chain[i]);
    });
    console.log(`SwapMath: ${cases.length} steps compared`);
  });

  // -------------------------------------------------------------------------------------------------
  // Real pools

  interface Pool {
    harness: Address;
    fee: number;
    spacing: number;
  }

  async function createPool(fee: number, spacing: number, sqrtPriceX96: bigint): Promise<Pool> {
    const harness = await deploy(A.poolHarness, [factory, fee, sqrtPriceX96]);
    return { harness, fee, spacing };
  }

  /** Full pool state read from chain; word ranges are read in chunks to bound eth_call gas. */
  async function snapshot(pool: Pool, wordLo = wordOf(MIN_TICK, pool.spacing), wordHi = wordOf(MAX_TICK, pool.spacing)) {
    type Snap = readonly [bigint, number, bigint, readonly number[], readonly bigint[], readonly bigint[]];
    const ranges: [number, number][] = [];
    for (let w = wordLo; w <= wordHi; w += 512) ranges.push([w, Math.min(w + 511, wordHi)]);
    if (ranges.length === 0) ranges.push([1, 0]); // empty range: slot0 + liquidity only
    const snaps = await Promise.all(ranges.map((rg) => read<Snap>(pool.harness, A.poolHarness.abi, "snapshot", rg)));
    const first = snaps[0]!;
    const state: ClState = {
      sqrtPriceX96: first[0],
      tick: first[1],
      liquidity: first[2],
      tickSpacing: pool.spacing,
      fee: pool.fee,
      ticks: snaps.flatMap((s) => s[3].map((tick, i) => ({ tick, liquidityGross: s[4][i]!, liquidityNet: s[5][i]! }))),
      wordLo,
      wordHi,
    };
    return state;
  }

  const swapCall = (pool: Pool, zeroForOne: boolean, amountIn: bigint) =>
    chainCall(
      client
        .simulateContract({
          address: pool.harness,
          abi: A.poolHarness.abi,
          functionName: "swapExactIn",
          args: [zeroForOne, amountIn],
          account: owner,
        } as never)
        .then((s) => (s as { result: readonly [bigint, bigint, bigint, number, bigint] }).result),
    );

  /** Random tick on the pool's spacing within `words` bitmap words of `center`. */
  function randomTick(r: ReturnType<typeof rng>, pool: Pool, center: number, words: number): number {
    const span = pool.spacing * 256 * words;
    const lo = Math.max(MIN_TICK, center - span);
    const hi = Math.min(MAX_TICK, center + span);
    const t = Math.round(r.int(lo, hi) / pool.spacing) * pool.spacing;
    return Math.min(Math.max(t, Math.ceil(MIN_TICK / pool.spacing) * pool.spacing), Math.floor(MAX_TICK / pool.spacing) * pool.spacing);
  }

  interface Position {
    lower: number;
    upper: number;
    liquidity: bigint;
  }

  /** Mint (or burn) on chain and mirror it in `state` with applyLiquidityDelta. */
  async function modify(pool: Pool, state: ClState, positions: Position[], lower: number, upper: number, delta: bigint) {
    if (delta > 0n) {
      await write(pool.harness, A.poolHarness.abi, "mint", [lower, upper, delta]);
      positions.push({ lower, upper, liquidity: delta });
    } else {
      await write(pool.harness, A.poolHarness.abi, "burn", [lower, upper, -delta]);
    }
    applyLiquidityDelta(state, lower, upper, delta);
  }

  /** Builds a pool with overlapping, tick-sharing, zero-net and burned positions; checks applyLiquidityDelta throughout. */
  async function populatedPool(seed: number, fee: number, spacing: number, fullRange: boolean) {
    const r = rng(seed);
    const startTick = r.int(-20_000, 20_000);
    const start = getSqrtRatioAtTick(startTick) + r.bits(40);
    const pool = await createPool(fee, spacing, start);
    const state = await snapshot(pool);
    const positions: Position[] = [];
    const words = spacing === 1 ? 12 : 6;
    const shared = Array.from({ length: 10 }, () => randomTick(r, pool, startTick, words));
    const tick = () => (r.next() < 0.4 ? r.pick(shared) : randomTick(r, pool, startTick, words));
    const liq = () => r.big(10, 85);

    if (fullRange) {
      const lo = Math.ceil(MIN_TICK / spacing) * spacing;
      const hi = Math.floor(MAX_TICK / spacing) * spacing;
      await modify(pool, state, positions, lo, hi, r.big(40, 70));
    }
    for (let i = 0; i < 36; i++) {
      let a = tick();
      let b = tick();
      if (a === b) b = a + spacing * r.int(1, 50);
      if (a > b) [a, b] = [b, a];
      if (b > MAX_TICK) continue;
      await modify(pool, state, positions, a, b, liq());
    }
    // Adjacent ranges with equal liquidity: the shared tick has liquidityNet 0 but stays initialized.
    for (let i = 0; i < 4; i++) {
      const a = randomTick(r, pool, startTick, words);
      const b = a + spacing * r.int(1, 300);
      const c = b + spacing * r.int(1, 300);
      if (c > MAX_TICK) continue;
      const l = liq();
      await modify(pool, state, positions, a, b, l);
      await modify(pool, state, positions, b, c, l);
    }
    // Burn some positions back to zero and some partially.
    for (const p of positions.filter(() => r.next() < 0.3)) {
      const amount = r.next() < 0.6 ? p.liquidity : p.liquidity / 2n;
      await modify(pool, state, positions, p.lower, p.upper, -amount);
      p.liquidity -= amount;
    }
    expect(state).toEqual(await snapshot(pool));
    return { pool, state, positions, r, startTick };
  }

  for (const [k, { fee, spacing }] of POOL_KINDS.entries()) {
    for (const fullRange of [false, true]) {
      it(`exact-input swaps match UniswapV3Pool.swap (fee ${fee}, spacing ${spacing}${fullRange ? ", with full-range liquidity" : ""})`, async () => {
        const { pool, state: initial, positions, r, startTick } = await populatedPool(100 + k * 2 + Number(fullRange), fee, spacing, fullRange);
        let state = initial;
        let compared = 0;
        let crossed = 0;
        let mints = 0;
        let windowStops = 0;
        for (let i = 0; i < 120; i++) {
          const zeroForOne = r.next() < 0.5;
          const amountIn = r.pick([1n, r.big(1, 20), r.big(20, 60), r.big(40, 80), r.big(60, 100), r.big(90, 130), r.big(150, 250)]);
          const tsQuote = quoteExactInput(state, zeroForOne, amountIn);
          const onChain = await swapCall(pool, zeroForOne, amountIn);
          const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
          if (state.sqrtPriceX96 === limit) {
            // The pool rejects a swap from the limit ('SPL'); clmath quotes nothing.
            expect(onChain.ok).toBe(false);
            expect(tsQuote.amountIn).toBe(0n);
            continue;
          }
          expect(tsQuote.complete).toBe(true);
          expect(onChain, `swap #${i} ${zeroForOne ? "0->1" : "1->0"} ${amountIn}`).toEqual({
            ok: true,
            value: [tsQuote.amountIn, tsQuote.amountOut, tsQuote.sqrtPriceX96, tsQuote.tick, tsQuote.liquidity],
          });
          compared++;
          crossed += tsQuote.ticksCrossed;

          // Window guard: with only a few words around the current tick known, the quote must stop at
          // the window edge, never give more than the full quote, and equal a full quote of what it used.
          const w = wordOf(state.tick, spacing);
          const windowed = quoteExactInput({ ...state, wordLo: w - r.int(0, 2), wordHi: w + r.int(0, 2) }, zeroForOne, amountIn);
          if (windowed.complete) expect(windowed).toEqual(tsQuote);
          else {
            expect(windowed.amountOut <= tsQuote.amountOut && windowed.amountIn < amountIn).toBe(true);
            // Replaying just the consumed input gives the same output (the window may additionally have
            // moved the price through input-free, zero-liquidity steps).
            const replay = quoteExactInput(state, zeroForOne, windowed.amountIn);
            expect(replay.amountOut).toBe(windowed.amountOut);
            expect(zeroForOne ? windowed.sqrtPriceX96 <= replay.sqrtPriceX96 : windowed.sqrtPriceX96 >= replay.sqrtPriceX96).toBe(true);
            windowStops++;
          }

          // Move the pool (but not onto the limit) so later swaps start from many different states.
          if (r.next() < 0.5 && tsQuote.sqrtPriceX96 !== limit) {
            await write(pool.harness, A.poolHarness.abi, "swapExactIn", [zeroForOne, amountIn]);
            state = { ...state, ...(await snapshot(pool, 1, 0)), ticks: state.ticks, wordLo: state.wordLo, wordHi: state.wordHi };
            expect([state.sqrtPriceX96, state.tick, state.liquidity]).toEqual([tsQuote.sqrtPriceX96, tsQuote.tick, tsQuote.liquidity]);
          }

          // Occasionally add or remove liquidity at the current price and check the mirrored state.
          if (i % 10 === 9) {
            const live = positions.filter((p) => p.liquidity > 0n);
            if (r.next() < 0.5 && live.length > 0) {
              const p = r.pick(live);
              const amount = r.next() < 0.5 ? p.liquidity : r.big(1, 10) % p.liquidity || 1n;
              await modify(pool, state, positions, p.lower, p.upper, -amount);
              p.liquidity -= amount;
            } else {
              const a = randomTick(r, pool, state.tick, 1) - spacing * r.int(1, 30);
              const b = randomTick(r, pool, state.tick, 1) + spacing * r.int(1, 30);
              if (a >= MIN_TICK && b <= MAX_TICK && a < b) await modify(pool, state, positions, a, b, r.big(10, 80));
            }
            mints++;
            expect(state).toEqual(await snapshot(pool));
          }
        }
        console.log(`pool fee ${fee}/${spacing}${fullRange ? " full-range" : ""} from tick ${startTick}: ${compared} swaps compared, ${crossed} tick crossings, ${state.ticks.length} ticks, ${mints} liquidity changes re-read, ${windowStops} window stops`);
        expect(compared).toBeGreaterThan(80);
      }, 600_000);
    }
  }
});
