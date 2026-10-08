import { existsSync } from "node:fs";
import { type Address, type PublicClient, createPublicClient, formatEther, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aerodromeFactoryAbi, erc20Abi, executorAbi, v2FactoryAbi } from "./abi.js";
import { ArbBot, readExecutorRoles } from "./bot.js";
import { PRESETS } from "./chains.js";
import { candidateV4Keys, loadV4Pools, slipstreamFactoryAbi, v3FactoryAbi } from "./concentrated.js";
import { type BotConfig, loadConfig, loadSecrets } from "./config.js";
import { shortError } from "./engine.js";
import { ALL_TOPICS } from "./events.js";
import { log } from "./log.js";
import { PendingLogsStream } from "./pendingLogs.js";
import { DEFAULT_V4_KEYS, poolManagerOf } from "./pools.js";
import type { DexConfig } from "./types.js";

const USAGE = `usage: tsx src/main.ts <check|scan|run>
  check  verify RPC, DEX factories, executor roles and balances
  scan   find current opportunities once and print them (never trades)
  run    watch every block and trade (dry-run unless DRY_RUN=false)`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !["check", "scan", "run"].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
  if (existsSync(".env")) process.loadEnvFile(".env");

  const cfg = loadConfig();
  const secrets = loadSecrets();
  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(secrets.rpcUrl, { retryCount: 2, timeout: 10_000 }),
  }) as PublicClient;
  const account = secrets.privateKey ? privateKeyToAccount(secrets.privateKey) : undefined;

  const chainId = await client.getChainId();
  if (chainId !== cfg.chain.id) throw new Error(`RPC is on chain ${chainId}, expected ${cfg.chain.id} (${cfg.chain.name})`);

  // Simulations are sent "from" the executor's operator, so dry-runs work even without the key.
  let simulateFrom: Address | undefined = account?.address;
  if (cfg.executor) {
    const roles = await readExecutorRoles(client, cfg.executor);
    simulateFrom = roles.operator;
    if (account && getAddress(roles.operator) !== account.address) {
      throw new Error(`PRIVATE_KEY is ${account.address} but the executor's operator is ${roles.operator}`);
    }
  }

  if (command === "check") return check(cfg, client, account?.address);

  const bot = new ArbBot(client, cfg, account, simulateFrom);

  if (command === "scan") {
    await bot.init();
    const results = await bot.scan(25);
    if (results.length === 0) {
      console.log("\nNo opportunities clear the profit floor right now. That is normal; run the bot and let it watch every block.");
      return;
    }
    console.log(`\nTop opportunities right now (${bot.engine.canSimulate ? "simulated on-chain" : "estimated, no executor configured"}):\n`);
    for (const r of results) {
      console.log(
        `  net ${formatEther(r.costs.net).padEnd(24)} gross ${formatEther(r.simulatedProfit ?? r.opp.grossProfit).padEnd(24)} in ${formatEther(r.opp.amountIn).padEnd(22)} ${bot.describe(r.opp.cycle)}`,
      );
    }
    return;
  }

  if (!cfg.dryRun) {
    if (!account) throw new Error("DRY_RUN=false requires PRIVATE_KEY (the executor's operator key)");
    if (!cfg.executor) throw new Error("DRY_RUN=false requires EXECUTOR_ADDRESS (deploy contracts/src/Executor.sol first)");
  }
  await bot.init();
  const shutdown = () => {
    log.info("shutting down after in-flight trades settle…");
    bot.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await bot.run();
  log.info("final stats", { ...bot.stats, realizedNetEth: formatEther(bot.stats.realizedNetWei) });
}

