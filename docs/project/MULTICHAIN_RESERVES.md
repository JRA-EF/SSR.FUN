# Reserves on any token, on any chain — Base first, then BNB

Status: proposal, 2026-10-04. Nothing here is implemented.

## What this is

SSR already does "any token" on two chains, by two different routes:

- **Solana** — Jupiter's verified list, 3,545 tokens, with the program judging
  Token-2022 extensions by *configuration* rather than type (DEC-0205/0206).
  That is what admitted 1,125 xStocks.
- **Robinhood Chain (4663)** — every token with a Uniswap v3 pool against USDG
  or WETH carrying real depth, discovered from the factory's own `PoolCreated`
  logs (DEC-0217/0219). The first full walk read 433,072 pools / 431,840
  tokens and returned **1,418 eligible, 100 copycats refused**.

Neither is a hand-kept list, and that is the whole point: a token qualifies by
having a market, not by someone adding it. This document is about making the
*chain* the same kind of parameter the token already is.

## Verified before planning

| Claim | Verdict |
|---|---|
| The contracts are chain-specific | **False.** `script/SSRMainnet.s.sol` deploys five contracts (role / DAO-fee / version / trusted-filler registries + `SSRDeployer`) with no chain-specific code. Adding a chain is `forge script --rpc-url <chain>`. |
| Base and BNB are unproven ground for this fork | **False.** `ssr-evm/foundry.toml` already carries `base` and `bsc` endpoints, inherited from upstream Folio, which runs on both. We would be deploying a fork onto ground upstream already proved. |
| `ChainConfig` is a real abstraction | **True, and good.** deployer, registries, assets, explorer, read-proxy, notice. The interface survives multi-chain nearly unchanged. |
| ...so the app is multi-chain-ready | **False, and this is the crux.** `CHAINS` is `Record<"testnet" \| "mainnet", ChainConfig>` — keyed by Robinhood's two *environments*, not by chain. `export const ROBINHOOD = CHAINS.mainnet`, and `const cfg = ROBINHOOD` sits at **module scope** in `RobinhoodCreateForm.tsx:67` and `RobinhoodReserveDetail.tsx:37`. One chain is baked in at import time. |
| Catalogue storage can hold a second chain | **False.** `robinhood_catalogue_pools` and `robinhood_asset_catalogue` both use the token/pool **address as primary key** with no chain column. The same address on two chains collides. |
| Base Uniswap v3 constants | **Verified on-chain 2026-10-04, block 52,189,274** (see below). |
| BNB needs a PancakeSwap *adapter* | **Overstated -- corrected 2026-10-05.** PancakeSwap v3 is a Uniswap v3 fork and is ABI-compatible for everything the app reads. BNB passed the full fork check on config alone, no adapter. Its fee tiers differ (2500, not 3000), which the per-chain `dex.fees` already carries. The swap QUOTER/ROUTER remain unexercised -- see below. |

### Base constants, read live from chain 8453

| Role | Address | Confirmed |
|---|---|---|
| UniswapV3Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | 24,535 bytes |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | 8,273 bytes |
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` | 24,497 bytes |
| USDC (quote) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | reports `USDC` / 6 |
| WETH (quote) | `0x4200000000000000000000000000000000000006` | reports `WETH` / 18 |

`getPool(USDC, WETH, 100)` → `0xb4CB800910B228ED3d0834cF79D697127BBB00e5`, so the
factory answers and the quote pair is real. Re-verify at implementation time;
do not trust this table alone.

## Proven on a Base fork (2026-10-04)

Everything below was executed against `anvil --fork-url https://mainnet.base.org`
at block 52,190,137. No real funds, no help needed: USDC came from impersonating
a holder on the fork, ETH from `anvil_setBalance`.

**1. The whole stack deploys to Base unchanged.** `forge script
script/SSRMainnet.s.sol --rpc-url <fork>` succeeded with no edits:

