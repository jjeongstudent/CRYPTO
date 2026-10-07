# Base Arb Bot

An atomic cyclic-arbitrage ("backrun") bot for **Base**. When a swap knocks one pool's price out of
line with the others, the bot buys on the cheap pool and sells on the expensive one in a single
transaction, ending with more WETH than it started with or reverting.

- **Venues:** Uniswap V2, SushiSwap V2, PancakeSwap V2, BaseSwap, Aerodrome (volatile pools)
- **Routes:** 2-hop (DEX vs DEX) and 3-hop triangles (e.g. `WETH → USDC → TOKEN → WETH`)
- **Long tail:** discovers actively traded tokens on its own from recent swaps. Fewer competitors watch those pools than the blue-chip ones.
- **Sizing:** closed-form optimal trade size for the whole route, checked against brute force in tests
- **Execution:** live simulation → gas + L1-fee accounting → priority-fee bid → locally signed tx

## Why Base

Gas on Base costs fractions of a cent, so arbitrage worth a few cents is still profitable after
fees. On Ethereum mainnet the same trades are wiped out by gas and builder bribes. Base has no
public mempool, so "backrunning" here means reacting to every new block's state changes faster
and bidding smarter than other bots. That is what this does.

## What you can lose (and what you can't)

The executor contract is built so that **a trade can never reduce its WETH balance**. Every route
starts and ends in WETH, and the contract reverts unless its balance went up by at least
`minProfit`. It never grants token approvals and never accepts callbacks. Even a **stolen operator
key cannot drain the inventory**. Only the separate owner key can withdraw, and there's a test
that proves it (`test_leakedOperatorKeyCannotDrainInventory`).

What you *can* lose is **gas on transactions that revert** (when another bot wins the race between
simulation and inclusion) and the opportunity cost of the WETH sitting in the contract. The bot
simulates every trade before sending it, so reverts happen only on lost races. Each one costs a
fraction of a cent on Base.

**Profit is not guaranteed.** This is a competitive market. Whether it makes money depends on your
RPC latency, your bid, and how crowded the routes are. That's why it runs in paper mode first and
logs every trade, so you can see real numbers before risking anything.

## Quick start

