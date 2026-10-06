---
name: evm-chain-onboarding
description: >-
  Bring SSR's EVM half up on a new EVM chain: discover and verify that chain's
  DEX and quote assets, wire a ChainConfig, deploy the five-contract stack, and
  prove the whole launch path on a local fork before anything touches mainnet.
  Use when adding or evaluating a chain (Base, BNB, Arbitrum, Optimism, a new
  L2), when a reserve on a non-Robinhood chain reads as $0 or no NAV, or when
  anyone asks what it would take to launch SSR somewhere new.
---

# Onboarding an EVM chain

SSR's EVM half is a fork of Reserve's Folio (`/Volumes/GitStuff/ssr-evm`). The
contracts are chain-agnostic — `script/SSRMainnet.s.sol` has no chain-specific
code, and `foundry.toml` already carries `base` and `bsc` from upstream, which
runs on both. **Adding a chain is config and verification, not contract work.**

What is chain-specific lives in one place: a `ChainConfig` entry in
`src/merge/lib/evmChain.ts`, carrying `dex` (factory, quoter, router, fee tiers)
and `quotes` (the dollar leg and the wrapped native). Everything downstream —
pricing, the launch plan, the swap path — reads from there.

## The rule that generated every lesson below

**Read it off the chain. Never copy an address between chains, never trust a
remembered constant, and never trust a "6 decimals" assumption.**

Both real defects found during the Base/BNB port came from breaking that rule,
and both were silent.

## Step 0 — survey the free endpoints FIRST

Before relying on any endpoint, measure what each one actually serves:
receipts, `eth_getLogs` (and up to what range), and older state (forking needs
it). Do this before anything else; on both BNB and Base it decided the design.

| Chain | logs | receipts + state |
|---|---|---|
| BNB | publicnode only, ≤ 5,000 blocks | defibit, bnbchain.org, drpc, 1rpc — **not** publicnode |
| Base | publicnode ≤ 2,000 blocks | mainnet.base.org, developer-access-mainnet.base.org — **not** publicnode |

No free endpoint does both on either chain, so the proxy routes per method
(`UPSTREAMS[chain].logsUrl`), wallets are handed an endpoint that serves
receipts, and forks use one that serves older state.
`developer-access-mainnet.base.org` forks Base in seconds where
`mainnet.base.org` stalled a forge broadcast for 20+ minutes.

## Step 1 — discover and verify

Write a candidates file (`scripts/evm-chains/<chain>.json`, see `base.json` and
`bnb.json`) listing the DEXes and tokens you *believe* are there, then make the
chain tell you the truth:

```bash
npx tsx scripts/evm-chain-probe.mts scripts/evm-chains/<chain>.json
```

Read-only, no key, no deploy, no funds, straight against mainnet. It reports
code size for every address, `symbol()`/`decimals()` for every token, which fee
tiers have live pools, which DEX holds the deeper market, and prints a
`ChainConfig` block ready to paste.

List more than one DEX when the chain has more than one. On BNB the probe
showed PancakeSwap's USDT/WBNB pool holding ~4.0e24 against Uniswap's ~1.6e24,
which is how we chose.

A read that FAILS is reported as `UNREADABLE`, not as absent, and lands in the
problem list. That distinction matters — see the traps.

## Step 1b — the starter asset list (no catalogue needed)

A chain without a discovery catalogue launches with a verified list. Add
`assetCandidates` and `minDepthUsd` to the candidates file, then:

```bash
npx tsx scripts/evm-chain-assets.mts scripts/evm-chains/<chain>.json
```

A human proposes, the chain verifies: code, `symbol()`, `decimals()`, and the
dollar value of quote asset sitting in each token's deepest pool. Anything
short of the floor is refused and listed. The output is a `starterAssets` block,
each entry carrying the pool it is bought through and that pool's role
(`"usd"` or `"native"`). On BNB at a $100k floor: 10 accepted, 11 refused —
and DOGE turned out to be 8 decimals there. On Base: 9 accepted (cbBTC is 8
decimals), 7 refused — wstETH, cbETH, LINK, EURC are thin *on Uniswap* because
Base's liquidity for them is on Aerodrome, which needs its own adapter
(Slipstream keys pools by tick spacing, not fee).

