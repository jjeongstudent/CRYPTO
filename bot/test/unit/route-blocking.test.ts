import type { Address, Hex, PublicClient } from "viem";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { ArbBot } from "../../src/bot.js";
import type { BotConfig } from "../../src/config.js";
import type { SimulationResult } from "../../src/engine.js";
import type { CpPool, Cycle, Opportunity } from "../../src/types.js";

const E18 = 10n ** 18n;
const W = "0x00000000000000000000000000000000000000a1" as Address;
const A = "0x00000000000000000000000000000000000000b2" as Address;

function pool(n: number, reserve1: bigint): CpPool {
  return { family: "cp", id: `0x${n.toString(16).padStart(40, "0")}` as Hex, dex: "v2", kind: "v2", token0: W, token1: A, feeBps: 30, reserve0: 100n * E18, reserve1 };
}

const cfg: BotConfig = {
  chain: base,
  opStack: false,
  baseToken: W,
  weth: W,
  hubs: [W, A],
  extraTokens: [],
  dexes: [],
  executor: "0x00000000000000000000000000000000000000e1",
  dryRun: true,
  maxHops: 2,
  maxTradeWei: 10n * E18,
  minProfitWei: 0n,
  minPoolBaseWei: 0n,
  bidBps: 0,
  maxTxPerBlock: 1,
  discoverBlocks: 0,
  maxSpokes: 0,
  resyncEveryBlocks: 1_000,
  pollMs: 50,
  gasBase: 60_000n,
  gasPerHop: 75_000n,
  tradeLog: "/dev/null",
  clRangePct: 0.25,
  v4Hooks: [],
  simulatePending: false,
  skipSimulation: false,
};

/** A bot whose on-chain simulation returns whatever the test queues up. */
function botWith(results: SimulationResult[]) {
  const bot = new ArbBot({} as PublicClient, cfg, undefined, "0x00000000000000000000000000000000000000f1");
  bot.engine.simulate = async () => results.shift() ?? { ok: false, reason: "NotProfitable", benign: true };
  const cycle: Cycle = { id: 0, hops: [{ pool: pool(1, 300_000n * E18), zeroForOne: true }, { pool: pool(2, 270_000n * E18), zeroForOne: false }] };
  const opp: Opportunity = { cycle, amountIn: E18, amountOut: 2n * E18, grossProfit: E18 };
  const skipped = () => (bot as unknown as { skip: (c: Cycle) => boolean }).skip(cycle);
  return { bot, opp, skipped };
}

const lost: SimulationResult = { ok: false, reason: "NotProfitable", benign: true };
const reverted: SimulationResult = { ok: false, reason: "K", benign: false };
const ok: SimulationResult = { ok: true, profit: E18, gas: 200_000n };

describe("routes that keep failing simulation", () => {
  it("are set aside after repeated reverts", async () => {
    const { bot, opp, skipped } = botWith([reverted, reverted, reverted]);
    for (let i = 0; i < 2; i++) await bot.evaluate(opp, 0n);
    expect(skipped()).toBe(false);
    await bot.evaluate(opp, 0n);
    expect(skipped()).toBe(true);
  });

  it("are set aside after repeated 'not profitable' results the exact local quote contradicts", async () => {
    const { bot, opp, skipped } = botWith(Array(6).fill(lost));
    for (let i = 0; i < 5; i++) await bot.evaluate(opp, 0n);
    expect(skipped()).toBe(false); // occasional lost races are normal
    await bot.evaluate(opp, 0n);
    expect(skipped()).toBe(true);
  });

  it("reset their count after a successful simulation", async () => {
    const { bot, opp, skipped } = botWith([...Array(5).fill(lost), ok, ...Array(5).fill(lost)]);
    for (let i = 0; i < 11; i++) await bot.evaluate(opp, 0n);
    expect(skipped()).toBe(false);
  });

  it("are retried once the set-aside period has passed", async () => {
    const { bot, opp, skipped } = botWith([reverted, reverted, reverted]);
    for (let i = 0; i < 3; i++) await bot.evaluate(opp, 0n);
    expect(skipped()).toBe(true);
    bot.lastBlock = 1_799n;
    expect(skipped()).toBe(true);
    bot.lastBlock = 1_800n;
    expect(skipped()).toBe(false);
  });
});
