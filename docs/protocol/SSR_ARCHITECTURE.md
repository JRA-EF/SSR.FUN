<!--
  Locked Gate-2 architecture for the SSR Protocol on Solana DevNet.
  Companion to ACCOUNT_MODEL.md (account/PDA detail) and
  RESERVE_REFERENCE_ANALYSIS.md (where these decisions came from).
  Material decisions from this document are also recorded in
  docs/project/DECISION_LOG.md (DEC-0009 onward).
-->

# SSR Architecture

## 0. Product reconciliation (read this first)

The SSR.fun frontend, as it exists today, contains **two incompatible economic
models** (see the Gate-1 frontend inspection): a NAV-based in-kind mint/redeem
model (`src/domain`, `src/state` -- fully specified in types and fee math, but
**never wired to any UI** -- dead code) and a constant-product AMM buy/sell
model (`src/merge/**` -- the only model any user can actually reach today).

This mission's own instructions mandate, repeatedly and explicitly, that the
protocol's **core** mint/redeem mechanism must be oracle-free, proportional,
and in-kind ("core proportional minting and redemption must not depend on an
oracle"; single-asset/AMM-style entry is "a router... outside core proportional
accounting"). That mandate matches the *dead* native model's intent, not the
*live* merge model's behavior.

**Decision (see DEC-0009): the on-chain SSR program implements the mandated
core -- proportional in-kind mint and redemption, no oracle dependency, exactly
as specified in this document.** The existing AMM buy/sell UI is reclassified
as an optional, non-core **router** concept (mission's own "single-asset
entry"/"swap-router entry and exit" category) -- it is *not* removed or
redesigned now (out of scope per Phase 1: "do not redesign the frontend except
for narrow changes required to connect real DevNet functionality"), but it is
explicitly last in the frontend-integration replacement order (item 14 of 14)
and is not part of the core protocol invariants this document defines. A new,
narrow UI surface for proportional mint/redeem will need to be added to the
frontend during Gate 10 -- tracked as a frontend gap, not a silent redesign.

This is recorded as provisional/reversible per the mission's own guidance for
unresolved product decisions: the AMM model's fee fields, buy/sell tax, and
liquidity-pool concepts remain in the frontend and can be revisited (e.g. as a
real Jupiter-backed router) without any change to the core on-chain program
this document specifies.

## 1. Framework choice: Anchor

**Decision: Anchor**, not native Rust/Solana SDK.

Rationale, weighed against the mission's evaluation criteria:
- **Current repository stack**: zero existing Solana code of any kind (confirmed in Gate 1) -- no prior investment in native SDK patterns to preserve.
- **Account validation**: Anchor's constraint system (`#[account(seeds = ..., bump, has_one = ..., constraint = ...)]`) directly implements the cross-Reserve-vault-substitution and account-ownership checks the mission repeatedly calls out as mandatory security invariants -- getting these right by hand in native Rust is exactly the class of mistake (missing an owner/signer check) that causes real fund-loss bugs.
- **IDL generation**: Anchor's generated IDL is the most direct path to a typed TypeScript SDK (Gate 6) and to frontend integration (Gate 10) without hand-maintaining a parallel type definition.
- **Testing ergonomics**: Anchor's TS test harness (`anchor test`, local validator bootstrap, `Program<Idl>` typed client) matches the mission's integration/adversarial-test requirements far better than hand-rolled native transaction construction in every test.
- **Auditability**: Anchor's constraint macros are easier for a future external auditor to verify at a glance than equivalent hand-written `AccountInfo` deserialization/ownership checks scattered through native instruction handlers.
- **Long-term maintainability**: matches the ecosystem's de facto standard for exactly this class of protocol (multi-account, PDA-heavy, permission-gated), reducing onboarding cost for anyone else working on this later.

Trade-off acknowledged: Anchor adds a dependency and a discriminator-prefixed account layout; neither is a real cost for a protocol at this stage.

## 2. Token standard: SPL Token (classic), not Token-2022

**Decision: SPL Token (classic `spl-token` program)** for the Reserve Token mint in v1. Token-2022 support for *Reserve Assets* (basket constituents) is evaluated per-asset, not chosen globally (see below).

Rationale:
- **Wallet/DEX/indexer/custody compatibility**: classic SPL Token has universal support across every wallet, DEX, and indexer in the Solana ecosystem today; Token-2022 support is real but still uneven, and the mission explicitly warns "do not choose Token-2022 merely because it has more features."
- **Reserve Token doesn't need Token-2022's extensions**: the Reserve Token is a plain fungible proportional-ownership share. None of Token-2022's extensions (transfer fees, transfer hooks, confidential transfers, interest-bearing) serve the Reserve Token itself -- a Reserve Token that charged its own transfer fee, for example, would conflict directly with the mission's redemption/mint accounting (which must reconcile exactly against `totalSupply()`).
- **Freeze authority**: none. Setting a freeze authority on the Reserve Token mint would let some address freeze holders' tokens -- directly contrary to "no operator withdrawal powers over Reserve Assets" in spirit (freezing isn't withdrawal, but it's an unwanted custodial power over holder tokens the mission's security-boundary section doesn't want any administrator to have).
- **Close authority**: none on the mint (mints are not closeable in SPL Token regardless; noted for completeness -- there is no close-authority concept for a Mint account, only for empty token accounts).
- **Mint authority**: a PDA derived from the Reserve's own address (`reserve_token_mint_authority`, see `ACCOUNT_MODEL.md`) -- never a human keypair, so token issuance is only ever possible through the program's own mint/redeem instructions.
- **Decimals**: 6 (matches USDC and most Solana stablecoin/asset conventions used as Reserve Assets, keeping proportional math well-scaled without excessive precision loss at small holdings).

**Reserve Assets (basket constituents), by contrast, may legitimately be Token-2022 mints** (e.g. an asset with a transfer fee or interest-bearing extension) -- SSR does not restrict *which* tokens can be used as Reserve Assets to classic SPL Token only. Instead, each `ReserveAsset` config records its `token_program` (SPL Token vs. Token-2022) explicitly, and `initialize_reserve_asset` validates that any Token-2022 extensions present are ones SSR's balance-delta-based mint/redeem accounting can safely handle (see `docs/protocol/SECURITY_INVARIANTS.md` for the exact supported/rejected extension list, directly modeled on Folio's "Weird ERC20s" support-matrix pattern from the reference analysis, §15) -- transfer-fee and transfer-hook extensions that would silently under-collateralize a deposit are **rejected at registration time**, not discovered later.

## 3. PDA seed model

All program-derived addresses are deterministic and namespaced under the program ID, so no two accounts can ever collide across Reserves. Full seed list in `ACCOUNT_MODEL.md`; summarized here:

| Account | Seeds |
|---|---|
| `ProtocolConfig` | `["protocol_config"]` |
| `Reserve` | `["reserve", reserve_id: u64 (or creator pubkey + nonce, see ACCOUNT_MODEL.md open question)]` |
| `ReserveAsset` | `["reserve_asset", reserve.key(), asset_mint.key()]` |
| `ReserveVault` (token account) | `["reserve_vault", reserve.key(), asset_mint.key()]`, owned by `vault_authority` |
| `vault_authority` (PDA, no data account -- signer-only) | `["vault_authority", reserve.key()]` |
| `reserve_token_mint` | `["reserve_token_mint", reserve.key()]` |
| `reserve_token_mint_authority` (signer-only) | `["mint_authority", reserve.key()]` |
| `Delegate` | `["delegate", reserve.key(), delegate_wallet.key()]` |

Every seed list roots through the specific `Reserve`'s own pubkey (itself a PDA off `ProtocolConfig`-independent seeds, see `ACCOUNT_MODEL.md` for the id-vs-creator+nonce decision) -- this is what makes cross-Reserve vault substitution structurally unrepresentable: an instruction that expects `reserve_vault` for `(reserve_A, asset_X)` cannot be satisfied by the token account that actually exists at the seeds for `(reserve_B, asset_X)`, because Anchor's `seeds = [...]` constraint derives and checks the exact expected address, not just "some token account owned by the right mint."

## 4. Instruction boundaries & transaction design

- **Legacy vs. versioned transactions**: versioned transactions (v0) with Address Lookup Tables are used wherever an instruction's account list would otherwise risk exceeding the 1232-byte transaction size limit -- concretely, `mint_reserve_tokens_in_kind`/`redeem_reserve_tokens_in_kind` on a Reserve with many assets (each asset contributes a vault account, an asset mint account, and a depositor ATA to the account list). Reserve creation and single-asset instructions can use legacy transactions.
- **Compute budget**: every instruction that loops over Reserve Assets (mint, redeem, seed, rebalance-record) requests an explicit `ComputeBudgetInstruction::set_compute_unit_limit` sized to the Reserve's actual asset count, computed client-side by the SDK from the Reserve's `asset_count` field, rather than relying on the default 200k-CU budget silently failing on a large basket.
- **Resumable, multi-step Reserve creation**: creation is **not** forced into one transaction. `create_reserve` (metadata + Reserve account + Reserve Token mint) is one instruction; `initialize_reserve_asset` (one per basket asset, creating its vault) is a separate instruction, called once per asset; `seed_reserve` (the actual initial deposit + first mint) is a final separate instruction. This lets a Reserve with, say, 8 assets be created across 10 sequential instructions/transactions instead of forcing everything (including 8 vault-creation CPIs) into one transaction that would blow the size/compute limits for any basket beyond a handful of assets. The Reserve's `status` field tracks `Created -> AssetsInitializing -> Seeded -> Active` so a partially-created Reserve is visibly incomplete on-chain rather than ambiguously "maybe done" (see `ACCOUNT_MODEL.md` and `SECURITY_INVARIANTS.md` for abandoned/partial-init handling).
- **Reserve Asset cap: 12 assets per Reserve (v1 DevNet).** Reasoning: `mint_reserve_tokens_in_kind`/`redeem_reserve_tokens_in_kind` must, in the worst case, include per asset: the asset mint (read-only), the Reserve Vault token account (write), and the depositor's ATA for that asset (write) -- 3 accounts/asset, plus a fixed overhead of roughly 10-12 accounts for the Reserve/Reserve Token mint/depositor's Reserve Token ATA/token program/system accounts. At 12 assets that's ~36-46 accounts, comfortably inside a versioned transaction's ALT-expanded account limit while leaving headroom for compute-budget instructions and remaining accounts, and comfortably matches every basket size actually seeded in the existing frontend mock data (2-6 assets per Reserve, `src/merge/lib/seed-data.ts`). This is a v1 DevNet default, not a hard protocol ceiling -- it lives in `ProtocolConfig` as `max_reserve_assets: u8` so it can be raised later (e.g. once ALT usage is proven out) without a program upgrade being strictly required for the cap itself, only for any change to how accounts are batched.

## 5. Error model

A single Anchor `#[error_code]` enum (`SsrError`) shared across all instructions, grouped by category (validation, authority, arithmetic, state) -- see `docs/protocol/INSTRUCTION_REFERENCE.md` for the full list per instruction. Every arithmetic operation uses checked math (`checked_add`/`checked_sub`/`checked_mul`/`checked_div` or `u128` intermediate widening for mint/redeem ratio math) and maps overflow/underflow to explicit `SsrError::MathOverflow`/`MathUnderflow` rather than allowing a silent panic or wraparound.

## 6. Events

Every state-changing instruction emits a structured Anchor event (`emit!`) carrying enough data for an indexer to reconstruct the action without correlating multiple token-transfer instructions (directly addressing the reference protocol's own gap, RESERVE_REFERENCE_ANALYSIS.md §16). Full event list in `docs/protocol/INSTRUCTION_REFERENCE.md`.

## 7. Authority boundaries (summary; full detail in SECURITY_INVARIANTS.md)

- **`ProtocolConfig` authority**: can pause/unpause the *entire program* (emergency circuit breaker for a systemic bug), adjust `max_reserve_assets` and other global limits, and update protocol-fee-destination defaults for *newly created* Reserves. Cannot touch any existing Reserve's vaults, mint, or holder balances.
  - **Correction (2026-08-18, DEC-0112):** the "can pause/unpause the entire program" clause above does not match the current deployed/repository code. `ProtocolConfig.paused` is a real, checked field (blocks `create_reserve`/`mint_reserve_tokens_in_kind`/`seed_reserve` when true), but no instruction anywhere writes to it after `initialize_protocol` sets it to `false` once at genesis -- **there is currently no on-chain way to pause or unpause the protocol at all**, for `ProtocolConfig.authority` or anyone else. Left uncorrected in the bullet above (preserved, not silently rewritten) so the discrepancy stays visible; see `docs/project/DECISION_LOG.md` DEC-0112 for the full investigation. The other two claims in the bullet (`max_reserve_assets`/global limits, protocol-fee-destination defaults) are accurate -- both go through the one real admin-gated instruction, `update_protocol_config`.
- **Reserve Factory**: purely a set of instructions (`create_reserve`, `initialize_reserve_asset`, `seed_reserve`) plus deterministic PDA derivation -- holds no ongoing authority over any Reserve after creation completes (directly adopting Folio's factory-renounces-itself pattern, RESERVE_REFERENCE_ANALYSIS.md §2).
- **Root Reserve Manager**: full control over their own Reserve's configuration (metadata, targets, fees, delegates, pause) and exclusive control over irreversible actions (authority transfer, unrestricted-delegate grant/revoke). Cannot withdraw Reserve Assets outside a valid redemption or explicitly-validated rebalance-execution flow -- there is no operator-withdrawal instruction anywhere in the instruction set.
- **Delegates**: only the specific permission flags they've been granted; enforced by an Anchor `constraint` check against the `Delegate` PDA's permission bitmask on every gated instruction, not by client-side trust.
- **Frontend/indexer/website/treasury**: no authority of any kind over any Reserve -- everything they can do, a holder could also do directly via the SDK with no website involved (mission's frontend-independence requirement).

**Current real-world holder of `ProtocolConfig` authority and the program's upgrade authority (2026-08-17, DEC-0105):** Creator (Claude User)'s wallet -- "Creator (Claude User)" meaning the individual who currently controls and develops the protocol, never a "Reserve creator" (an SSR.fun user who launches a Reserve via `create_reserve`, an unrelated role with no ongoing authority per the Reserve Factory bullet above). A separate treasury multisig (Creator (Claude User) + the boss), being formed for company treasury assets/transactions only, is explicitly excluded from this authority and from Reserve Asset vault control -- it maps to the "Frontend/indexer/website/treasury" no-authority row above, not to "ProtocolConfig authority." See `docs/project/DECISION_LOG.md` DEC-0105 and `docs/project/PROJECT_STATUS.md`'s "Authority & Treasury Structure" section for the full current-state authority matrix.

## 8. Mainnet USD pricing layer (display-only, off-chain; 2026-08-21 pass, DEC-0134)

The deployed program has no on-chain price oracle and never will for this launch scope -- every mint/redeem instruction is pure in-kind ratio math against real vault balances and Reserve Token supply, with zero USD conversion involved. The USD-denominated figures the frontend shows (Token Price/AUM/Market Cap) are a **pure display-layer construct**, computed entirely off-chain, server-side, from real prices -- never a protocol input, never something an on-chain instruction reads or depends on.

**Sources, in hierarchy order** (`packages/sdk/src/pricing.ts`'s pure validation/hierarchy logic, called by `api/mainnet/asset-prices.ts`, the one server-side endpoint that ever fetches a real price):
1. **Pyth Core** (Hermes REST, `GET /v2/updates/price/latest`) for a small, explicitly verified `mint -> feed ID` map (`MAINNET_PYTH_FEED_IDS` -- currently real USDC and wrapped SOL; every feed ID was live-verified against Hermes's own `/v2/price_feeds` search before being added, never guessed). A quote is accepted only if its feed ID matches the one requested, it's newer than `PYTH_MAX_STALENESS_SEC` (60s), and its confidence interval is within `PYTH_MAX_CONFIDENCE_RATIO` (2%) of the price.
2. **Jupiter Price API V3** (`api.jup.ag/price/v3`, the same paid `JUPITER_API_KEY` already used by `api/mainnet/jupiter-swap.ts`) as the fallback for everything else -- covers real Mainnet SPL tokens with no Pyth feed, including pump.fun-launched tokens like SSR. A quote is accepted only if `usdPrice` is present/finite/positive, its reported `decimals` matches the on-chain-verified value (never trusted unverified), and its `blockId` (a Solana slot) is within `MAX_BLOCK_LAG_SLOTS` of the current slot.
3. When both sources produce a valid quote for the same mint, Pyth's price is used and a **material disagreement is flagged** (`deviationFlagged`), never silently averaged or overridden -- surfaced for future monitoring, not currently blocking.
4. A mint priced by neither source is honestly `{usdPrice: null, source: "unavailable"}` -- **never coerced to 0**.

**Aggregation** (`src/merge/lib/onChainReserve.ts`'s `computeAumFromPrices`): AUM sums `vaultBalance x usdPrice` over every asset the Reserve *materially* holds (nonzero vault balance -- an unheld/zero-weight asset never blocks pricing just because it lacks a feed). If any materially-held asset can't be priced, the whole Reserve's AUM/Token Price/Market Cap report as genuinely unavailable (`pricingComplete: false`) rather than a silently-partial, understated total -- the UI shows "Price unavailable," never a fabricated `$0`. Token Price (displayed) is `AUM / circulating Reserve Token supply` (this protocol's internal NAV -- there is no secondary market yet, every Buy/Sell executes at NAV) and Market Cap is computed independently as `circulating supply x Token Price` (`computeMarketCap`), not just AUM relabeled -- the two are mathematically equal today precisely because Token Price IS NAV in this protocol, and would diverge the moment a real secondary market ever let Token Price trade at a premium/discount to NAV.

**Buy estimate reconciliation**: the "Est. You Receive" figure for a direct Mainnet Buy (`DTRDetail.tsx`) is deliberately **not** derived from USD price at all -- the real on-chain instruction (`mint_reserve_tokens_in_kind` via `packages/sdk/src/directInstructions.ts`) is a proportional in-kind deposit of the Reserve's own asset, no oracle involved. The estimate instead calls the exact same two functions the transaction-builder itself uses (`computeDirectReserveTokensRequested` + `computeNetMintOutput`), against the same live vault balance/supply/Mint Fee bps -- guaranteeing the displayed quote and the submitted transaction can never silently diverge, and keeping the estimate available even during a Pyth/Jupiter outage.

No on-chain program or IDL change was needed for any of this -- it is entirely a client/server display concern. If a future requirement needs the *program itself* to consume a Pyth price on-chain (e.g. an oracle-based liquidation or a USD-denominated fee), that is a materially different, real protocol change requiring a Creator-approved design and Mainnet upgrade, not an extension of this layer.

See `docs/project/DECISION_LOG.md` DEC-0009 through DEC-0016 for the individual confirmed decisions this document synthesizes.