Pass several endpoints (`RPCS=a,b,c`) — a single free one throttles a few
hundred reads into failures. A failed read is reported as UNREADABLE and is
never a refusal; a run with any UNREADABLE row is unfinished, so re-run it.
The first Base run reported cbBTC and AERO as "not a readable ERC20" before
that distinction existed.

## Step 2 — wire the ChainConfig

Paste the block into `CHAINS` in `src/merge/lib/evmChain.ts`. Nothing else in
the app should learn the chain's addresses; if you find yourself adding a
constant somewhere else, that is the bug.

`tests/phase_robinhood_catalogue.ts` enforces this: the swap layer must contain
no 40-hex-digit literal at all.

## Step 3 — prove it on a fork, before any mainnet deploy

```bash
# 1. fork
anvil --fork-url <rpc> --port 8546 --silent &

# 2. deploy the stack (five contracts, no chain-specific code)
cd ../ssr-evm
SSR_OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
ETHERSCAN_KEY=dummy ETHERSCAN_API_KEY=dummy \
forge script script/SSRMainnet.s.sol --rpc-url http://127.0.0.1:8546 \
  --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. drive the app's own code against it
cd ../SSR.FUN
CHAIN=<preset> DEPLOYER=<SSRDeployer> FEE_REGISTRY=<SSRDAOFeeRegistry> \
DEPLOYER_BLOCK=<fork block + 1> \
  npx tsx scripts/verify_evm_chain_fork.mts
```

The private key is anvil's well-known test account 0 — worthless anywhere else.
Add a preset to `verify_evm_chain_fork.mts` for the new chain.

Ten checks must pass. The one that matters most is **"EVERY leg prices"**:
`aumUsd` and `navPerShare` must be real numbers. If they are `null`, the chain's
`dex`/`quotes` are wrong and a reserve there would report $0 while holding real
assets.

Then prove the Launch button itself — the form's own `planLaunch →
quoteLaunch → executeLaunch` against the chain's real config and starter list:

```bash
CHAIN=<key> DEPLOYER=... FEE_REGISTRY=... DEPLOYER_BLOCK=<fork block + 1> \
  npx tsx scripts/verify_evm_launch_fork.mts
```

It buys a mixed basket (one dollar-quoted asset, one two-hop native-quoted
asset, and cash), deploys, and checks shares are 1:1 with the dollar, AUM is
within 3% of the seed, the cash leg holds real dollars, and no progress line
names another chain's token.

Also run `registerVersion` on the new chain — it is free, and the fork run
proved it works (`getLatestVersion()` returns `"6.0.0"`).

## Step 4 — go live

```bash
scripts/go-live-evm-chain.sh <chain> --rehearse   # real keys, on a fork
scripts/go-live-evm-chain.sh <chain>              # mainnet; spends real gas
```

Preflights the chain id and both keys' gas, deploys with the deployer key,
sends `registerVersion` from the owner key, verifies the version and that admin
is the owner, and prints the six config lines to paste. It does not flip
`live` or ship the frontend — that stays a reviewed change: set `live: true`,
add the chain to `EVM_LAUNCH_OPTIONS` in `src/merge/lib/chainChoice.ts` (the
registry test keeps them in step), and set its keyed `<CHAIN>_RPC_URL` on Vercel.

**The deployer's nonce decides the addresses.** The deployer key has never
transacted outside Robinhood, so on a fresh chain its nonce is 0 and the stack
lands at the same five addresses as Robinhood mainnet — the BNB rehearsal
confirmed it. Fund the deployer by sending TO it (that does not move its
nonce), and send nothing FROM it on the new chain before go-live.

## Traps, each one paid for

**Decimals are not 6.** BNB's USDT *and* USDC both report **18**. `USDG_DECIMALS`
used to be a module constant of 6, which made a 1,000-dollar seed parse to `1e9`
raw — a billionth of a dollar — while still minting ~1,000 shares, and put the
price-impact guard out by `1e12`. A reserve holding dust while the UI claims a
thousand dollars. The dollar's decimals now come from `cfg.quotes.usd.decimals`;
keep it that way.

**A failed read is not an absent contract.** Uniswap's quoter and router on BNB
were recorded as "zero bytes of code" after being read through an anvil fork
whose upstream had archive problems. Re-read directly against the chain, they
are both deployed. Never conclude "not deployed" from a fork or a flaky
endpoint — only from a clean direct read.

**Public RPCs are archive-limited.** BSC's `bsc-dataseed` returns `missing trie
node`; `publicnode` demands a paid token for archive reads. The combination that
worked was `https://bsc-dataseed1.defibit.io` with `anvil --no-storage-caching`.
Base's `mainnet.base.org` throttles bursts of `eth_call`. Use a keyed provider
for real work.

