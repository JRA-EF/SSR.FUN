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
| BNB can reuse the swap code | **False.** Uniswap v3 exists on BNB but the liquidity is on **PancakeSwap v3**. This needs a second DEX adapter, not new constants. |

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

### Phase 1 — a DEX adapter seam

`evmSwap.ts` and `catalogueRules.ts` both hardcode Uniswap v3. Extract an
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

As Phase 2, plus a `PancakeSwapV3Adapter`. PancakeSwap v3 is a Uniswap v3 fork
with different fee tiers (100/500/2500/10000) and its own factory, quoter and
router, so the adapter is small but the fee-tier assumption in
`UNISWAP_V3_FEES` must become part of the adapter, not a module constant.

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