| Contract | Address on the fork |
|---|---|
| MockRoleRegistry | `0xce3774eE9D08a2532B7Ff4b1B2aa0529a66f3B07` |
| SSRDAOFeeRegistry | `0x78197f4Bf9Ab0E798E6ADE43e96a328996B8A455` |
| SSRVersionRegistry | `0x17434891234feAe6a4389A26Fa566c2610a1b156` |
| TrustedFillerRegistry | `0x75FB485650e1495ff4F7b666a58c95be0CC08b4d` |
| SSRDeployer | `0xA19c9bC872a46Ad2B3EED81ec43349F8DB8f8D9F` |

**2. `registerVersion` works.** Never run on any chain before. After calling it,
`getLatestVersion()` returns version **"6.0.0"**, the deployer address, and
`deprecated = false`. This is the first evidence that the staged 4663
transaction in `ssr-evm/REGISTER_VERSION_TX.txt` will succeed.

**3. The app's own launch code runs on Base unmodified.** Not a reimplementation
— `createReserve` and `loadReserve` imported straight from
`src/merge/lib/evmReserve.ts`, handed a `ChainConfig` pointing at Base. It
approved both legs, deployed, and returned the reserve:

```
Base Core Two (BASE2)  0x8A26ACAb62F8165aa6b6DB1a583334b3B3917436
  totalSupply 100.0000   maxAuctionLength 300s
  basket: USDC 1000 | WETH 0.25
```

`listReserveAddresses` then found it from the factory's `SSRDeployed` logs, so
directory discovery works too. `daoFeeBps 5000` and `feeFloor 5e15` confirm our
raised fee caps are live on Base — the one behavioural change in the fork.

**4. The surprise: a Base reserve shows no value.** `aumUsd` and `navPerShare`
both came back **null**, and every basket leg priced **null**:

```
aumUsd null  navPerShare null
  USDC ... "usd": null
  WETH ... "usd": null
```

The cause is in `evmReserve.ts`. `v3Spot` reads
`UNISWAP_V3.factory` — Robinhood's factory — as a module-level import, and
`usdPrice` hardcodes `USDG` as the dollar. Neither is a parameter, so on Base
no pool is ever found and nothing can be priced.

**This is DEC-0211 again.** That entry fixed xStocks reserves reading as $0
holdings / no NAV because vault balances were decoded under the wrong token
program. Same shape of defect, other chain: a correct reserve that the UI
reports as worthless.

**5. Parameterising it fixes it.** The identical `v3Spot` math with Base's
factory and USDC as the quote, against the same reserve:

```
WETH price from Base Uniswap v3: $2727.14
  USDC  1000   $1000.00
  WETH  0.25    $681.79
AUM $1681.79   NAV/share $16.8179
```

So the work is a seam, not an algorithm. But it is **required before Base
ships, not after** — see the phase change below.

## BNB, proven the same way (2026-10-05)

Forked chain 56 with anvil, deployed the stack, ran the same checks. **All ten
passed**, reporting AUM $1,785.75 and NAV/share $17.8575.

Three findings worth keeping:

**1. BNB needs no adapter.** The plan said PancakeSwap would need one. It does
not: PancakeSwap v3 is a Uniswap v3 fork and answers the same `getPool`,
`slot0` and `liquidity` calls, so pricing worked with nothing but a
`ChainConfig` entry. The only difference is the fee tiers -- 100/500/**2500**/
10000 rather than Uniswap's 3000 -- and those already travel with `dex.fees`.

**2. BNB's dollar has 18 decimals.** USDT *and* USDC on chain 56 both report
`decimals = 18`, not the 6 they have on Base and Ethereum. Anything that
assumes a six-decimal dollar is wrong on BNB. `quotes.usd.decimals` carries it,
which is why that field exists rather than a constant.

**3. Which DEX is deeper.** Both PancakeSwap v3 and Uniswap v3 are deployed on
BNB with real liquidity. Pancake's USDT/WBNB pool at the 100 tier holds
~4.19e24 against Uniswap's deepest ~2.03e24, so Pancake is the market to
route through. Uniswap v3's factory is on BNB, but its quoter and router are
NOT at the addresses they occupy on other chains -- both read as zero bytes of
code. Nothing may be copied between chains without re-reading it.