async function check(cfg: BotConfig, client: PublicClient, operator?: Address): Promise<void> {
  const preset = PRESETS[process.env.CHAIN ?? "base"]!;
  const usdc = (preset.hubs.USDC ?? Object.values(preset.hubs)[1]!).toLowerCase() as Address;
  console.log(`chain        ${cfg.chain.name} (${cfg.chain.id}), block ${await client.getBlockNumber()}`);

  let missing = 0;
  for (const dex of cfg.dexes) {
    const code = await client.getCode({ address: dex.factory });
    const hasCode = !!code && code !== "0x";
    const pool = hasCode ? await findWethUsdcPool(client, cfg, dex, usdc).catch(() => undefined) : undefined;
    if (!hasCode) missing++;
    const status = !hasCode ? "FAIL (no contract at factory address)" : pool ? "OK" : "WARN (contract found, but no WETH/USDC pool)";
    console.log(`dex          ${dex.name.padEnd(20)} ${status} ${dex.kind === "v4" ? "poolManager" : "factory"}=${dex.factory}${pool ? ` WETH/USDC=${pool}` : ""}`);
  }
  if (cfg.flashblocksRpcWs) console.log(`flashblocks  ${cfg.flashblocksRpcWs}: ${await probePendingLogs(cfg.flashblocksRpcWs)}`);
  else if (cfg.flashblocksWs) console.log(`flashblocks  ${cfg.flashblocksWs} (raw stream; logs only if it carries receipts)`);
  if (cfg.flashblocksRpcWs || cfg.flashblocksWs) console.log(`             simulating against ${cfg.simulatePending ? "pending" : "latest"} state`);

  if (cfg.executor) {
    const roles = await readExecutorRoles(client, cfg.executor);
    const balance = await client.readContract({ address: cfg.baseToken, abi: erc20Abi, functionName: "balanceOf", args: [cfg.executor] });
    const [poolManager, weth] = await Promise.all([
      client.readContract({ address: cfg.executor, abi: executorAbi, functionName: "poolManager" }),
      client.readContract({ address: cfg.executor, abi: executorAbi, functionName: "weth" }),
    ]);
    console.log(`executor     ${cfg.executor} owner=${roles.owner} operator=${roles.operator}`);
    console.log(`             poolManager=${poolManager} weth=${weth}`);
    const v4 = poolManagerOf(cfg);
    if (v4 && poolManager.toLowerCase() !== v4) console.log("             WARN executor's poolManager differs from the configured V4 PoolManager; V4 routes will revert");
    console.log(`inventory    ${formatEther(balance)} WETH in executor`);
  } else {
    console.log("executor     not configured (scan/run will paper-trade with estimated gas)");
  }
  if (operator) console.log(`operator     ${operator} holds ${formatEther(await client.getBalance({ address: operator }))} ETH for gas`);
  console.log(`mode         ${cfg.dryRun ? "DRY-RUN (set DRY_RUN=false to trade)" : "LIVE"}`);
  if (missing > 0) {
    console.log(`\n${missing} factory address(es) have no contract; those DEXes are skipped at runtime. Fix the address or set DISABLE_DEXES.`);
  }
}

/** Opens a real pendingLogs subscription and reports whether the endpoint accepts it and streams logs. */
async function probePendingLogs(url: string): Promise<string> {
  return new Promise((resolve) => {
    let subscribed = false;
    const stream = new PendingLogsStream({
      url,
      topics: ALL_TOPICS,
      batchMs: 1,
      onBatch: (b) => finish(`OK (subscribed; pool events for pending block ${b.blockNumber} received)`),
      onStatus: (status, detail) => {
        if (status === "open") subscribed = true;
        else if (status === "error" && detail?.includes("rejected")) finish(`FAIL (${detail}); use a Flashblocks-aware RPC`);
      },
    });
    const timer = setTimeout(() => finish(subscribed ? "WARN (subscribed, but no pool events within 10s)" : "FAIL (could not subscribe within 10s)"), 10_000);
    function finish(result: string) {
      clearTimeout(timer);
      stream.stop();
      resolve(result);
    }
    stream.start();
  });
}

/** Looks up a WETH/USDC pool on any venue type, to prove the address really is that DEX. */
async function findWethUsdcPool(client: PublicClient, cfg: BotConfig, dex: DexConfig, usdc: Address): Promise<string | undefined> {
  const found = (address: Address) => (address !== ZERO_ADDRESS ? address : undefined);
  switch (dex.kind) {
    case "v2":
      return found(await client.readContract({ address: dex.factory, abi: v2FactoryAbi, functionName: "getPair", args: [cfg.baseToken, usdc] }));
    case "aerodrome":
      return found(await client.readContract({ address: dex.factory, abi: aerodromeFactoryAbi, functionName: "getPool", args: [cfg.baseToken, usdc, false] }));
    case "v3":
    case "pancakeV3":
      for (const fee of dex.feeTiers ?? [500, 3000]) {
        const pool = await client.readContract({ address: dex.factory, abi: v3FactoryAbi, functionName: "getPool", args: [cfg.baseToken, usdc, fee] });
        if (found(pool)) return pool;
      }
      return undefined;
    case "slipstream": {
      const spacings = await client.readContract({ address: dex.factory, abi: slipstreamFactoryAbi, functionName: "tickSpacings" });
      for (const spacing of spacings) {
        const pool = await client.readContract({ address: dex.factory, abi: slipstreamFactoryAbi, functionName: "getPool", args: [cfg.baseToken, usdc, spacing] });
        if (found(pool)) return pool;
      }
      return undefined;
    }
    case "v4": {
      const pools = await loadV4Pools(client, dex, candidateV4Keys([[cfg.weth, usdc]], dex.v4Keys ?? DEFAULT_V4_KEYS, cfg.weth), cfg.weth);
      return pools[0] ? `pool id ${pools[0].id}` : undefined;
    }
  }
}

main().catch((err) => {
  log.error(shortError(err));
  process.exit(1);
});