Requirements: Node 22+, [Foundry](https://book.getfoundry.sh/getting-started/installation), and a Base RPC
(a paid endpoint is strongly recommended; the bot reads logs every block).

```bash
git clone --recurse-submodules <this repo> && cd CRYPTO
cd contracts && forge build && forge test && cd ..
cd bot && npm install && cp .env.example .env   # then set RPC_URL in bot/.env
```

### 1. Paper-trade: no contract, no key, no money

```bash
npm run check   # verifies RPC + every DEX factory address on-chain
npm run scan    # one-shot: what's profitable right now (estimated)
npm start       # watches every block, logs PAPER opportunities to logs/trades.jsonl
```

Let it run for a few hours. `logs/trades.jsonl` shows what it would have made after gas.

### 2. Deploy the executor

Use two wallets: an **owner** (cold, it can withdraw) and an **operator** (hot, the bot's key, holding only gas money).

```bash
cd contracts
OWNER=0xYourColdWallet OPERATOR=0xBotHotWallet \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_KEY --broadcast
```

### 3. Fund it

```bash
WETH=0x4200000000000000000000000000000000000006
# wrap ETH -> WETH, then send it to the executor (from the owner wallet)
cast send $WETH "deposit()" --value 1ether --rpc-url $RPC_URL --private-key $OWNER_KEY
cast send $WETH "transfer(address,uint256)" $EXECUTOR_ADDRESS 1ether --rpc-url $RPC_URL --private-key $OWNER_KEY
# give the operator some ETH for gas (0.01 ETH lasts a long time on Base)
cast send $OPERATOR --value 0.01ether --rpc-url $RPC_URL --private-key $OWNER_KEY
```

### 4. Dry-run with real simulation

Set `EXECUTOR_ADDRESS` and `PRIVATE_KEY` (operator) in `bot/.env`, keep `DRY_RUN=true`, run
`npm start`. Every opportunity is now **simulated against the live chain with your real contract**:
exact profit and gas, still nothing sent.

### 5. Go live

Set `DRY_RUN=false` and run `npm start`. Each trade logs `SENT`, then `LANDED` / `NOT LANDED` with
the realized profit, measured from the executor's actual WETH transfers in the receipt. Stats print
every minute. Ctrl-C stops cleanly after in-flight trades settle.

Withdraw profits any time from the owner wallet:

```bash
cast send $EXECUTOR_ADDRESS "withdraw(address,address,uint256)" $WETH $OWNER_ADDRESS <amount> \
  --rpc-url $RPC_URL --private-key $OWNER_KEY
```

## Tuning for profit

| Setting | Effect |
|---|---|
| `BID_PERCENT` (30) | Share of profit paid as priority fee. Base orders by priority fee, so raise it if you're losing races (many `NOT LANDED`), lower it if you win nearly everything. |
| `MAX_TRADE_ETH` (1) | Capital per trade. Larger arbs need more inventory, and the bot sizes each trade optimally up to this cap. |
| `MIN_PROFIT_ETH` (0.00002) | Net floor after all costs. Lower means more trades with thinner margins. |
| `DISCOVER_BLOCKS` / `MAX_SPOKES` | How many long-tail tokens to watch. More tokens means more routes and less competition per route. |
| `MAX_HOPS` (3) | 2 is fastest. 3 finds triangles through USDC and other hubs. 4 is allowed but the route count explodes. |
| `EXTRA_TOKENS` | Tokens you want watched regardless of activity (new launches you're tracking). |

**Latency matters most.** Run the bot on a server in the same region as your RPC provider, or run your
own Base node. A good RPC is the single biggest upgrade.

## How it works

```
every block (~2s):
  eth_getLogs(Sync events)  ─┐
  executor WETH balance      ├─ 1 round-trip, in parallel
  block base fee            ─┘
  → update reserves of tracked pools
  → re-evaluate only cycles touching changed pools (closed-form optimal size, exact integer quote)
  → best non-overlapping candidates → simulate + estimate gas + L1 fee (in parallel)
  → bid = BID_PERCENT of (profit − gas − L1 fee) → sign locally → send
  → on receipt: realized profit from WETH transfers → logs/trades.jsonl
```

- A route is treated as one "virtual pool" `out(x) = n·x / (d + c·x)` by composing the hops, so the
  profit-maximizing input is `(√(n·d) − d) / c`, exactly, in one step.
- The on-chain executor recomputes each hop from live reserves, so a small price move between simulation
  and inclusion just shrinks the profit instead of reverting the trade.
- Routes that keep failing simulation (fee-on-transfer tokens, paused pools) are blocked automatically.
- Reserves are fully re-read every `RESYNC_EVERY_BLOCKS` as a safety net, and newly active tokens are
  folded in every ~30 minutes.

## Tests

```bash
cd contracts && forge test     # 10 tests incl. 2,000-run fuzz: executor == off-chain quote, or reverts
cd bot && npm test             # 21 tests: math vs brute force, cycle graph, encoding, and end-to-end
```

The **end-to-end suite** starts a local chain (anvil) and deploys the real compiled executor alongside
mock Uniswap-V2-style and Aerodrome-style DEXes. A whale trade knocks prices out of line, and the test
checks that the bot finds, simulates, sends and lands the arbitrage, and that WETH actually increases. It
also covers 3-hop routes through a token the bot discovered itself, dry-run never sending, capital caps,
and a wrong key being rejected.

## Making it more profitable (roadmap, highest impact first)

1. **Flashblocks.** Base publishes 200ms pre-confirmation "flashblocks". Reacting to those instead of
   full 2s blocks puts you ahead of every bot that waits for blocks.
2. **Concentrated-liquidity pools** (Uniswap V3/V4, Aerodrome Slipstream). Most Base volume trades in
   these, so arbs between them and the V2-style pools here are the biggest untapped source.
   Requires tick math and a carefully guarded swap callback.
3. **Flash swaps.** Borrow the input from the first pool so trade size isn't limited by inventory.
4. **A Rust hot path** (revm local simulation) to cut simulation round-trips out entirely.

## Layout

```
contracts/src/Executor.sol          on-chain executor (owner/operator, profit-checked atomic route)
contracts/test/                     forge tests + mocks (V2 pair port, Aerodrome-style pool, Multicall3)
contracts/script/Deploy.s.sol       deployment
bot/src/main.ts                     CLI: check | scan | run
bot/src/bot.ts                      per-block loop, discovery, safety rails
bot/src/math.ts                     AMM math + closed-form optimal sizing
bot/src/cycles.ts, strategy.ts      route graph, opportunity selection
bot/src/engine.ts                   simulation, cost/bid planning, signing, PnL settlement
bot/src/pools.ts                    pool discovery, multicall, Sync-log sync
bot/src/chains.ts                   Base addresses (tokens, DEX factories)
```

Base DEX factory addresses come from each project's documentation. Run `npm run check` before
trading: it confirms each factory on-chain, and any DEX without a contract at its address is
disabled automatically.