**Still unexercised on both chains:** the swap quoter and router. `createReserve`
pulls the basket from the caller, so the fork runs never buy anything. The
launch flow's Uniswap/Pancake buy path is parameterised but unproven, and that
is the next thing to test.

**Infrastructure note.** Public BSC endpoints are archive-limited: bsc-dataseed
returns "missing trie node", publicnode demands a token for archive reads. The
run that worked used `https://bsc-dataseed1.defibit.io` with
`anvil --no-storage-caching`. A real BNB rollout wants a keyed archive
provider, as Robinhood already has.

## The one hard problem

On Robinhood, token legitimacy has an **anchor**: every official stock token is
the same beacon proxy, so `OFFICIAL_STOCK_TOKEN_CODE_HASH` separates the real
AAPL from the copycat that merely calls itself `AAPL • Robinhood Token`. That
check refused 100 impersonators on the first walk.

**Base and BNB have no such anchor.** There is no single issuer whose code hash
means anything. So `MIN_DEPTH_USD_FOR_OTHER_TOKENS` — currently $1,000 — would
carry the entire anti-impersonation load, on the two chains with the largest
scam-token populations in crypto, where $1,000 of liquidity is trivially cheap
to stage and withdraw.

This is the part that must be designed, not ported. Options, in rough order of
strength:

1. **Depth + persistence** — require the depth to have held across N catalogue
   runs (days), not at one instant. Makes a staged pool expensive to maintain.
2. **Depth + locked liquidity** — check the LP position is locked or burned.
3. **Allow-anchored symbols** — a token may only *claim* a reserved symbol
   (USDC, WETH, cbBTC, a stock ticker) if it is the known contract; otherwise
   it is offered under its address with the symbol shown as unverified. This is
   the existing symbol-impersonator rule from DEC-0219, generalised.
4. **Raise the floor per chain** — `MIN_DEPTH` becomes a per-chain parameter,
   not a constant.

Recommendation: 3 + 1 + per-chain 4, and treat 2 as a later refinement.
**Do not ship Base with Robinhood's $1,000 flat rule.**

## Phases

### Phase 0 — make "chain" a parameter (no new chain yet)

Pure refactor against the existing two Robinhood environments, so it is
provable before anything new is deployed.

- `CHAINS` keyed by a `ChainKey` (`"robinhood" | "robinhood-testnet" | …`),
  not by `"testnet" | "mainnet"`. `ChainConfig` gains `chainId`, `idPrefix`,
  `quotes: QuoteAsset[]`, and a `dex` descriptor.
- Delete the module-scope `const cfg = ROBINHOOD` in both components; the
  chain arrives as a prop/route param. **This is the change that decides
  whether the bundle can serve more than one chain at all.**
- `evmReserveId.ts`: `rh-` becomes `<prefix>-`, with the prefix coming from the
  chain config and a reverse lookup for the `/dtr/:id` route.
- Rename `components/robinhood/` → `components/evm/`; keep Robinhood-specific
  copy behind the chain config's `notice`.
- DB migration: add `chain_id integer not null` to both catalogue tables and
  move the primary key to `(chain_id, address)` / `(chain_id, pool)`. Backfill
  existing rows to 4663. Tables renamed `evm_catalogue_*`.
- `/api/robinhood/*` → `/api/evm/*` with a required `chain` parameter; keep the
  old paths as redirects for one release so live links survive.
- `rpc-proxy` takes the chain and reads a per-chain env var; the allowlist and
  the budgets stay exactly as they are.

Phase 0 ships with **zero user-visible change** and the full test suite green.
If it cannot, the abstraction is wrong and nothing further should be built on it.

### Phase 1 — a DEX adapter seam (REQUIRED before Base, not optional)

