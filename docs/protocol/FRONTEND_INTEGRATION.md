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

**Dynamic Reserve/asset validation (DEC-0029, 2026-07-28 corrective pass):**
`swap-sign.ts` used to hardcode a `KNOWN_RESERVES` map recognizing only the 2
Gate-9 fixtures -- any other real, on-chain Reserve was rejected outright.
It now trusts **no** hardcoded Reserve address. Given just a Reserve address
and the client's claimed asset-mint list, it independently re-derives
`protocolConfig`/`reserveTokenMint`/`mintAuthority`/`vaultAuthority` from the
Reserve address itself, fetches the Reserve's real registered assets via
`fetchReserveOnChain`, and rejects only if a registered asset's mint isn't in
the small allowlist the swap authority actually controls (the DevNet fixture
mints + wrapped SOL) -- never the Reserve address itself. Any Reserve created
through the real Create Reserve flow (below) whose assets are all supported
works immediately, with no code change, redeploy, or manual registration.

**Wrapped SOL (DEC-0030):** since the swap authority can't "mint" SOL, Buy's
per-asset loop special-cases the wrapped-SOL mint
(`packages/sdk/src/zapPricing.ts`'s `WRAPPED_SOL_MINT`): the swap authority
wraps its own real SOL (idempotent-create its WSOL ATA, `SystemProgram.transfer`
into it, `syncNative`) and transfers the wrapped amount to the user like any
other SPL leg. Sell's per-asset loop, symmetrically, `closeAccount`s the swap
authority's WSOL ATA right after receiving the user's WSOL leg, unwrapping it
back to real lamports before the final SOL-out transfer.

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
(step 2) lists native **SOL** (`DEVNET_REAL_ASSETS`'s first entry, handled
internally as wrapped SOL -- DEC-0030) plus the 3 DevNet fixture test assets,
alongside the pre-existing fictional symbols, each now labeled
"(simulated)" so they can't be mistaken for real deployable assets. Selecting
**only** real assets routes the final submit to `createReserveOnChain`
(`src/merge/lib/createReserveClient.ts`) instead of the mock `createDTR()`;
mixing in any fictional asset falls back to the existing simulated deploy
unchanged.

**Signature count (DEC-0031, 2026-07-28 corrective pass):** `createReserve`
and every `initializeReserveAsset` are now combined into **one** transaction
(they share most of their accounts, and Solana's deduplicated account-key
table keeps this well under the legacy 1232-byte limit for the realistic
1-3 asset case) -- down from 2 separate transactions. Real deployment
sequence is now:

1. `createReserve` + `initializeReserveAsset` × N, combined in one transaction
   (signer: connecting wallet, as the new Reserve's manager)
2. Funding the seed amounts: `api/devnet/mint-test-assets` (a DevNet-only
   faucet endpoint, fully server-signed, no user signature) for any fixture
   test-asset legs, **and/or** the creator wrapping their own real SOL
   (idempotent-create their WSOL ATA, `SystemProgram.transfer`, `syncNative`
   -- a real, user-signed transaction, not a faucet call) for a SOL leg
3. `seedReserve` (signer: connecting wallet)

Net: **2 wallet approvals** for fixture-only Reserves, **3** if SOL is one of
the selected assets (the SOL-wrap step is its own transaction). Before any
signature, Review & Deploy now shows a **Wallet Cost Summary** built from
`estimateCreateReserveCost` (real `getMinimumBalanceForRentExemption` calls
against the program's actual account sizes, not hand-rolled math): initial
Reserve funding, account-creation rent, estimated network fees, protocol
fees, and a grand total in SOL and USD, plus plain-language text stating
exactly how many approvals will follow and what each does, and a note that
new Reserve Tokens may briefly show as "Unknown" in wallets like Phantom
until DevNet indexers pick up the mint.

**USD-to-SOL seed funding (part of DEC-0030/DEC-0031, bug found and fixed via
DEC-0032):** a creator specifies the initial Reserve value in USD; each
asset's raw seed amount is computed via `seedRawAmountForAsset` --
`usd * 10**decimals` for the DevNet fixture assets (pegged 1 unit = $1), but
`usdToSolLamports(usd)` (from `zapPricing.ts`, using `SOL_TEST_PRICE_USD`) for
a wrapped-SOL leg, since SOL is not 1:1 with USD. An earlier version of this
code used the fixture-asset formula for wrapped SOL too, asking creators to
wrap ~20x too much real SOL for their stated USD allocation -- caught by
`scripts/verify_e2e_fresh_reserve.ts` (DEC-0032), not by typechecking.

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
- `verify_dynamic_reserve.ts` (DEC-0029, 2026-07-28 corrective pass) -- calls
  the rewritten `swap-sign.ts` handler in-process against the real
  frontend-created Reserve `Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX`,
  confirming it builds a valid Buy transaction and correctly rejects an
  unrelated/unregistered mint with a specific error.
- `verify_e2e_fresh_reserve.ts` (DEC-0032, 2026-07-28 corrective pass) -- the
  most thorough of these: drives the **actual browser client code**
  (`createReserveClient.ts`, `zapClient.ts`, not a reimplementation) from a
  Node script, with a throwaway keypair as the connected wallet and the real
  `api/devnet/*.ts` handlers invoked in-process. Creates a fresh 2-asset
  (fixture mint + wrapped SOL) Reserve, seeds it, Buys, Sells half the
  resulting balance, and re-fetches the Reserve (simulating a page refresh)
  -- all with real signatures, confirming vault balances, Reserve Token
  supply, and the creator's SOL/Reserve-Token balances move exactly as
  computed at every step, with zero hardcoded registration anywhere.

Real transaction signatures, account addresses, and before/after balances
from these runs are in the session's decision log (DECISION_LOG.md) and
PROJECT_STATUS.md.

## DevNet protocol treasury (DEC-0033, 2026-07-28 corrective pass)

`ProtocolConfig.default_protocol_fee_destination` is the single global
destination `collect_fees` mints protocol fee shares to (validated there
since DEC-0023). It is settable only at the one-time `initialize_protocol`
call -- there was no way to change it afterward. A new, minimal, admin-gated
`update_protocol_config` instruction
(`programs/ssr_protocol/src/instructions/update_protocol_config.rs`) adds
that update path, gated by the already-defined (previously unused)
`NotProtocolAuthority` error via a `has_one = authority` constraint. Per-Reserve
manager fee destinations (`create_reserve`'s `fee_destination` param) are a
separate, already-independent field -- new Reserves already inherit the
correct protocol-level treasury automatically the moment `ProtocolConfig`
itself is updated, with no client-side change needed.

**Deployed and verified (DEC-0035).** The instruction was shipped via a real
DevNet program upgrade once the deployer wallet was funded, then called once
to set `default_protocol_fee_destination` to
`EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`. Fee routing was verified with
a real `collect_fees` call against a Reserve with pending fee shares (accrued
by DEC-0032's Buy): the treasury's Reserve Token balance went from 0 (no ATA)
to 200 raw units, and the Reserve's manager received their 800-unit share --
exact evidence, signatures, and before/after balances are in
`docs/project/DECISION_LOG.md` (DEC-0035) and `DEVNET_RUNBOOK.md`.
Notably, `ProtocolConfig.default_protocol_fee_bps` is stored but never read
by any fee-computation code path (each Reserve's own `fee_config` governs its
actual fees) -- it appears to be a vestigial/template field, not a gate.

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
