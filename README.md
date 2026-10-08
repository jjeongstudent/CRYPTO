# Base Arb Bot

An atomic cyclic-arbitrage ("backrun") bot for **Base**. When a swap knocks one pool's price out of
line with the others, the bot buys on the cheap pool and sells on the expensive one in a single
transaction, ending with more WETH than it started with or reverting.

- **Venues:**
  - **Concentrated liquidity** (where most Base volume trades): Uniswap V3, SushiSwap V3, PancakeSwap V3, Aerodrome Slipstream, Uniswap V4 (including native-ETH pools)
  - **Constant product:** Uniswap V2, SushiSwap V2, PancakeSwap V2, BaseSwap, Aerodrome volatile pools
- **Speed:** reacts to Base **Flashblocks** (200ms pre-confirmations) as well as sealed 2s blocks
- **Routes:** 2-hop (DEX vs DEX) and 3-hop triangles (e.g. `WETH → USDC → TOKEN → WETH`), mixing any venue types
- **Long tail:** discovers actively traded tokens on its own from recent swaps. Fewer competitors watch those pools than the blue-chip ones.
- **Exact math:** the TypeScript port of Uniswap's tick math reproduces the real contracts bit-for-bit (verified against them in tests), so predicted profit equals simulated profit to the wei
- **Sizing:** closed-form optimum for constant-product routes; exact numerical optimum when a route includes a concentrated-liquidity pool
- **Execution:** live simulation → gas + L1-fee accounting → priority-fee bid → locally signed tx

## Why Base

Gas on Base costs fractions of a cent, so arbitrage worth a few cents is still profitable after
fees. On Ethereum mainnet the same trades are wiped out by gas and builder bribes. Base has no
public mempool, so "backrunning" here means reacting to state changes faster and bidding smarter
than other bots. With Flashblocks, the bot sees each swap within ~200ms of the sequencer including
it, instead of waiting for the 2s block, and gets its own trade into the next flashblock.

## What you can lose (and what you can't)

The executor contract is built so that **a trade can never reduce its WETH balance**. Every route
starts and ends in WETH, and the contract reverts unless its balance went up by at least
`minProfit`. It never grants token approvals. Swap callbacks (V3 pools, the V4 PoolManager) are
honoured only from the exact pool the current hop is calling, at most once, for at most the amount
routed into that hop. Even a **stolen operator key cannot drain the inventory**. Only the separate
owner key can withdraw, and there are tests that prove it, including attempts through fake V3
pools, malicious callbacks and fake V4 hooks.

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

`POOL_MANAGER` (Uniswap V4) and `WETH` default to Base mainnet's addresses; set `POOL_MANAGER=0x0000000000000000000000000000000000000000`
to disable V4 hops. `npm run check` warns if the executor's PoolManager doesn't match the bot's.

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

### 6. Turn on Flashblocks

```bash
FLASHBLOCKS_RPC_WS=<websocket of a Flashblocks-aware RPC, e.g. wss://mainnet-preconf.base.org or your provider's>
RPC_URL=<the same node over HTTPS, e.g. https://mainnet-preconf.base.org>
```

The bot subscribes to `pendingLogs` and applies each 200ms flashblock's swaps as soon as the
sequencer pre-confirms them, trading immediately and simulating against the pre-confirmed (`pending`)
state. Sealed blocks are still processed as the source of truth, so anything missed on the
websocket is corrected within one block, and liquidity changes are never applied twice.

Since Base's Azul upgrade (May 2026), the raw flashblocks websocket (`wss://mainnet.flashblocks.base.org/ws`)
no longer includes receipts, so it can't show swaps. That's why the bot reads logs from the RPC
subscription. `FLASHBLOCKS_WS` is still supported for streams that carry receipts, and the bot warns if
the stream it's given doesn't.

For the last few milliseconds, `SKIP_SIMULATION=true` sends straight from the local quote, which
reproduces every supported pool exactly. A lost race then costs a reverted transaction's gas instead of
a missed opportunity.

## Tuning for profit