Proof 4 above is this phase's acceptance test: without it a Base reserve reads as $0.\n\n`evmSwap.ts`, `catalogueRules.ts` AND `evmReserve.ts`'s `v3Spot`/`usdPrice` all hardcode Uniswap v3 and USDG. Extract an
interface — `discoverPools`, `quote`, `buildSwap`, `poolDepth` — with
`UniswapV3Adapter` as the first and only implementation, proved by re-running
the Robinhood catalogue through it and getting the same 1,418 tokens.

### Phase 2 — Base (chain 8453)

1. Deploy the five contracts: `forge script script/SSRMainnet.s.sol --rpc-url base`.
   **Replace `MockRoleRegistry` first** — see Governance below.
2. Run `registerVersion` for the deployer, which has never been done on any chain.
3. Chain config entry with the verified constants above; quotes `[USDC, WETH]`.
4. Catalogue backfill. Base is ~2s blocks (~43k/day) against Robinhood's ~2M per
   run, so the adaptive log scan is far cheaper — but Base has far more pools,
   so expect the walk to be bounded by pool count, not block count.
5. Apply the new eligibility rule (above). Publish the number of tokens it
   admits and refuses, as DEC-0219 did — that number is the review gate.
6. UI: the chain chooser in step 1 gains Base. Per DEC-0216 the choice is met
   once, at the start of step 1, and that stays.

### Phase 3 — BNB (chain 56)

As Phase 2, with no adapter: the fork run showed PancakeSwap v3 answering the
same calls as Uniswap v3, so a `ChainConfig` entry is the whole of it. What
remains chain-specific is the catalogue's `UNISWAP_V3_FEES` (BNB's tiers
differ) and the eligibility floor, and confirming Pancake's quoter/router
against the swap path, which no fork run has exercised yet.

## Governance — the blocker that replicates

Every chain so far gets `MockRoleRegistry` (the contract from `test/utils/`)
with `DEFAULT_ADMIN_ROLE` held by a **single EOA**, and `registerVersion` has
never been called on 4663. Verified on-chain: admin is
`0x8b41e427BD610F49b3cAE8851428EB1e6DB88B24`, emergency council has 0 holders,
`getLatestVersion()` reverts.

On Robinhood that is contained. On Base and BNB it is real users, real value and
real MEV — and deploying as-is **triples** the exposure rather than fixing it.

Before Phase 2 deploys:

- A real role registry, with admin held by a Safe on that chain (Solana's
  equivalent is the Squads vault `HFmqpPVV…`; the EVM side has no counterpart).
- `registerVersion` run on every chain including 4663.
- A named emergency-council holder, or an explicit decision to have none.

If the answer is "ship anyway", that is a legitimate call — but it should be a
decision with a DEC entry, and the EVM surfaces should say plainly that
governance is a single key.

## Verification

Per phase, not at the end:

```bash
npx tsc -p tsconfig.app.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npx ts-mocha -p ./tests/tsconfig.json -t 300000 'tests/phase_*.ts'
VITE_ENABLE_EVM=true VITE_SOLANA_CLUSTER=mainnet-beta npx vite build
```

Six failures in `phase_chart_range_selector` and
`phase_featured_cards_and_rpc_redaction` are pre-existing and unrelated; they
must not be masked, and the count must not grow.

New coverage: the chain-key round trip (`id → chain → id`), the catalogue rule
against a synthetic impersonator set, and a parity test that the Robinhood
catalogue produces the identical token set before and after Phase 0 and 1.

End to end on staging, per chain: create → seed → buy → sell → rebalance with a
controlled wallet, and confirm the directory shows reserves from every
configured chain at once.

## Explicitly deferred

Cross-chain reserves (one reserve holding assets on two chains) — a different
and much larger problem. Bridging. Solana-side changes of any kind. The
liquidity work on `feature/liquidity-arch`.

## Open questions for the Creator

1. Is the single-key governance acceptable on Base/BNB, or does Phase 2 wait on
   a Safe? This is the only question that blocks the deploy.
2. `MIN_DEPTH` per chain — what floor for Base, and does the symbol-anchor rule
   from DEC-0219 become the general mechanism?
3. Which RPC provider per chain, and does the existing Chainstack account cover
   Base and BNB?
