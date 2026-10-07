import { existsSync } from "node:fs";
import { type Address, type PublicClient, createPublicClient, formatEther, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aerodromeFactoryAbi, erc20Abi, v2FactoryAbi } from "./abi.js";
import { ArbBot, readExecutorRoles } from "./bot.js";
import { PRESETS } from "./chains.js";
import { type BotConfig, loadConfig, loadSecrets } from "./config.js";
import { shortError } from "./engine.js";
import { log } from "./log.js";

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
    let pool: Address | undefined;
    try {
      pool =
        dex.kind === "aerodrome"
          ? await client.readContract({ address: dex.factory, abi: aerodromeFactoryAbi, functionName: "getPool", args: [cfg.baseToken, usdc, false] })
          : await client.readContract({ address: dex.factory, abi: v2FactoryAbi, functionName: "getPair", args: [cfg.baseToken, usdc] });
    } catch {
      pool = undefined;
    }
    const hasPool = !!pool && pool !== ZERO_ADDRESS;
    if (!hasCode) missing++;
    const status = !hasCode ? "FAIL (no contract at factory address)" : hasPool ? "OK" : "WARN (factory found, but no WETH/USDC pool)";
    console.log(`dex          ${dex.name.padEnd(16)} ${status} factory=${dex.factory}${hasPool ? ` WETH/USDC=${pool}` : ""}`);
  }

  if (cfg.executor) {
    const roles = await readExecutorRoles(client, cfg.executor);
    const balance = await client.readContract({ address: cfg.baseToken, abi: erc20Abi, functionName: "balanceOf", args: [cfg.executor] });
    console.log(`executor     ${cfg.executor} owner=${roles.owner} operator=${roles.operator}`);
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

main().catch((err) => {
  log.error(shortError(err));
  process.exit(1);
});