**Public RPCs cap `eth_getLogs`, and reserve discovery needs it.** Measured
2026-10-06: BNB's publicnode accepts 5,000 blocks and every other public BSC
endpoint refuses getLogs outright; Base's public RPC caps at 500. Set
`logChunk` on the ChainConfig; discovery is chunked to it. Production wants a
keyed endpoint behind the proxy (`?chain=<key>`, env `<CHAIN>_RPC_URL`).

**viem caches the block number for ~4s.** Chunked discovery once read a stale
head and missed a reserve created moments earlier — the BNB fork run found 0
of 1. Discovery reads the head with `cacheTime: 0` and its last chunk reads to
`latest`.

**No hardcoded token, DEX or chain names in the launch path.** The form's copy
takes its dollar, DEX, chain and gas token from the config; `planLaunch` names
the cash leg after the chain's dollar. A registry test fails if "Uniswap",
"in USDG" or "paid in ETH" reappears in the form.

**Fork log queries must start at or after the fork block.** Pass
`DEPLOYER_BLOCK=<fork block + 1>`. A lower value makes `getLogs` reach upstream
for pre-fork blocks and hit rate limits.

**`FEE_REGISTRY` is required.** Omit it and the fee registry defaults to the zero
address; `loadReserve` then fails inside `getFeeDetails` with "returned no
data", which reads like a code bug and is not one. The script now refuses to
start without it.

**PancakeSwap needs no adapter.** It is a Uniswap v3 fork and answers the same
`getPool`/`slot0`/`liquidity` calls. Only its fee tiers differ (2500, not 3000),
and those travel with `dex.fees`.

## What a chain still needs before users can reach it

Deploying the contracts is the cheap, reversible part — an empty factory holds
no value, and a wrong one is replaced by deploying another. The product gap is
separate, and as of 2026-10-05 still open:

- `CHAINS` is keyed `"testnet" | "mainnet"` (Robinhood's environments), not by chain
- the Robinhood catalogue tables key on address with no `chain_id`; harmless
  while only Robinhood has a catalogue, but a second catalogued chain needs it
- routes still live under `/api/robinhood/*` (the proxy serves every chain
  via `?chain=`); a rename is cosmetic
- (resolved 2026-10-06: the swap path, chunked discovery, chain-aware form,
  directory and portfolio are all done and fork-proven on BNB)

Governance (a `MockRoleRegistry` with a single-EOA admin) is a recorded decision,
not an oversight — see `docs/project/MULTICHAIN_RESERVES.md`.

## Files

| Path | Role |
|---|---|
| `scripts/evm-chain-probe.mts` | Step 1: discovery against the live chain |
| `scripts/evm-chains/*.json` | Candidate addresses per chain |
| `scripts/evm-chain-assets.mts` | Step 1b: verified starter asset list |
| `scripts/verify_evm_chain_fork.mts` | Step 3: pricing, swaps, create, discover on a fork |
| `scripts/verify_evm_launch_fork.mts` | Step 3: the Launch button end to end on a fork |
| `scripts/go-live-evm-chain.sh` | Step 4: deploy + registerVersion, with `--rehearse` |
| `src/merge/lib/evmChain.ts` | The only place a chain's wiring may be written |
| `docs/project/MULTICHAIN_RESERVES.md` | The plan, with the fork evidence |
