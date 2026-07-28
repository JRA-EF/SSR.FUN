<!--
  Frontend integration record for SSR Protocol Gate 10-11. Supersedes this
  file's original pre-Gate-10 plan (see git history for the prior version),
  which assumed the existing AMM Buy/Sell UI would stay untouched and a
  brand-new proportional mint/redeem UI would be built separately. The
  mission's actual Gate 10 instructions redefined Buy/Sell as a SOL zap
  reusing the EXISTING Buy/Sell tab, which is what was built. Everything
  below reflects what is actually implemented and verified against live
  DevNet, not a plan.
-->

# Frontend Integration (Gate 10-11)

## Summary

The existing SSR.fun frontend (native + merge design systems, unchanged
visually) is now wired to the real, deployed SSR Protocol program on Solana
DevNet (`2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW`). Wallet connection,
Reserve data, Buy/Sell, and Reserve creation all execute real DevNet
transactions when acting on a chain-backed Reserve; the pre-existing
fully-simulated Reserves (`blue`, `meme`, `sdefi`, `infra`, `gaming`) and
their AMM economy are untouched and keep working exactly as before -- the
integration is additive, not a replacement.

## Data-source boundary: `DTR.onChain`

Rather than a global mock/DevNet mode flag, each `DTR` in `useAppStore`
either has an `onChain: OnChainReserveMeta` field (`src/merge/lib/types.ts`)
or doesn't:

- **Present** -- this Reserve is a real, deployed SSR Protocol account. Buy,
  Sell, and all displayed Reserve/vault/supply data are real and
  chain-sourced (`src/merge/lib/onChainReserve.ts`, `RealReserveSync.tsx`).
- **Absent** -- this Reserve is the pre-existing pure simulation; nothing
  about it changed.

The 2 Gate-9 fixture Reserves (`docs/protocol/DEVNET_FIXTURES.md`) are seeded
into the store at load time with `onChain` populated
(`REAL_PLACEHOLDER_DTRS` in `useAppStore.ts`); any Reserve created through
`CreateDTR.tsx` using only the 3 DevNet test assets is registered the same
way via `registerRealReserve`.

## Real wallet connection

`src/merge/lib/SolanaProviders.tsx` wraps the app in
`@solana/wallet-adapter-react`'s `ConnectionProvider`/`WalletProvider`
(`wallets={[]}` -- Phantom/Solflare/Backpack all register via the Wallet
Standard, so no per-wallet adapter package is needed). `WalletModal.tsx` now
calls the real adapter's `select()`/`connect()` instead of a fake timeout;
`WalletSync.tsx` (mounted once at app root) mirrors real
connected/connecting/address state and polls the live SOL balance into the
existing `WalletState` shape every 15s, so every existing consumer (Shell,
DTRDetail, CreateDTR, Portfolio, Manage) needed zero shape changes.

## Real on-chain reads

`packages/sdk/src/readOnly.ts` builds a read-only Anchor `Program` (a
stub, non-signing wallet is sufficient for `.fetch()`/`.fetchNullable()`
calls) and exposes `fetchReserveOnChain(connection, programId, reserveAddress,
candidateAssetMints)`, which derives every `ReserveAsset`/vault PDA directly
from already-known mint addresses -- **never `getProgramAccounts`**, which is
confirmed blocked (403) on the public DevNet RPC (see DEVNET_RUNBOOK.md).
`RealReserveSync.tsx` polls this for every chain-backed DTR plus the
connected wallet's real Reserve Token balance (`fetchTokenBalanceRaw`) every
15s, and immediately after any confirmed Buy/Sell/Create.

## Buy/Sell zap architecture

**Buy = SOL zap into proportional protocol mint. Sell = proportional protocol
redeem followed by a zap into SOL.** Both are single atomic, two-signer
transactions (`packages/sdk/src/zapInstructions.ts`):