| Setting | Effect |
|---|---|
| `BID_PERCENT` (30) | Share of profit paid as priority fee. Base orders by priority fee, so raise it if you're losing races (many `NOT LANDED`), lower it if you win nearly everything. |
| `MAX_TRADE_ETH` (1) | Capital per trade. Larger arbs need more inventory, and the bot sizes each trade optimally up to this cap. |
| `MIN_PROFIT_ETH` (0.00002) | Net floor after all costs. Lower means more trades with thinner margins. |
| `DISCOVER_BLOCKS` / `MAX_SPOKES` | How many long-tail tokens to watch. More tokens means more routes and less competition per route. |
| `MAX_HOPS` (3) | 2 is fastest. 3 finds triangles through USDC and other hubs. 4 is allowed but the route count explodes. |
| `EXTRA_TOKENS` | Tokens you want watched regardless of activity (new launches you're tracking). |
| `FLASHBLOCKS_RPC_WS` | React to 200ms pre-confirmations (`pendingLogs`). The single biggest speed upgrade on Base. |
| `SKIP_SIMULATION` (false) | Send without the pre-send `eth_call`: one round-trip faster per trade, at the cost of gas on lost races. |
| `CL_RANGE_PCT` (25) | How far around the current price to load concentrated-liquidity ticks. Larger allows bigger trades through thin pools at the cost of more reads. |
| `V4_HOOKS` | Uniswap V4 hook contracts whose pools you trust enough to trade. Hookless pools are always included. |

**Latency matters most.** Run the bot on a server in the same region as your RPC provider, or run your
own Base node. A good RPC is the single biggest upgrade.

## How it works

```
every flashblock (~200ms, FLASHBLOCKS_RPC_WS)         every sealed block (~2s, always)
  pendingLogs burst of the newly pre-confirmed txs      eth_getLogs (all pool events) + base fee + inventory
              └───────────────┬──────────────────────────────────┘
                              ▼  one serial queue: events apply in execution order
  update pool state: Sync → reserves; V3/V4 Swap → price, tick, liquidity;
                     Mint/Burn/ModifyLiquidity → tick liquidity (deltas never applied twice)
  → re-evaluate only cycles touching changed pools
      · float marginal-price filter (rejects ~all cycles instantly)
      · constant-product routes: closed-form optimum
      · routes with a concentrated pool: golden-section search on the exact tick-by-tick quote
  → best non-overlapping candidates → simulate + estimate gas + L1 fee (in parallel)
  → bid = BID_PERCENT of (profit − gas − L1 fee) → sign locally → send
  → on receipt: realized profit from WETH transfers → logs/trades.jsonl
```

- **Exact concentrated-liquidity math.** `bot/src/clmath.ts` ports Uniswap's TickMath, SqrtPriceMath and
  SwapMath, including the word-by-word tick stepping that decides rounding. It is checked against the
  real V3 contracts, and the end-to-end tests require predicted profit to equal the on-chain
  simulation to the wei.
- **Tick windows.** Each concentrated pool keeps the initialized ticks for a band of prices around the
  current one (`CL_RANGE_PCT`). Quotes never extrapolate past the band. They count only what is
  provably there, and the band is re-centred as the price drifts.
- **Uniswap V4** state is read straight from the PoolManager's storage (`extsload`), so no extra
  contract is trusted. Native-ETH pools are routed through WETH, and the executor unwraps and
  re-wraps around the PoolManager. Only hookless pools (and hooks you allow) are traded.
- **Aerodrome Slipstream** fees are dynamic, so they're re-read on every resync, and the on-chain
  simulation is the final word before anything is sent.
- The executor recomputes each V2 hop from live reserves and lets V3/V4 pools compute their own
  outputs, so a small price move between simulation and inclusion just shrinks the profit instead of
  reverting the trade.
- Routes that keep failing simulation (fee-on-transfer tokens, paused pools) are blocked automatically.
- Every pool is fully re-read every `RESYNC_EVERY_BLOCKS` as a safety net, and newly active tokens
  and V4 pools are folded in every ~30 minutes.

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

1. **Flash swaps / flash accounting.** Borrow the input inside the route (V3 flash swaps, V4's
   deferred settlement) so trade size isn't limited by inventory.
2. **Your own Base node with Flashblocks**, co-located with the bot. Public endpoints add tens of
   milliseconds that decide races.
3. **Hooked V4 pools.** Much long-tail Base volume (token launchpads) trades in V4 pools with hooks.
   Supporting a specific hook means modelling its fee logic exactly; `V4_HOOKS` lets you opt in to
   ones you've verified.
4. **A Rust hot path** (revm local simulation) to cut the remaining simulation round-trip.

## Layout

```
contracts/src/Executor.sol          on-chain executor: V2 / V3-style / V4 hops, guarded callbacks, profit check
contracts/test/                     forge tests against the real Uniswap V3 and V4 contracts, plus mocks
contracts/test/helpers/             V3/V4 liquidity + swap helpers (also used by the TypeScript e2e tests)
contracts/script/Deploy.s.sol       deployment
bot/src/main.ts                     CLI: check | scan | run
bot/src/bot.ts                      block + flashblock processing, discovery, safety rails
bot/src/pendingLogs.ts              Flashblocks-aware RPC `pendingLogs` subscription (post-Azul feed)
bot/src/flashblocks.ts              raw Base Flashblocks websocket client and payload parser
bot/src/clmath.ts                   Uniswap tick math, bit-exact port
bot/src/quote.ts, math.ts           per-hop quotes, route sizing (closed form / golden section)
bot/src/events.ts                   pool event decoding and state updates
bot/src/pools.ts, concentrated.ts   pool discovery and loading for every venue type
bot/src/cycles.ts, strategy.ts      route graph, opportunity selection
bot/src/engine.ts                   simulation, cost/bid planning, signing, PnL settlement
bot/src/chains.ts                   Base addresses (tokens, DEX factories, PoolManager)
```

Base DEX addresses come from each project's documentation, and each venue's interface (callback
names, storage layouts, events) was checked against that project's source code. Run `npm run check`
before trading: it confirms every venue on-chain by finding its WETH/USDC pool, and any address
without a contract is disabled automatically.