- **Buy**: idempotent-create the depositor's ATAs → `SystemProgram.transfer`
  user→swap-authority (SOL in) → SPL `mintTo` per asset leg
  (authority=swap-authority, destination=user's own ATA) →
  `mint_reserve_tokens_in_kind` (signer=user). If any instruction fails,
  nothing executes -- the user is never left holding an unintended
  intermediate basket.
- **Sell**: `redeem_reserve_tokens_in_kind` (signer=user, assets land in the
  user's own ATAs) → idempotent-create swap-authority's ATAs → SPL `transfer`
  per asset leg user→swap-authority → `SystemProgram.transfer`
  swap-authority→user (SOL out).

The **swap authority** is a DevNet-only keypair (reused: the Gate-9 fixture
"manager", which already holds mint authority over the 3 fixture test asset
mints) held **server-side only**
(`DEVNET_SWAP_AUTHORITY_SECRET_KEY`, a Vercel Sensitive env var, never
bundled to the browser). `api/devnet/swap-sign.ts` independently re-fetches
live Reserve state and recomputes every amount itself
(`computeMintRequirements`/`computeRedemptionEntitlements`) before partially
signing -- it never trusts client-supplied amounts, so a malicious client
cannot extract more than they put in. The client (`src/merge/lib/zapClient.ts`)
completes the returned partially-signed transaction with the user's own
wallet signature and submits it.

`DTRDetail.tsx`'s existing Buy/Sell tab is reused as-is: for a chain-backed
Reserve, the "USDC" unit/label swaps to "SOL" and the quote box shows the
fixed DevNet test price instead of the AMM curve's price-impact figures;
every other element (tabs, quick-fill buttons, disabled/insufficient-balance
states, spinner) is unchanged.

### DevNet test pricing (see `zapPricing.ts`, `onChainReserve.ts`)

The deployed protocol has no oracle or bonding curve -- it only tracks raw
per-asset backing. `SOL_TEST_PRICE_USD = 20` and each fixture asset =
`$1.00` are **fixed, DevNet-only constants**, not live market data, used
solely so the existing dollar-denominated UI has something coherent to show.
The Buy/Sell tab labels this explicitly ("SOL Price (DevNet test)" with a
tooltip). Never presented as a real price anywhere.

## Create Reserve flow

`CreateDTR.tsx`'s existing 4-step stepper is unchanged. The asset picker
(step 2) now also lists the 3 DevNet fixture test assets
(`DEVNET_REAL_ASSETS`, sourced from `packages/sdk/src/fixtures.ts`) alongside
the 14 pre-existing fictional symbols. Selecting **only** real assets routes
the final submit to `createReserveOnChain`
(`src/merge/lib/createReserveClient.ts`) instead of the mock `createDTR()`;
mixing in any fictional asset falls back to the existing simulated deploy
unchanged.

Real deployment sequence (each a separate, real, confirmed transaction; the
submit button's spinner label tracks the current step):

1. `createReserve` (signer: connecting wallet, as the new Reserve's manager)
2. `initializeReserveAsset` × N, combined in one transaction
3. `api/devnet/mint-test-assets` -- a DevNet-only faucet endpoint, fully
   server-signed, mints the computed seed amounts directly to the new
   manager's own wallet (no user signature needed; it only ever adds tokens)
4. `seedReserve` (signer: connecting wallet)

On success the new Reserve is registered into the store
(`registerRealReserve`) and the user is navigated to its real detail page,
which immediately shows live on-chain state.

**Resumability note**: each step is a separately-confirmed transaction with
a distinct progress label, so a failure is never ambiguous about which step
it happened at. If `createReserve` itself lands but client-side confirmation
times out, a retry calls `createReserve` again and reserves a **new**
`reserve_id` rather than resuming the same one -- the orphaned first attempt
becomes a real instance of the already-documented "abandoned Reserve
creation" invariant (see SECURITY_INVARIANTS.md), not silently hidden.
Full step-level resumption (detecting and continuing an existing partial
Reserve) is a natural follow-up, not built here.

## Wallet testing support

`Portfolio.tsx` has a "Get DevNet Test Assets" button (calls
`api/devnet/mint-test-assets` directly, no transaction/signature needed from
the user) so a connected wallet can acquire the 3 fixture test assets to
experiment with Sell without having Bought first, or to self-seed a newly
created Reserve.

## Explorer integration

`src/merge/lib/solana-config.ts`'s `explorerUrl(kind, value)` always tags
the DevNet cluster. Used in: Buy/Sell/Create success toasts (transaction
signatures) and a small "View on Solana Explorer" link row on `DTRDetail.tsx`
(Reserve account, Reserve Token mint, each asset's vault) for chain-backed
Reserves.

## Verified against live DevNet (see scripts/verify_*.ts)

Every piece of new on-chain logic was exercised against the live deployed
program with real transactions **before** being wired into the UI, using a
throwaway funded keypair standing in for a connected wallet (no browser
automation tool was available in the environment this was built in -- see
PROJECT_STATUS.md for what remains manually/browser-verified):

- `verify_reads.ts` -- real reads for both fixture Reserves.
- `verify_zap.ts` -- a full Buy then Sell round-trip: vault balances and
  Reserve Token supply increase/decrease exactly as expected, SOL moves
  both directions with the swap authority's balance delta matching the
  exact expected spread.
- `verify_swap_sign_endpoint.ts` -- calls the actual `api/devnet/swap-sign.ts`
  handler in-process and confirms it returns a correctly-partially-signed,
  correctly-instructed transaction.
- `verify_create_reserve.ts` -- a brand-new Reserve created, registered (2
  assets), seeded (via the mint-test-assets faucet), and confirmed `active`
  on-chain, entirely from a fresh keypair with no prior state.
- `verify_mint_test_assets.ts` -- the DevNet faucet endpoint mints the
  correct raw amounts to a fresh wallet with no prior ATAs.

Real transaction signatures, account addresses, and before/after balances
from these runs are in the session's decision log (DECISION_LOG.md) and
PROJECT_STATUS.md.

## What's DevNet-only vs. production-shaped

See PROJECT_STATUS.md "Mainnet-Readiness Gaps" for the full list. In brief:
the swap-authority co-signing pattern, the fixed test pricing, and the
mint-test-assets faucet are all explicitly DevNet-only infrastructure,
isolated behind `api/devnet/**` and clearly documented as such; they are not
reachable or meaningful outside a DevNet deployment (the swap authority only
has mint control over 3 worthless test tokens and a small DevNet-only SOL
balance -- compromising it cannot affect anything of real value). The
underlying protocol calls themselves (`mint_reserve_tokens_in_kind`,
`redeem_reserve_tokens_in_kind`, `create_reserve`, etc.) are the real,
audited-eventually production instructions -- a production deployment
replaces the swap adapter with a real routing provider (see "Swap and
routing layer" gap) behind the same `zapInstructions.ts`-shaped interface,
without touching the frontend.
