# SSR DevNet Implementation Plan — cumulative, 2026-07-29

Working plan document. Append further requirements/feedback to this same
file under new dated sections rather than replacing it, so it stays the
single cumulative list for the day. **As of round 3, Phase A is authorized
and implemented — see the "Phase A — implementation record" section near
the end for what actually shipped.** Rounds 1-2 below remain inspection/
design output for Phases B-H, not yet implemented.

> **2026-07-29, round 3 — final product/terminology decisions, Phase A
> authorized and implemented.** Supersedes round 2's open terminology
> question and the round-2 TestLo "please confirm" placeholder. Key
> resolutions: (1) final terminology locked in — "Decentralized Token
> Reserve" is the whole basket, "Reserve" is an underlying holding, "Reserve
> Token" is the basket token (round 2's option (a), scoped: CLAUDE.md's
> existing "Launch Reserve" CTA mandate is superseded — see CLAUDE.md's own
> terminology section for the final wording — while the deployed on-chain
> `ReserveAsset` Anchor struct is explicitly preserved unrenamed); (2) SSR
> DevNet's target end-state is a fully on-chain testing environment, with an
> explicit list of things that must never be simulated and a global
> invariant ("no state-changing action is successful until signed, DevNet-
> confirmed, and refreshed from chain"); (3) a real `devUSDC`/"SSR Test USD"
> DevNet settlement token replaces the retired "Mule" concept, deferred to
> Phase B; (4) Jupiter is Mainnet-only until proven on DevNet by an actual
> executed, wallet-signed, confirmed, balance-verified trade — never assumed
> from an API key alone; (5) TestLo/MOCX confirmed as real user-created
> DevNet state, used to validate general dynamic discovery rather than as a
> hardcoded special case; (6) an 8-phase (A-H) delivery order is locked in,
> and Phase A (mock-state purge + canonical on-chain discovery) is
> implemented in this pass — see the dedicated section below for exactly
> what shipped, what was intentionally deferred, and why.

> **2026-07-29, round 2 — confirmed decisions and corrections applied below.**
> Changes from the first pass: (1) official terminology redefined (see box
> below — **this conflicts with CLAUDE.md's existing mandatory terminology
> and is flagged, not silently resolved**), (2) item 8 corrected — TestLo/MOCX
> is real user-created DevNet state, not a nonexistent scenario, and the
> frontend's dynamic-Reserve-loading mechanism has now been traced, (3) the
> canonical Sell design decision is confirmed (in-kind redemption is primary,
> synthetic SOL cash-out is removed from the canonical flow), (4) delegate-name
> requirements refined, (5) items 4/5 restructured to separate composition
> management from trade execution, (6) item 10 restructured around an
> Active → WindDown → Closed lifecycle, (7) a dependency-ordered delivery-phase
> structure added for items 4/5/10. Round-1 content that these corrections
> supersede has been edited in place (marked) rather than left contradictory.

## Terminology — FINAL decision (2026-07-29, round 3)

Canonical, locked-in terminology:
- **Decentralized Token Reserve** = the complete basket/product (what
  round 1/2 of this document, and the shipped product's copy, previously
  called "Reserve").
- **Reserve** = each underlying asset held inside a Decentralized Token
  Reserve (e.g., MOCX is *a Reserve* inside the "Strategic Sol Reserve"
  Decentralized Token Reserve) — this is the inverse of what round 1 of this
  document and CLAUDE.md's pre-existing mandatory-terminology section used
  to mean by "Reserve."
- **Reserve Token** = the fungible token representing ownership of the
  complete Decentralized Token Reserve.
- User-facing copy going forward: **"Launch a Decentralized Token
  Reserve,"** not "Launch a Reserve," wherever the whole product is meant.
  "Reserve" alone is used only for an underlying holding in new copy.
- Do not use "BYOR," "BOR," "DTR Asset," or "Reserve asset" in new copy,
  documentation, prompts, or safely-renameable frontend identifiers.

**Round 2's conflict is resolved — this supersedes both of round 2's
options (a)/(b).** CLAUDE.md's "Mandatory terminology" section (the
"Launch Reserve" CTA mandate) has been updated in this pass to record this
final decision, replacing its prior "Reserve"-as-whole-basket framing;
see CLAUDE.md itself for the authoritative current wording, and
`DECISION_LOG.md` for the entry recording the change and its rationale.

**On-chain/code-identifier exception, confirmed and unchanged in
substance:** the deployed Anchor account struct `ReserveAsset`
(`programs/ssr_protocol/src/state/reserve_asset.rs`) is **not** renamed and
must never be — Anchor derives each account's on-chain discriminator from
its struct name at compile time, so renaming it would change the
discriminator new builds expect and break deserialization of every
already-initialized `ReserveAsset` account on live DevNet, including
TestLo's. This is documented as a deliberate legacy technical identifier,
not approved product terminology — a one-line doc comment to this effect
has been added at the top of `state/reserve_asset.rs`. The same reasoning
applies to `Reserve`, `Delegate`, and `ProtocolConfig` (all deployed Anchor
account structs) — none are renamed. `DTRAsset`/`CreateDTRAssetInput`
(`src/merge/lib/types.ts`, pure TypeScript types, no on-chain implications)
remain a safe-rename candidate for a future pass but were not renamed in
Phase A, to keep this pass's diff scoped to discovery/mock-purge work
rather than a repo-wide identifier rename.

**Additional code-identifier note:** `DTRAsset`/`CreateDTRAssetInput`
(`src/merge/lib/types.ts:4,190`, used in `calculations.ts`, `seed-data.ts`,
`CreateDTR.tsx`) are real, already-shipped TypeScript type names matching
the now-disfavored "DTR Asset" phrasing — a safe rename candidate (pure
TS-side type name, no on-chain implications) once (a) vs (b) above is
decided, but not renamed in this pass since no code changes were authorized.
Separately, the **on-chain Anchor account struct is literally named
`ReserveAsset`** (`programs/ssr_protocol/src/state/reserve_asset.rs`) —
**this one is not a safe rename**: Anchor derives each account's on-chain
discriminator from its struct name at compile time, so renaming this Rust
struct would change the discriminator new builds expect, breaking
deserialization of every already-initialized `ReserveAsset` account on live
DevNet (including TestLo's). Recommend leaving the Rust/Anchor identifier
untouched regardless of (a)/(b) and treating it as an intentional,
documented exception — e.g. a one-line doc comment noting the product-level
name differs from the on-chain struct name for compatibility reasons. A repo
search also turned up "BYOR" exactly once, in
`docs/project/ENGINEERING_TIMELINE.md:33,172`, describing the project's
actual original Replit-era name ("Build-Your-Own-Reserve") as historical
fact in a timeline entry — not new copy, so left as-is; no other BYOR/BOR
occurrences exist in the repo.

---

## Final DevNet objective (2026-07-29, round 3)

**SSR DevNet must become a fully on-chain testing environment.** Economic
value and reference pricing may be simulated and clearly labelled (DevNet
assets have no real financial value regardless). The following must
**never** be simulated: tokens/token balances, Decentralized Token
Reserves, Reserve composition, vaults/vault balances, Reserve Tokens and
supply, purchases and redemptions, fees and treasury transfers,
permissions and delegates, lifecycle changes, wallet approvals, transaction
submissions/confirmations, and successful state-changing outcomes.

**Global invariant, binding on every phase from here forward:** *"No
state-changing action is successful until the connected wallet signs the
transaction, it is confirmed on Solana DevNet, and the application
refreshes the resulting state from the chain."* Phase A's mock-state purge
(below) is the first enforcement pass of this invariant — it targets
*display/discovery* honesty (no state-changing actions were added or
removed in Phase A); Phases B-H extend the same invariant to real
settlement, minting, fees, composition changes, and wind-down as each is
built.

## DevNet asset architecture (2026-07-29, round 3) — Phase B, not built yet

Confirmed target architecture (**not implemented in Phase A** — recorded
here so it isn't lost, per the instruction to preserve all subsequent
approved phases):
- DevNet SOL pays network fees, account rent, and any protocol fee
  explicitly denominated in SOL.
- A real, controlled, on-chain DevNet settlement token replaces the
  retired "Mule" name/concept — working identity **"SSR Test USD"
  (`devUSDC`)**. Before creating a new mint, Phase B must first check
  whether a suitable existing DevNet SPL-token mint can already serve this
  role (e.g. a well-known DevNet USDC-like test mint), rather than
  reflexively minting a new one.
- Underlying Reserves and Reserve Tokens are real DevNet SPL-token mints
  (Reserve Tokens already are, via `create_reserve`'s
  `reserve_token_mint`).
- All transfers/minting/burning/fee collection/deposits/withdrawals/
  purchases/redemptions occur on-chain; the DevNet treasury receives
  protocol fees through confirmed on-chain transfers (the treasury-routing
  half of this already works today per DEC-0035 — Phase B extends it to
  `devUSDC`-denominated flows specifically).
- Sponsored onboarding may eventually give new users a small amount of
  DevNet SOL so the public faucet isn't the sole onboarding dependency.

**Explicitly deferred, not started:** the `devUSDC`/SSR Test USD mint
itself, its faucet, and sponsored SOL onboarding are Phase B work. Nothing
in Phase A creates a new token mint or faucet.

## Jupiter and trading (2026-07-29, round 3)

Jupiter is the intended **Mainnet** routing layer only. It must never block
the fully-on-chain DevNet environment, and it must never be *assumed*
available on DevNet from an API key alone. Before any later phase claims
"Jupiter DevNet support," it must prove, with evidence: a real quote for
the selected DevNet mints, an executable transaction actually targeting
DevNet, a real wallet signature, a real confirmed DevNet transaction, and
verified before/after SPL-token balance changes. If Jupiter cannot execute
viable DevNet routes (the likely outcome, given DevNet's thin liquidity),
the smallest legitimate controlled on-chain DevNet liquidity/swap mechanism
for representative test assets must be used instead — never fake Jupiter
quotes, synthetic transfers, or locally-manipulated balances. **Direct
proportional redemption into the underlying Reserve(s) remains the
canonical Sell path regardless of Jupiter's DevNet feasibility**;
"Redeem and swap" is strictly optional and gated on a real executable
route existing (see item 8, and Phase A's interim treatment of the
existing fixed-rate SOL settlement leg below).

## Delivery phases A-H (2026-07-29, round 3 — final, supersedes round 2's item-scoped phase list)

Cumulative toward one eventual DevNet delivery; each phase's protocol-
changing work (where applicable) still follows: (1) security-invariant
analysis, (2) architecture/decision-log updates, (3) Rust implementation +
program tests, (4) DevNet deployment + live verification, (5) TypeScript
SDK support, (6) frontend integration, (7) complete end-to-end
verification — never skipping ahead to (6) before (1)-(5) land.

- **Phase A — mock-state purge and canonical on-chain discovery.**
  Implemented this pass; see "Phase A — implementation record" below.
- **Phase B** — real DevNet settlement mint (`devUSDC`), faucet, sponsored
  SOL onboarding. Not started.
- **Phase C** — real creation, funding, Reserve Token minting, and direct
  (in-kind) redemption using the settlement token. Not started (creation
  already exists from the prior corrective pass — Phase C is about wiring
  it to `devUSDC` and completing direct redemption's execution path, not
  building creation from scratch).
- **Phase D** — fee and treasury settlement verification (extends the
  already-working DEC-0035 treasury routing to the new settlement flows).
  Not started.
- **Phase E** — Jupiter feasibility proof and/or genuine on-chain swap
  execution for the optional "redeem and swap" leg. Not started.
- **Phase F** — composition management (item 4/5's config-vs-execution
  split) and actual rebalance trade execution. Not started; security
  analysis for the new instructions is the first step when this phase
  opens.
- **Phase G** — staged wind-down (Active → WindDown → Closed, item 10).
  Not started.
- **Phase H** — complete frontend integration and live end-to-end DevNet
  verification across everything above. Not started.

**Do not start Phase B or later in this pass** — this document records
them so nothing already-approved is lost, not as authorization to build
them now.

---

## 1. Network label ("Solana DevNet" / remove "Testing Environment")

**Files:** `src/components/Shell.tsx:100-113` (badges), `src/index.css:319-343` (`.sim-badge`/`.testing-badge` styles), `src/index.css:1914-1915` (mobile hides both).

**Root cause / current state:** A "Solana DevNet" badge **already exists** (`Shell.tsx:108-110`) sitting directly next to a separate "Testing Environment" badge (`Shell.tsx:111-113`). So this item is narrower than "add a DevNet label" — it's **remove the Testing Environment badge and keep/tighten the existing DevNet one**. Related pre-existing issue surfaced during inspection: both badges are `display: none` on small screens (`index.css:1914-1915`), so mobile currently shows **no** environment indicator at all — worth fixing in the same pass so "DevNet remains clearly identifiable" holds on mobile too.

**Frontend-only.** No protocol involvement.

**Dependencies/risks:** None. Purely additive/subtractive text+CSS change. No Mainnet toggle exists anywhere (confirmed via repo-wide search) — nothing to accidentally imply.

**Acceptance criteria:**
- "Testing Environment" string/badge no longer renders anywhere in the header.
- A "Solana DevNet" badge is visible in the top-left nav region on desktop **and** mobile viewport widths.
- No new UI element references "Mainnet" as an available/selectable network.
- Footer disclaimer (`Shell.tsx:155-159`) and `WalletModal.tsx` copy remain consistent (still say DevNet, not Mainnet).

**Tests:** Visual/DOM check (snapshot or manual) at desktop + mobile breakpoints confirming badge text and absence of "Testing Environment".

---

## 2. "Discover Reserves" terminology (landing page)

**Files:** `src/pages/Home.tsx:80` (hero button, currently "Browse Reserves"), `src/pages/Home.tsx:217` (lower-section button inside the "Transparent by construction" section, `Home.tsx:207-219`, currently "Browse Reserves"), `src/components/Shell.tsx:9,114-120` (header nav, already "Discover Reserves"), `src/components/Shell.tsx:165` (footer, already "Discover Reserves"). All four/five links point to `/discover`, routed in `src/App.tsx:42-48` to `src/merge/pages/Discover.tsx` — confirmed single, consistent destination already.

**Not explicitly in scope but flagged for consistency:** `Home.tsx:120`, a "View all →" link next to "Featured Reserves", also routes to `/discover`. Not named in the requirement; leaving as-is unless you want every `/discover` entry point standardized to identical copy.

**Frontend-only.** Two string replacements.

**Acceptance criteria:**
- Zero occurrences of "Browse Reserves" remain in `src/pages/Home.tsx` (or anywhere else in the app).
- Hero CTA and the "Transparent by construction" section CTA both read "Discover Reserves".
- All "Discover Reserves" actions (header, footer, hero, lower section) navigate to `/discover` and render `Discover.tsx`.

**Tests:** Grep for `Browse Reserves` returns nothing; click-through/route assertion for all instances landing on `/discover`.

---

## 3. Simulated landing-page statistics disclosure

**Files:** `src/pages/Home.tsx:55-61` (data derivation — `tvl`, `holders` reduced from `useStore().reserves`; `volume24h = tvl * 0.054`, explicitly commented as fictional), `src/pages/Home.tsx:87-108` (`.kpi-strip` render), `src/data/reserves.ts` (`SEED_RESERVES`), `src/data/mock.ts` (PRNG mock generators), `src/state/store.tsx:168`.

**Root cause:** Confirmed fully mocked/deterministic-seeded data, not live on-chain aggregation. **Confirmed: zero disclosure exists near the KPI strip today** — the only "mocked" admission on the whole page is in the page footer (`Shell.tsx:155-159`), structurally and visually disconnected from the stats block above.

**Frontend-only.**

**Dependencies/risks:** None technical. Product-copy judgment call only: exact wording, placement (directly under `.kpi-strip`, not a tooltip/asterisk that's easy to miss), and typographic weight so it isn't legal fine print.

**Acceptance criteria:**
- A visible, legible line (not <11px, not a low-contrast/tooltip-only affordance) appears immediately below the `.kpi-strip` grid, e.g. "Simulated DevNet data shown for demonstration purposes only."
- Passes a basic contrast check (not decorative-muted to the point of illegibility) — reuse an existing readable text style, not the smallest `.faint`/fine-print class in `index.css`.
- Does not duplicate/contradict the footer disclaimer; can cross-reference it.

**Tests:** Visual check that the disclosure renders above the fold alongside the KPI strip and meets a minimum font-size/contrast bar.

---

## 4. Composition management (Manager Dashboard → Rebalance tab)

> **2026-07-29, round 2 — restructured per confirmed decision.** Item 4
> ("composition management": add/disable/remove a Reserve, change target
> weights) and item 5 ("trade execution/rebalancing": actually moving
> holdings toward those weights) are now explicitly tracked as two separate
> concerns, per your instruction that "a signed target-weight update is not,
> by itself, an executed rebalance." Everything below in item 4 is
> **configuration only** — nothing here moves any assets between accounts.

**Files:** `src/merge/pages/ManageDTR.tsx:444-570` (rebalance tab, weight-only sliders over `dtr.composition`), `src/merge/pages/CreateDTR.tsx:166,172` (`addAsset`/`removeAsset` — exist only in the pre-launch creation flow, not reachable from Manage), `src/merge/store/useAppStore.ts:531-545` (`rebalanceDTR`, fully local Zustand mutation, no chain write), `src/merge/lib/onChainReserve.ts` (read-only on-chain merge for the 2 fixture Reserves), `programs/ssr_protocol/src/instructions/update_targets.rs`, `initialize_reserve_asset.rs`, `state/reserve_asset.rs` (`enabled` field), `constants.rs:32,39` (`DEFAULT_MAX_RESERVE_ASSETS=12`, `ABSOLUTE_MAX_RESERVE_ASSETS=24`), `state/protocol_config.rs:15` (`max_reserve_assets`).

**Confirmed root cause / protocol gap — this is the central blocker for item 4 as literally specified:**
- **Reweighting existing assets**: fully supported today (`update_targets`), but currently implemented as **local-only simulation** in the frontend — no call into `packages/sdk`/on-chain write exists in `ManageDTR.tsx` today, contradicting "this must be real DevNet functionality."
- **Adding a new asset**: `initialize_reserve_asset` can create a new `ReserveAsset` + vault — but **only while the Reserve is in `Created`/`AssetsInitializing` status**, i.e. before it ever goes `Active`. There is **no instruction to add an asset to an already-active/seeded Reserve.**
- **Removing an asset**: **no instruction exists at all.** `ReserveAsset.enabled` is a field that reads as if it supports "disable an asset" (per `ACCOUNT_MODEL.md:158`), but it's set `true` once at creation and **never written again by any instruction** — there is no on/off toggle, let alone a vault-close/removal path.
- **Asset-count limit**: real and enforceable (`ProtocolConfig.max_reserve_assets`, checked today only in `initialize_reserve_asset.rs:74-77`, i.e. only pre-Active).

**Classification: requires protocol changes**, not just frontend work. See item 5 for what's config-only vs. what actually needs to move assets. The frontend piece (add/remove/reweight UI, duplicate/invalid-asset validation, preview-before-submit) can be designed now, but must sit behind whatever new instructions item 5 defines — building the UI against nonexistent chain calls would violate "do not pretend frontend changes alone can provide functionality the deployed program does not support."

**Configuration-only vs. asset-moving, made explicit (per your instruction to separate these):**

| Operation | Moves assets? | Instruction status |
|---|---|---|
| Reweight existing Reserves (targets only) | No — config only | ✅ Exists: `update_targets` |
| Add a new supported Reserve, pre-Active | No new transfer — creates an empty vault | ✅ Exists: `initialize_reserve_asset` (pre-Active only) |
| Add a new supported Reserve, post-Active | No new transfer needed at creation (new vault starts at 0) — but **actually reaching the new target weight requires a trade**, which is item 5's concern | ❌ No instruction to create the vault post-Active at all |
| Disable/remove a Reserve | No — config only (existing balance stays put until traded/redeemed) | ❌ No instruction flips `enabled` or closes a vault |
| Vault creation | N/A (see above) | Only via `initialize_reserve_asset`, pre-Active |
| Vault withdrawal/closure | Moves nothing on its own; only meaningful once balance is zero | ❌ Doesn't exist (ties to item 10's `close_reserve`) |

So "add/remove a Reserve" is itself config-only (it changes what the Reserve *is configured to hold and target*, not what it *currently holds*) — the actual asset movement to reach a newly-added Reserve's target weight, or to fully exit a disabled one, is trade execution, covered in item 5.

**Dependencies:** Item 5's config-only instructions (asset add/disable) must land first, or in lockstep, before this UI can be wired for real. Reuse existing `Card`/`Table`/`Badge`/`Input`/`Checkbox` components already used in `ManageDTR.tsx` per the "reuse existing design patterns" instruction — no new component library needed.

**Acceptance criteria (once protocol support exists):**
- Manager can add a new supported Reserve (subject to `max_reserve_assets`), remove/disable an existing one, and adjust weights, all previewed together (net diff: additions, removals, before/after weights) before submission.
- Submission is blocked client-side (and rejected on-chain) if: asset count would exceed `max_reserve_assets`, a duplicate mint is added, weights don't reconcile to 100% (or the protocol's actual target-weight invariant — verify exact bps-sum rule in `update_targets.rs`/`common.rs` before finalizing validation copy), or the asset mint fails whatever mint-safety check the protocol defines (e.g. must be a real SPL/Token-2022 mint, decimals within supported range).
- The UI never implies that submitting a composition-management transaction has itself moved any holdings toward the new targets — copy explicitly distinguishes "target updated" from "rebalanced" (see item 5).
- No client-side "optimistic" composition change is shown as final until an on-chain confirmation returns.

**Tests:** Unit tests for the new validation logic (count limit, duplicates, weight-sum); an on-chain integration test (DevNet, mirroring the existing `scripts/verify_*.ts` pattern) exercising add/disable/reweight against a real fixture-like Reserve once the instructions exist.

---

## 5. Trade execution / rebalancing (distinct from item 4's configuration)

> **2026-07-29, round 2 — restructured and renamed per confirmed decision.**
> This item now covers only **moving actual holdings** toward configured
> target weights, and the mechanics of composition changes that require
> asset movement (vault creation for a newly-added Reserve, vault
> withdrawal/closure for a disabled one). It does **not** cover the
> config-only reweight/add/disable transactions themselves (item 4).
> **A signed `update_targets` (or a signed add/disable) call is a completed
> configuration change, never an executed rebalance — the two must never be
> labeled interchangeably in any UI copy, decision log entry, or test name.**

**Files:** `programs/ssr_protocol/src/instructions/update_targets.rs` (config-only reweight, real instruction, manager or delegate with `UPDATE_TARGETS`/bit 1), `record_rebalance.rs` (attestation-only, **not a trade**, manager or delegate with `EXECUTE_REBALANCE`/bit 3), `initialize_reserve_asset.rs` (vault creation, pre-Active only), `state/reserve.rs` (`require_not_paused`, status enum), `packages/sdk/src/zapInstructions.ts` / `packages/sdk/src/client.ts` (where new instruction builders would live), `src/merge/pages/ManageDTR.tsx` (execute/preview UI), existing DevNet transaction-status pattern already shipped for Buy/Sell in `src/merge/pages/DTRDetail.tsx` (pending/submitted/confirmed/failed + Explorer link) — **reuse this pattern rather than inventing a new one.**

**Confirmed root causes / protocol audit result:**
- `update_targets` changes configuration only — it never moves a single token. Wiring it to real wallet signing is frontend-only work with no protocol change needed, **but the UI must call it what it is: a target-weight update, not a rebalance.**
- `record_rebalance` **does not execute a trade on-chain** — it's explicitly documented (DEC-0017/DEC-0021, `SECURITY_INVARIANTS.md`) as attestation/logging of a trade performed by some external, unspecified means. Any UI implying "rebalance executes a trade" would misrepresent what the signed transaction actually does.
- **Real DevNet swaps availability: none exist today.** There is no Jupiter (or any other router/AMM) integration anywhere in this repo, and no CPI to any swap program in `programs/ssr_protocol/src/` — confirmed by the same grep that found `record_rebalance`'s doc comment disclaiming trade execution. The only "swap"-shaped code in the whole repo is the DevNet-only fixed-price Buy/Sell zap (`packages/sdk/src/zapInstructions.ts`, item 8), which is not a general-purpose router and isn't wired to `record_rebalance` at all. **Conclusion: there is currently no legitimate way to actually execute a rebalancing trade on DevNet, in-protocol or otherwise, other than a human manually moving tokens outside the app and then calling `record_rebalance` to log it** (exactly as the instruction's own doc comment describes v1's intended manual workflow).
- Adding/disabling Reserves has **no supporting instruction today** (see item 4's table) — blocking gap for the "vault creation/closure" half of trade execution too.

**Classification: mixed, and now cleanly separated:**
- **Config-only, frontend-only:** wire `update_targets` through real wallet signing (no protocol change).
- **Attestation-only, frontend-only but must be labeled carefully:** wire `record_rebalance` through real wallet signing as "record a manually-executed rebalance," never as "execute a rebalance" — the UI must make clear the trade itself happened off-chain/manually and this call only reconciles the record.
- **Genuinely blocked on new protocol instructions:** (a) a vault-creation instruction usable post-Active for a newly-added Reserve (relaxing or duplicating `initialize_reserve_asset`'s status guard, with new security review — adding a zero-balance Reserve into an Active Reserve's target-weight math must be reasoned against `SECURITY_INVARIANTS.md`'s supply invariant), and (b) a `disable_reserve_asset` instruction that flips `ReserveAsset.enabled = false`, excludes it from future target-weight validation, and leaves its existing vault balance redeemable until fully withdrawn (matching intent already documented in `ACCOUNT_MODEL.md:158` but never implemented) — plus, eventually, a vault-withdrawal/closure step once a disabled Reserve's balance reaches zero (ties directly to item 10's `close_reserve` design, since both are "safely retire an account only once nothing is owed against it").
- **An actual on-chain trade-execution instruction (e.g. a Jupiter CPI) is out of scope for this pass** — it would be a materially larger protocol addition than anything else in this plan and was explicitly deferred in v1 (DEC-0017/DEC-0021); flagging that "trade execution" in this item means "let the frontend correctly represent and sign the config/attestation instructions that exist," not "add real DevNet swap routing," unless you want to scope that in separately.

**How holders stay protected / how supply and NAV invariants hold, across all of this:**
- Reweighting alone (`update_targets`) never touches any vault balance or the Reserve Token supply — NAV/AUM (computed off real vault balances ÷ real supply, see item 8) are unaffected by a target change alone until an actual trade moves tokens.
- A newly-added, zero-balance Reserve at a nonzero target weight does not retroactively change any holder's existing entitlement — proportional redemption (item 8's traced math) always uses *current* vault balances, so nothing is stranded or diluted by the config change itself; the "gap" between target and actual only closes once a real trade (manual, per the doc comment, in v1) moves tokens in.
- A disabled Reserve's existing vault balance must remain redeemable (per `ACCOUNT_MODEL.md:158`'s already-documented intent) until it reaches zero — this is the same invariant item 10 needs for wind-down, and should share one security review and one implementation pattern rather than two.

**Authorization (confirmed from code, unchanged, nothing new needed):** manager always allowed; delegate requires the specific bit (`UPDATE_TARGETS` for reweight, `EXECUTE_REBALANCE` for the attestation call). Both instructions already require the Reserve not be `Paused`.

**Dependencies/security risks:**
- Any new "add vault post-Active" or "disable Reserve" instruction needs explicit security-invariant analysis against `SECURITY_INVARIANTS.md` before being written (see item 7/delivery-phases below) — a genuine open design question, not just an engineering task.
- `record_rebalance`'s `balances_before` is caller-supplied and not independently verified (explicitly flagged in its own doc comment) — the UX must not imply stronger guarantees than the instruction actually provides, and copy must never call this step "executing a rebalance."

**Acceptance criteria:**
- Wallet must approve and sign every configuration and rebalance-record transaction; no optimistic local state changes ship before confirmation.
- UI shows pending → wallet-approval → submitted → confirmed/failed, with a "simulate first" step (matches the existing rent/cost-preview pattern from the corrective pass, DEC-0031) before requesting a signature.
- On confirmation: shows the transaction signature + a Solana Explorer link (reuse the existing Buy/Sell Explorer-link pattern), and only then refreshes displayed composition/balances from a fresh on-chain read.
- UI copy strictly distinguishes "target weights updated" (config only, `update_targets`) from "rebalance recorded" (`record_rebalance`, attestation of a manual trade) — never presents either as "rebalance executed" in the trade-execution sense.
- Add/disable-Reserve UI paths are gated (disabled with an explanatory message) until the corresponding new instructions are designed, reviewed, and deployed — not shipped as a silent no-op or a fake success state.

**Tests:** DevNet integration test analogous to `scripts/verify_zap.ts`, exercising a real `update_targets` call and a real `record_rebalance` call through wallet-style signing, each asserting the correct (and only the correct) on-chain state changed; once new instructions exist, equivalent scripts for vault-add/disable, plus a test asserting `record_rebalance` alone never changes any vault balance or Reserve Token supply.

---

## 6. Delegate names

> **2026-07-29, round 2 — confirmed decision, requirements refined.** For
> the present DevNet version, delegate names are confirmed as **off-chain
> local labels, keyed by (Reserve, delegate public key)** — no protocol
> migration for display names. The open question from round 1 (cross-device
> persistence) is resolved: **not required now**, but must be documented as
> a known limitation, not silently assumed.

**Files:** `programs/ssr_protocol/src/state/delegate.rs:38-59` (on-chain `Delegate` struct — `reserve, wallet, permissions, restricted, added_at, bump`, **no string/label field, no space allocated for one**), `lib.rs:138-145`/`add_delegate.rs:41-46` (instruction args: `delegate_wallet, permissions, restricted` — **no name parameter**), `src/merge/lib/types.ts:24-28` (frontend `Delegate` type, also no name field today), `src/merge/pages/ManageDTR.tsx:396-440` ("Add New Delegate" form — wallet address + permission checkboxes only). **Precedent (unused/dormant):** `src/domain/types.ts:56-60` already defines a `label: string` field on a differently-shaped, currently-unwired native `Delegate` type — not connected to the live Merge dashboard, but a useful shape reference.

**Root cause:** the chain has no concept of a delegate name — adding one is structurally an off-chain concern. Growing the on-chain `Delegate` account to hold a string would mean a program upgrade (new account size, migration for existing DevNet delegate accounts) purely to store a display label with no protocol logic depending on it — almost certainly not worth a program change.

**Classification: frontend/off-chain-only — confirmed, no protocol migration.** The name is an off-chain annotation keyed by `(reserve, delegate wallet pubkey)`, stored in the same Zustand-persisted store that already holds all other Manager-Dashboard state (`useAppStore.ts`, `persist` middleware, `localStorage` key `"ssrfun-simulation"`) — no new backend/API infrastructure is introduced solely for this.

**Confirmed requirements (per round-2 decision):**
- The label is explicitly identified in the UI as a **local label** (e.g. a small "local label" tag/tooltip next to the name, or equivalent copy) — never presented as if it came from the chain.
- **Wallet address, capabilities, scope, activation/restricted status, and authorization must always be read from verified on-chain state** (the existing `Delegate` account fields — `wallet`, `permissions`, `restricted`, `added_at`) — the local label is purely a display convenience layered on top, never a substitute for or influence on any authorization check.
- If no local label exists for a given `(reserve, wallet)` key (e.g. a delegate added by someone else's browser, or before this feature existed, or on a fresh device), the UI **must fall back cleanly to the shortened public key** — never show a blank, an error, or a placeholder that looks like missing/broken data.
- **Delegate functionality (granting, revoking, permission checks, display of capabilities) must not depend on a label being present** — a nameless delegate must work identically to a named one in every functional respect; the label is decorative/organizational only.
- **Documented limitation, not silently assumed:** labels are local to the browser/device that set them and do **not** automatically follow the user across browsers or devices — confirmed acceptable for the present DevNet version. This must be stated in-product (e.g. helper text near the name field) and in `docs/protocol/FRONTEND_INTEGRATION.md`/this plan, not left as an undocumented surprise.
- **No protocol migration is being introduced** to store display names — the on-chain `Delegate` struct (`state/delegate.rs:38-59`) stays exactly as-is; this closes out round 1's "grow the account to hold a string" option entirely.

**Acceptance criteria:**
- Adding a delegate requires a non-empty human-readable local label before submission.
- The label is stored and displayed alongside the delegate's on-chain wallet address, capabilities, scope, and status everywhere a delegate appears (Delegates tab, and the new Overview section in item 7), always clearly marked as a local label.
- Any delegate lacking a locally-stored label (different browser/device, or pre-dating this feature) falls back to a shortened-address display with full functionality intact — verified by a test that clears local storage and confirms the delegate still renders correctly (address-only) and remains fully manageable.
- No UI surface implies the label is on-chain-verified or synced across devices.

**Tests:** Form validation test (empty label blocked on add); rendering test confirming the label displays consistently in both the Delegates tab and the new Overview section; a fallback test that simulates a missing local label (empty/cleared `localStorage` for that key) and confirms shortened-address fallback with unimpaired delegate management functionality.

---

## 7. Delegates section in Manager Overview

**Files:** `src/merge/pages/ManageDTR.tsx:218-315` (Overview tab — currently only a bare count, `Total Delegates: {dtr.delegates.length}` at lines 265-266), `src/merge/pages/ManageDTR.tsx:317-442` (existing Delegates tab, source of the real per-delegate data — address, permission badges — to reuse), component set already imported in this file: `Card`/`CardContent`/`CardHeader`/`CardTitle`, `Table`/`TableBody`/`TableRow`/`TableCell`, `Badge`, `Avatar`/`AvatarFallback` (same family `Portfolio.tsx` uses for its holdings table — good precedent for a compact delegate summary table).

**Frontend-only**, and depends on item 6 for the name field to exist in the data model first (build the Overview section to show the name once it exists, rather than shipping a name-less version and reworking it later).

**Acceptance criteria:**
- Overview tab gains a "Delegates" card/section listing each delegate with: name (item 6), shortened address with a way to reveal/copy the full address, active/inactive-equivalent status, granted capabilities (reuse the existing permission-badge rendering from the Delegates tab), and any scope/restriction indicator (the existing `restricted` boolean).
- A clear affordance (button/link) from each row navigates to the existing Delegates tab (or a per-delegate management view) to manage that delegate.
- Uses the same `Card`/`Table`/`Badge`/`Avatar` components already in this file — no new visual language introduced.

**Tests:** Rendering test with 0, 1, and N delegates (empty state, singular, plural); link/navigation test to the management view.

---

## 8. TestLo / MOCX sell-estimate — corrected, canonical Sell design decided, Phase A implemented

> **2026-07-29, round 3 — confirmed final, Phase A ships general dynamic
> discovery (not a TestLo special case).** Round 1 incorrectly concluded
> TestLo/MOCX "doesn't exist" because it isn't in the committed fixture
> files; round 2 asked for confirmation. **Confirmed final: TestLo
> (handle) / "Strategic Sol Reserve" (Decentralized Token Reserve name),
> MOCX (underlying Reserve), ~1,004 Reserve Tokens held, is genuine
> user-created on-chain DevNet state**, and must never be treated as
> invalid merely for being absent from repository fixtures. Per instruction,
> TestLo is used to validate the *general* canonical discovery architecture
> (Phase A, below) — it is not hardcoded as a special frontend case anywhere.
> **The displayed estimate was not adjusted by hand** — Phase A instead
> replaced the estimate's entire computation path with one driven by
> verified live on-chain data (see "Phase A — implementation record").
>
> **Closed-universe finding relevant to "what information is still
> needed":** `src/merge/pages/CreateDTR.tsx`'s real-deployment path only
> ever lets a Decentralized Token Reserve be composed from 4 known mints —
> native/wrapped SOL plus the 3 fixture test mints (`mintX`/`mintY`/`mintZ`,
> on-chain symbols "mockX"/"mockY"/"mockZ") — so "MOCX" almost certainly
> **is** one of these three under the name the user knows it by, not an
> unknown fifth mint. Phase A's discovery layer includes all 4 as
> candidate-mint hints, so TestLo's actual composition should resolve
> automatically without needing a separately-supplied mint address — see
> the implementation record for confirmation once run.
>
> **A second closed-universe finding solves most of the "what's needed to
> discover TestLo" question too:** `create_reserve`'s `metadata_uri` field
> is populated by the real-deployment path as a literal
> `data:application/json,...` URI embedding the Decentralized Token
> Reserve's name/ticker/description/category directly **on-chain** (see
> `CreateDTR.tsx`'s `handleSubmitReal`) — so "TestLo" and "Strategic Sol
> Reserve" are themselves recoverable straight from the Reserve account's
> own on-chain field, with a safe honest-fallback parse (never fabricated)
> for any Reserve whose `metadata_uri` isn't in this exact shape (e.g. the
> two fixtures, which predate this convention). This meant Phase A did not
> need to ask you for TestLo's name/ticker separately — only its Reserve
> PDA/id remains something Phase A's enumeration-by-`reserveId` approach
> resolves on its own (see below), not something requiring manual input.

**1. Root-cause mechanism (still stands, was verified against real code, not fixture-specific):** The trace in round 1 read the general Sell computation path (`DTRDetail.tsx:179,782`, `zapInstructions.ts:186-254`, `swap-sign.ts:77-80,236-275`, `onChainReserve.ts:129-169`, `redeem_reserve_tokens_in_kind.rs`) directly from source, not from fixture data — that mechanism applies identically to TestLo, a fixture Reserve, or any other Reserve, since the Sell code path doesn't branch on which Reserve it's handling. **The mechanism finding stands:** Sell always redeems in-kind on-chain first (correct proportional math), then unconditionally zaps the redeemed asset into fixed-price SOL via a DevNet-only swap authority (`SOL_TEST_PRICE_USD = 20`), regardless of composition — which is why AUM≈$1,000, NAV≈$1, and a ~50 SOL estimate are all simultaneously "correct" outputs of that specific mechanism for *any* Reserve at that AUM, TestLo included. This is a design/disclosure issue, not a decimals or arithmetic bug (see round 1's ruled-out list, unchanged).

**2. How the frontend discovers/loads a dynamically-created on-chain Reserve like TestLo — investigated, and this is the real gap to close:**
- **There is currently no on-chain enumeration anywhere in the app** — no `getProgramAccounts` call exists (deliberately avoided; the public DevNet RPC 403s that call, per `packages/sdk/src/readOnly.ts:1-6`, `client.ts:74-91`'s stubbed `fetchReserveAssets`, `RealReserveSync.tsx:5-6`), and no wallet-token-account scan (`getTokenAccountsByOwner`) exists either.
- **Discover** (`src/merge/pages/Discover.tsx:53`) only ever lists what's already sitting in the Zustand store (`useAppStore.dtrs`): mock `SEED_DTRS` plus a **hardcoded 2-entry list** (`REAL_RESERVE_DESCRIPTORS`, `src/merge/lib/onChainReserve.ts:37-56`, sourced from `devnet-fixtures.json`) plus anything separately pushed in via `registerRealReserve`.
- **A Reserve is only ever added to that store** two ways: (a) being one of those 2 hardcoded fixtures, or (b) going through `CreateDTR.tsx`'s real-deploy path (`handleSubmitReal`, lines 213-311), which derives a genuinely new on-chain Reserve (`deriveNewReserveAddresses`, `packages/sdk/src/createReserveFlow.ts:26-36`, seeded by the live `protocolConfig.reserveCount`), then calls `registerRealReserve(newDtr)` to persist it into `localStorage` (Zustand `persist`, key `"ssrfun-simulation"`) and navigates to `/dtr/devnet-<reserveId>`.
- **`DTRDetail.tsx:60-63`'s `dtrId` is a pure local-store lookup key, never a PDA/mint** — an unrecognized id renders "Reserve Not Found" (`DTRDetail.tsx:140-150`); there's no fallback that treats an unfamiliar id as an address to fetch fresh.
- **There is no "load a Reserve by address/mint" UI anywhere** — the Discover search box only filters name/ticker/category substrings against Reserves already in the store; no route or component builds a `/dtr/...` path from raw user-typed input.
- **Confirmed root cause of "TestLo not found unless you know where to look":** since TestLo was created through the real `CreateDTR.tsx` flow, it *is* persisted in `localStorage` on whatever browser/profile created it, and *is* fully reachable there (including live 15s-polled on-chain refresh via `RealReserveSync.tsx`) — but it is **not discoverable from a fresh browser/device/localStorage state**, because nothing in the app scans the chain or the connected wallet for Reserves it doesn't already know the id of. This is the real, confirmed product gap: **the app can create dynamic Reserves and remember them locally, but cannot (re)discover one it didn't personally create in that browser.**
- **To reproduce/verify TestLo's real accounting, the following would let me inspect the actual account** (all confirmed as the literal fields the app's own SDK layer needs): the Reserve's `reserveId` (small integer, PDA seed) or the Reserve PDA address directly; the Reserve Token mint address (to check the ~1,004-token wallet balance); the MOCX mint address (candidate-mint list required — `readOnly.ts:71-88` can't discover registered mints on its own, only check ones it's told about); the connected wallet's pubkey (already available if you reconnect the same wallet that created it — this part *is* frontend-native); optionally the create-Reserve transaction signature, purely as a lookup aid via Explorer if the id/addresses were lost. None of these are currently accountable through any frontend input field — they'd need to come from you directly, or from that same browser's persisted `localStorage`, or a one-off script against `packages/sdk`.
- **This confirms the item-2/dynamic-discovery requirement is real and unmet today**, separate from (but related to) the Sell-estimate design question below — recommend treating "let the app discover/reload a dynamically created Reserve from just an address/mint, not just from its own browser's local memory" as its own tracked requirement (see Cross-cutting notes / Delivery Phases).

**3. Canonical Sell experience — FINAL, implemented in Phase A:**
- **The primary Sell action is proportional redemption into the underlying Reserve(s).** For TestLo, that's MOCX — the canonical, headline redemption output is MOCX, never a synthetic SOL figure standing in for it.
- **The fixed-price synthetic SOL cash-out mechanism is removed from the canonical flow.** Concretely: `packages/sdk/src/zapInstructions.ts:186-254`'s unconditional post-redeem "transfer redeemed asset to swap authority → pay out `totalUsdOut / SOL_TEST_PRICE_USD` lamports" step, and `DTRDetail.tsx:179,782`'s `estSolOut = (numSellAmount * dtr.nav) / SOL_TEST_PRICE_USD` preview, are both **removed as the default/canonical Sell path** — not merely relabeled.
- **A secondary "Redeem and swap to SOL" option may exist only behind a real DevNet swap quote** — meaning an actual route/quote obtained from a genuine swap venue (e.g., a real router if one exists on DevNet for the specific mint pair) at call time, not a fixed constant. **Confirmed finding relevant to feasibility: no such route exists in this repo today** — there is no Jupiter or other router/AMM integration anywhere (same finding as item 5), and MOCX/mintX-Y-Z are DevNet-only test mints with no real liquidity venue. **Until a legitimate quote source is actually wired up and verified, the secondary SOL-swap option must not be offered at all** — not as a disabled button with a fake number, not as an estimate — per the explicit instruction: no artificial SOL cash-out estimate, and no implication that a real MOCX-to-SOL conversion will occur.
- **Disclosure requirement:** the Sell UI's headline number is the direct, in-kind redemption output (e.g., "You will receive: ~X MOCX"), computed from the real proportional-redemption math already verified correct (`redeem_reserve_tokens_in_kind.rs`) — clearly separated from any fee and from a (currently unavailable) swap-to-SOL secondary step.
- This directly reduces Mainnet-readiness scope too: the swap-authority/fixed-peg mechanism was already flagged in `PROJECT_STATUS.md` as something needing replacement with real routing before Mainnet — removing it from the canonical DevNet flow now means there's no fixed-peg behavior to migrate away from later, only a real-routing feature to add if/when a genuine DevNet (or Mainnet) swap venue is wired up.

**Classification: frontend + SDK change, no protocol change needed** (on-chain program has no pricing concept at all, confirmed structurally — unchanged from round 1). The dynamic-Reserve-discovery gap (point 2) is also frontend/SDK-only (no `getProgramAccounts`/token-scan capability needs a protocol change, only a different RPC strategy or a lightweight off-chain index).

**Acceptance criteria:**
- Sell's primary, headline output is the actual redeemed Reserve asset amount (e.g. MOCX), computed via the real on-chain proportional-redemption math, with fees shown separately.
- No SOL-denominated figure is shown as part of the default/canonical Sell flow unless and until a real swap quote is obtained and executed against a genuine route — and if/when that secondary option exists, it must show its own independently-sourced quote, clearly labeled as a secondary conversion step with its own fee/slippage disclosure, never blended into the primary redemption number.
- If no legitimate swap route is available (current state), the "swap to SOL" option is simply absent from the UI — not shown disabled with a placeholder number, not implying a future/pending conversion.
- The frontend can load/refresh a Reserve's real on-chain state given, at minimum, its Reserve PDA/id and Reserve Token mint (even without a full discovery/search UI) — i.e., the underlying SDK read path (`fetchReserveOnChain`) should not be architecturally restricted to only the 2 hardcoded fixtures once a real address is known, even if a full "search any Reserve" UI isn't in scope for this pass.
- No displayed number for TestLo or any other Reserve changes until traced and verified against that account's actual on-chain state (per instruction — this criterion covers the "don't just adjust numbers" mandate for future work on this item).

**Tests / regression coverage:** Add a scripted DevNet regression (pattern-matched on `scripts/verify_zap.ts`) that (a) targets the real fixtures (Reserve One/Two, mintX/Y/Z) for now, asserting: AUM/NAV match hand-calculated values from real vault balances; the Sell breakdown shows only the in-kind redemption amount + fee, with no synthetic SOL figure; and (b) is written so it can be pointed at TestLo's actual reserveId/mint once you provide them, to confirm the same in-kind-only behavior against that real account specifically. Also add a unit/integration test asserting `buildSellZapInstructions` (or its replacement) never performs an asset-to-SOL conversion unless explicitly invoked via a real-quote code path that doesn't exist yet (i.e., today, calling Sell must never silently invoke a swap).

---

## 9. Landing-page "Create. Launch. Trade." and Fees sections

**Files:** `src/pages/Home.tsx:130-162` ("Create. Launch. Trade." / `id="how"`, three `.how-cell` blocks, plain-paragraph body copy, no card wrapper — this section itself is not styled as fine print), `src/pages/Home.tsx:164-205` ("Fees without fine print" / `id="fees"`), specifically the explanatory copy at `Home.tsx:172-179` which **is** rendered with `className="muted" style={{ fontSize: 14 }}` — visually similar to fine print, which is the section's own naming irony worth fixing. Both sections sit on a transparent `.section` background (`index.css:1418-1420`); the Fees section's content is further split into two opaque `.card.card-pad` panels (explanation + fee-example table).

**Clarification for scope:** there are three visually-similar "plain transparent `.section`" blocks on this page — "How" (130-162), "Fees" (164-205), and the later "Transparent by construction" section (207-219, which also holds the item-2 CTA button). Confirming this item is about the first two (How + Fees) and not the third, which item 2 already covers for its button text only.

**Frontend-only, design/content proposal (not yet implemented, per your instruction to record a proposal first):**
- **Fees section:** replace the small `muted`/14px explanatory paragraph with a clearer, larger-type layout — e.g. 2-3 short labeled stat/callout blocks (mirroring the `.kpi-cell` pattern already used in the hero stats strip) instead of a paragraph + separate small table, so the fee structure is scannable at a glance rather than read as prose. Keep the existing fee-example table (it's already in a card, already legible) but consider promoting its most important row (e.g. "total fee on a typical trade") into a headline stat above the table.
- **How section:** already reasonably clear (plain paragraphs, not fine print) — recommend lighter-touch changes here: tighten copy length per cell and ensure visual parity/rhythm with the reworked Fees section so the two sections read as one coherent "how it works" block, rather than a full redesign.
- Preserve the transparent-background rhythm used across the rest of the page (it's the established pattern, not something to eliminate wholesale) but ensure the Fees section's actual fee figures are presented with the same visual weight as the rest of the page's key facts (e.g. the hero KPIs), not de-emphasized as an afterthought.
- No new marketing claims — only reflow/restyle existing, already-approved copy and numbers (`FEE_EXAMPLES` table data is unchanged).

**Acceptance criteria:**
- No fee-mechanics copy is rendered at a visually "fine print" weight/size (i.e., remove the 14px `muted` treatment from the primary fee explanation).
- Fee information remains fully present and accurate — this is a presentation change, not a content change.
- Visual hierarchy and existing SSR.fun aesthetic (design tokens, spacing rhythm, card styles) are preserved — no new component system introduced.

**Tests:** Visual review / manual QA against the existing design system; no functional/behavioral tests needed since no data or interaction changes.

---

## 10. Reserve wind-down

> **2026-07-29, round 2 — confirmed staged lifecycle, refined.** Round 1's
> proposal (`WindingDown` → `close_reserve` at zero supply) is confirmed as
> the right shape and renamed/tightened to match your exact terms: **Active
> → WindDown → Closed**, with explicit treatment of every listed concern
> below, and an explicit rule that the manager can never withdraw assets
> still attributable to outstanding holders.

**Files:** confirmed via full-repo grep — `programs/ssr_protocol/src/` has **no** `close`/`wind`/`shutdown`/`deprecat`/`sunset` instruction except `remove_delegate.rs:20`'s unrelated Delegate-account rent-reclaim `close`. `docs/protocol/SECURITY_INVARIANTS.md:56` documents this as a known, accepted v1 gap (no `close_abandoned_reserve` instruction; a Reserve's rent stays locked indefinitely if abandoned — demonstrated live on DevNet by reserve_id 6, permanently stuck in `AssetsInitializing`). On the frontend, `src/state/store.tsx:29,138-145`, `src/domain/types.ts:62,103`, `src/components/ui.tsx:80` contain **dead, never-dispatched** wind-down scaffolding (a `'wind-down'` action type, a `'winding-down'` status, a CSS badge) attached to the legacy native store that the routed Merge dashboard (`ManageDTR.tsx`/`useAppStore.ts`) doesn't use at all — effectively inert precedent, not a working feature.

**Confirmed root cause:** there is genuinely no safe way to wind down a Reserve on the current protocol. `pause_reserve` is the closest existing primitive but is explicitly not a wind-down: it blocks new minting/target-updates/delegate-management but **by design never blocks redemption** (`redeem_reserve_tokens_in_kind.rs` deliberately ignores both Reserve-level and protocol-level pause, per DEC-0016/`SECURITY_INVARIANTS.md` invariant 11) — which is actually the right building block to reuse, since "never strand holders" is already this instruction's core guarantee.

**Classification: requires protocol changes.** Confirmed staged lifecycle (for review, not yet built):

**Stage `Active` → `WindDown`** (new manager-only instruction, e.g. `initiate_wind_down`): one-way transition, no path back to `Active` (unlike `Paused`, which is reversible and therefore not reusable for this — a wind-down must not be a toggle).

**Stage `WindDown`** — treatment of each concern, explicit:
- **Minting:** blocked. Reuse the same `status == Active`-only guard `mint_reserve_tokens_in_kind.rs:70-73` already enforces — `WindDown` fails it exactly like `Paused` does today, no new logic needed, just extending which non-`Active` statuses exist.
- **Redemption:** stays fully open, exactly like `Paused` today (`redeem_reserve_tokens_in_kind.rs`'s `require_active_or_paused`-style guard, extended to also accept `WindDown`) — this is the core "never strand holders" guarantee, reused rather than reinvented.
- **Delegates:** no new delegate grants during `WindDown` (extend the existing pause-style guard already used by `add_delegate`/`update_delegate_permissions`); existing delegates and `remove_delegate` continue to work unchanged — winding down doesn't require forcibly stripping delegates, just freezing new grants.
- **Fees:** `accrue_fees`/`collect_fees` remain callable during `WindDown` (legitimately pending fee shares up to that point should still be collectible) but must be blocked once `Closed` (nothing left to accrue against). Needs explicit sign-off since this is a judgment call, not derived from an existing invariant.
- **Remaining Reserves (underlying assets):** must be fully redeemable by holders throughout `WindDown` — no instruction may sweep or move vault balances except via the existing pro-rata `redeem_reserve_tokens_in_kind` path. This is the concrete mechanism behind "never strand assets."
- **Reserve Token mint authority:** should be handled defensively, not left as a bypass risk — recommend the `WindDown` transition also revokes/burns the Reserve Token mint authority (or reassigns it to a PDA that structurally cannot mint, e.g. one with no signing instruction), so "no new issuance" is enforced at the SPL-token layer itself, not only by an `Active`-only status check in application logic. This is a genuine defense-in-depth design question to review, not yet decided.
- **Vault authority:** vault PDAs remain under the existing program-derived vault authority throughout `WindDown` (holders still need the program to authorize their redemption transfers) — authority only changes at final `Closed` closure (below).

**Stage `WindDown` → `Closed`** (new `close_reserve` instruction, genuinely new): must only succeed once explicit safe conditions hold — at minimum `reserve_token_mint.supply == 0` **and** every registered Reserve's vault balance == 0 (both must be independently checked; supply reaching zero doesn't by itself guarantee every vault emptied out evenly, given floor-rounding in the redemption math per item 8's trace). Once both hold:
- **Rent recovery:** vault token accounts, `ReserveAsset` PDAs, and the `Reserve` PDA itself are closed, reclaiming rent — this finally addresses the pre-existing documented gap (`SECURITY_INVARIANTS.md:56`, reserve_id 6 stuck forever) for Reserves that reach a legitimate end-of-life, not just abandoned ones.
- **Final account closure:** only the manager (rent-reclaim destination) is affected — **no manager withdrawal step exists or is needed at this point, because by definition supply and vault balances are already zero.** This directly satisfies "do not permit the manager to withdraw assets that remain attributable to outstanding Reserve Token holders" — there's structurally nothing left to withdraw from holders by the time `close_reserve` can succeed at all. Explicitly rejected: any design where a manager could force-close with nonzero supply/balances and sweep remaining assets — not proposed, and should be treated as an explicit non-goal in the eventual security review.

**Open design question, flagged not decided:** the zero-supply-and-zero-balance requirement is the safest option but means a Reserve with long-tail non-redeeming holders (dust balances, lost keys) may never reach `Closed`, leaving rent permanently locked (same shape as today's abandoned-Reserve gap, just later in the lifecycle). No forced/expiring redemption mechanism is proposed to solve this — the protocol has no oracle/AMM to value or force-convert dust holdings safely, and inventing one is out of scope here. Recommend accepting "may stay in `WindDown` indefinitely if dust remains" as a known, documented limitation rather than building a workaround that risks the holder-protection guarantee.

**This is a genuine protocol-extension proposal, not an implementation** — needs your review/approval on the state-machine shape (particularly the mint-authority-revocation design question and the accept-indefinite-`WindDown` tradeoff above) before any Rust is written. See Delivery Phases (below) for how this is sequenced against items 4/5.

**Acceptance criteria (once approved and built):**
- Only the root manager (no delegate flag) can initiate wind-down, unless you decide otherwise.
- A prominent, hard-to-miss risk warning and consequence preview — explicitly enumerating what happens to minting, buying/selling, direct redemption, delegates, fees, vaults, and remaining Reserves — is shown before the wallet-approval step, matching the level of explicitness in this section.
- Wind-down (`Active`→`WindDown`) and closure (`WindDown`→`Closed`) each require explicit wallet approval and produce a real signed transaction with pending/submitted/confirmed/failed/recoverable states and an Explorer link on confirmation, matching the existing Buy/Sell transaction-status UI pattern.
- No client-side "wound down" or "closed" state is ever shown without an on-chain-confirmed transition.
- Redemption remains available to all holders throughout `WindDown` — verified by a DevNet test that redeems from a wound-down Reserve successfully.
- Minting and new delegate grants are rejected in `WindDown` — verified by DevNet tests expecting explicit on-chain errors.
- `close_reserve` fails safely (clear error, no partial state) if called while `supply > 0` **or** while any vault balance `> 0`, even if supply reads zero.
- No instruction anywhere allows the manager to withdraw vault assets while `supply > 0` — verified by an explicit adversarial test attempting exactly that and expecting rejection.

**Tests:** DevNet integration test: initiate wind-down on a fresh fixture-like Reserve, confirm minting/new-delegate-grants are rejected, confirm existing holders can still redeem, confirm fee collection still works pre-closure, confirm `close_reserve` rejects both a nonzero-supply Reserve and a zero-supply-but-nonzero-vault-balance Reserve, and succeeds only once both conditions are met; an adversarial test confirming no code path lets the manager withdraw vault assets before supply reaches zero.

---

## Delivery phases (items 4, 5, and 10) — 2026-07-29, round 2

Per your instruction: keep this cumulative for one eventual DevNet delivery,
but sequence it so protocol work is fully completed and verified *before*
any dependent frontend control is enabled — never ship a frontend affordance
that calls an instruction not yet deployed and DevNet-verified.

**Phase A — Security-invariant analysis & design docs (no code).**
For all three areas together (composition add/disable per item 4/5, the
attestation/trade-execution boundary per item 5, and the WindDown/Closed
lifecycle per item 10): write the explicit security-invariant analysis
(extending `docs/protocol/SECURITY_INVARIANTS.md`) covering the open
questions already flagged above — adding a zero-balance Reserve into an
Active Reserve's target-weight math, the mint-authority-revocation design
for `WindDown`, the "never let a manager withdraw holder-attributable
assets" guarantee, and the zero-supply-and-zero-balance closure condition.
Update `docs/protocol/ACCOUNT_MODEL.md`/`INSTRUCTION_REFERENCE.md` to
reflect the new instructions and status values *before* writing any Rust.
Log each confirmed design decision in `DECISION_LOG.md` as it's settled
(new entries, not edits to existing ones).

**Phase B — Protocol implementation + Rust/Anchor tests.**
Write the new instructions (asset-add-post-Active, disable-asset,
`initiate_wind_down`, `close_reserve`) and their adversarial test coverage
(mirroring the existing repeated-init/excess-redemption test style) —
including explicit tests for every "must reject" case identified in items
4/5/10's acceptance criteria (manager-withdrawal attempt, premature close,
minting-during-WindDown, etc.). Run against localnet if Windows Developer
Mode is enabled by then (DEC-0034 policy), otherwise `cargo check` +
`cargo build-sbf` as the existing fallback.

**Phase C — DevNet deployment + live verification.**
Deploy the program upgrade to DevNet, then run real verification scripts
(new `scripts/verify_*.ts`, matching the existing pattern) against the live
deployment before anything downstream is touched — this phase must fully
pass before Phase D begins.

**Phase D — TypeScript SDK support.**
Add instruction builders / read helpers to `packages/sdk/src` for the new
instructions and status values, typechecked and exercised by Phase C's
verification scripts (which should call through the SDK, not raw
instruction-building, to prove the SDK layer itself is correct).

**Phase E — Frontend integration (gated on Phases A-D being complete).**
Only once B/C/D are done and verified: wire `ManageDTR.tsx`'s composition
UI, the rebalance-record UI, and a new wind-down flow to the real,
deployed, DevNet-verified instructions — including the gating requirement
already stated in items 4/5/10 that any UI control for a not-yet-deployed
instruction stays disabled with an explanatory message, never a fake
success state.

**Phase F — Docs & decision log, continuously.** Not a separate final
step — `DECISION_LOG.md`, `ACCOUNT_MODEL.md`, `INSTRUCTION_REFERENCE.md`,
`SECURITY_INVARIANTS.md`, and `FRONTEND_INTEGRATION.md` are updated as each
phase actually lands, per this repo's existing CLAUDE.md logging
requirement — not deferred to the end.

Items 1, 2, 3, 6, 7, 9, and the Sell-disclosure half of item 8 have no such
phase dependency — they're frontend-only and can proceed independently of
this sequencing (item 8's dynamic-Reserve-discovery gap and the removal of
the synthetic SOL cash-out are also frontend/SDK-only, per item 8 above, and
don't need to wait on Phases A-D).

---

## Cross-cutting notes

- **Items 4, 5, and 10 all converge on the same underlying gap**: the protocol has no on-chain trading/oracle/pricing layer by design (v1 scope, DEC-0017/DEC-0021), and now also share one additional real gap surfaced this round: there is no actual DevNet swap/routing venue anywhere in this repo, which is why item 5's "trade execution" is currently limited to attestation, and why item 8's secondary SOL-swap option cannot legitimately exist yet either. Any future work adding real swap routing should be designed once, not per-item.
- **Decision Log entries will be needed** once implementation choices are made for: the Sell-quote redesign (item 8, now further confirmed rather than merely proposed), the WindDown/Closed state-machine shape (item 10), the composition-vs-rebalance instruction design (items 4/5), and the terminology conflict resolution (flagged at the top of this document) — per this repo's CLAUDE.md logging rule. Not written yet since implementation hasn't started.
- **No code, config, or docs other than this plan file were modified in this pass.** `PROJECT_STATUS.md`/`DECISION_LOG.md` are untouched — no progress or decisions have actually been implemented yet, only inspected, corrected, and proposed.

---

## Phase A — implementation record (2026-07-29, round 3)

Phase A is implemented. This section is the factual record of what shipped,
what was deliberately deferred, and why — see DEC-0037/0038/0039 for the
decision-log entries and `docs/protocol/FRONTEND_INTEGRATION.md`'s
"Canonical discovery" section for the architecture writeup.

### Mock-state dependencies removed
- **The hardcoded 2-fixture "which Reserves are real" list** as the sole
  source of real Reserves in Discover/Portfolio/ManageDTR — replaced by
  `packages/sdk/src/discovery.ts`'s live `ProtocolConfig.reserveCount`
  enumeration (`RealReserveSync.tsx`).
- **Silent placeholder/stale-state fallback on chain-read failure** — a
  coarse `chainDiscoveryStatus` ("loading"/"ready"/"error") and a per-DTR
  `chainStatus`/`chainError` now surface failures honestly (Discover banner,
  DTRDetail banner) instead of quietly keeping old numbers with no signal.
- **Fixed synthetic SOL Sell-estimate headline** (`estSolOut` as the primary
  figure) — replaced with the real in-kind redemption estimate
  (`computeRedemptionEntitlements` against live vault balances/supply); the
  SOL figure is now an explicitly-disclosed secondary line (DEC-0039).
- **Delegate-management false-success states for real Reserves** —
  ManageDTR's add/edit/remove-delegate actions previously produced a
  "Delegate Added"/"Permissions Updated" success toast for a real on-chain
  Reserve while only mutating local simulation state, with zero on-chain
  effect. Now gated: real Reserves get a read-only, verified on-chain
  delegate list with local-label editing only; the mutating UI is only
  reachable for simulated Reserves (clearly labeled "Simulated Demo").
- **Rebalance false-success for real Reserves** — "Execute Rebalance" is
  now disabled (with an explanatory message) for any `dtr.onChain` Reserve;
  it only executes (against local simulation state, clearly labeled) for
  simulated Reserves.
- **Bare, unlabeled delegate count / composition on Overview** — now shows
  a verified on-chain count plus an honest "N reported on-chain but
  unresolved" message when discovery's candidate-wallet hints don't cover
  every granted delegate, rather than presenting a possibly-incomplete
  number as if definitive.

### Mock dependencies intentionally retained (and why)
- **`SEED_DTRS` (the fully-fictional illustrative demo catalog) still
  exists** and still renders in Discover/Portfolio — but every card/detail
  page now carries an explicit "Simulated Demo" badge, structurally
  distinguished from "Live on Solana DevNet" ones (reusing the existing
  `.badge-mock`/`.badge-verified` styles), per the instruction that
  economic value/pricing may be simulated as long as it's clearly labelled.
  Removing this catalog entirely was judged out of Phase A's scope (a much
  larger product-surface change than discovery/mock-purge, and not what
  "remove active dependence on... presented as on-chain" requires once the
  two are no longer indistinguishable).
- **The mock buy/sell AMM economy for simulated Reserves** (`buyDTRToken`/
  `sellDTRToken`, fictional `wallet.usdc`/`liquidityUsdc`) is unchanged —
  it never claimed wallet approval or a real transaction, and now renders
  under a clearly-labeled "Simulated Demo" surface, consistent with
  "economic value... may be simulated and clearly labelled."
- **The committed DevNet fixtures** (`devnet-fixtures.json`, Reserve One/
  Two) remain as discovery candidate-mint hints and for
  `scripts/verify_*.ts`-style reproducible engineering — they are now
  discovered through the same canonical path as any other Reserve, not
  special-cased.
- **The fixed-rate SOL settlement execution** (`zapInstructions.ts`) is
  unchanged in behavior — real, working, previously-validated DevNet code;
  redesigning its execution is explicitly Phase E ("Jupiter feasibility/
  real swap execution"), not Phase A.

### Canonical discovery architecture (summary — full detail in docs/protocol/FRONTEND_INTEGRATION.md)
Enumerate every Reserve via `ProtocolConfig.reserveCount` + per-`reserveId`
PDA derivation + direct account fetch (`packages/sdk/src/discovery.ts`) —
no `getProgramAccounts`, so the public DevNet RPC's confirmed block on that
method never blocks discovery. Per-Reserve asset mints and delegate wallets
are resolved via a documented candidate-hint list (verified on-chain before
being trusted), with `assetCount`/`resolvedAssetCount` and
`delegateCountOnChain`/`delegatesOnChain.length` exposed so under-resolution
is disclosed, never hidden. `Reserve.metadataUri` (a `data:application/json`
URI on real-deployed Reserves) is decoded to recover name/ticker/description/
category without fabrication.

### Discovery limitation (documented, not worked around)
Full, guaranteed-complete enumeration of a Reserve's registered asset mints
and delegate wallets requires either a `getProgramAccounts` memcmp scan
(blocked on the public DevNet RPC today) or a complete candidate list. The
current candidate lists (the 4 mints `CreateDTR.tsx` can ever use; the
Reserve's manager + 2 documented fixture delegate wallets + the connected
wallet) cover every Reserve this app itself can create, so this limitation
is not expected to hide anything for app-created Reserves — but a Reserve
composed of an asset mint or delegate wallet from outside this app's own
candidate set would show honestly-flagged partial data rather than silently
wrong data. Smallest future fix: a dedicated/paid DevNet RPC provider
supporting `getProgramAccounts` memcmp (infrastructure change, not
protocol), or a protocol-level asset-mint/delegate registry stored on the
Reserve account (a schema migration).

### TestLo / MOCX result
TestLo's Reserve PDA/id, Reserve Token mint, and MOCX's mint address were
**not supplied and were not needed** — `CreateDTR.tsx`'s closed asset
universe means MOCX is almost certainly one of the 3 fixture mints
(`mintX`/`mintY`/`mintZ`, on-chain symbol "mockX"/"mockY"/"mockZ"), already
in the discovery candidate-hint list, and TestLo's name/ticker are expected
to resolve directly from its own on-chain `metadataUri`. **Not yet
independently confirmed against the live TestLo account in this pass** —
this implementation was verified via typecheck/build/offline unit tests,
not by re-running discovery against DevNet with a live RPC connection in
this environment (see Remaining blockers). If TestLo does not appear
correctly once this ships and is exercised against real DevNet, the most
useful single piece of information to supply next is its Reserve PDA
address or `reserveId` (recoverable from the original creation transaction
via Solana Explorer if not otherwise on hand).

### Acceptance criteria and results
- Dynamic discovery of genuine deployed accounts absent from hardcoded
  fixtures: **implemented** (enumeration is `reserveId`-driven, not
  fixture-list-driven); **not yet independently DevNet-verified in this
  pass** (see Remaining blockers).
- Canonical address-based identity: **met** — `dtrAddress`/Explorer links
  use real on-chain addresses throughout; a symbol/name never substitutes.
- Shared source of truth across frontend surfaces: **met** — Discover/
  DTRDetail/Portfolio/ManageDTR all read the same `dtrs` array populated by
  one discovery pass.
- Separation of on-chain state from metadata/simulated pricing: **met** —
  `TEST_ASSET_PRICES_USD` and `metadataUri` parsing are clearly-commented,
  isolated, honestly-labeled layers on top of real on-chain reads.
- Empty/unavailable/unsupported/malformed/RPC-error states: **met** for
  discovery-level failures (`chainDiscoveryStatus`) and per-Reserve resolve
  failures (`assetsResolvedFully`, `chainStatus`); no new "unsupported
  account type" state was needed since the program has exactly one Reserve
  account shape.
- Removal of active mock fallbacks: **met** for the ones enumerated above;
  the illustrative demo catalog is retained-but-labeled, not removed (see
  above for why).
- Delegate local-label fallback behavior: **met and tested**
  (`tests/phase_a_discovery.ts`).
- Prevention of fictional success states: **met** for delegate CRUD and
  rebalance-execute on real Reserves.
- TestLo/MOCX discovery behavior "as far as available addresses permit":
  **implemented generically, not yet independently re-verified against the
  live account** (see above).

### Tests, typecheck, build
- `npx tsc -b`: clean, zero errors.
- `npx oxlint`: zero new errors/warnings (only pre-existing warnings, none
  introduced by this pass).
- `npx vite build`: passes.
- `npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_a_discovery.ts`:
  12/12 passing (metadata-URI parsing, on-chain permission decoding,
  delegate local-label fallback behavior).
- **Not run in this pass:** `npm run test:program` (the live-DevNet Anchor
  test suite, `tests/ssr_protocol.ts`) — it exercises protocol instructions
  unrelated to this pass's frontend/SDK-discovery-layer work, and re-running
  it would submit real DevNet transactions/cost for no verification benefit
  specific to Phase A; and no live run of `discoverAllReserves` itself
  against the real deployed program from this environment (see below).

### Remaining blockers / Phase B prerequisites
- **Phase A's discovery logic has not been exercised against the live
  DevNet program from this environment** (no live RPC call was made in this
  pass — only typecheck/build/offline-unit-test verification). Recommend a
  `scripts/verify_discovery.ts`-style script (matching the existing
  `scripts/verify_*.ts` pattern) run before or during Phase B, confirming
  real enumeration finds both fixtures plus any other real Reserve
  (including TestLo, if its address is supplied or it's found by
  enumeration) with correct composition/supply/NAV.
- Per-Reserve asset/delegate enumeration remains only as complete as the
  candidate-hint lists (see "Discovery limitation" above) — not a blocker
  for Phase B, but worth resolving via a dedicated RPC provider before
  wider testing.
- Phase B (`devUSDC`/"SSR Test USD" settlement mint, faucet, sponsored SOL
  onboarding) and all later phases (C-H) remain entirely unstarted, per
  instruction — this section does not authorize or begin them.

---

## Live DevNet verification of Phase A discovery (2026-07-29, bounded pass)

Phase A's discovery layer has now been proven against the live deployed
program, closing the "not yet independently confirmed" gap the Phase A
record above explicitly flagged. Full detail in
`docs/protocol/FRONTEND_INTEGRATION.md`'s "Live verification" addendum;
summary here.

**How:** a new reusable script, `scripts/verify_discovery.ts`, runs
read-only against live Solana DevNet. It imports and calls the exact same
functions the frontend uses (`packages/sdk/src/discovery.ts`'s
`discoverAllReserves`/`discoverDelegatesForReserve`/`fetchProtocolConfig`/
`parseReserveMetadataUri`, and `src/merge/lib/onChainReserve.ts`'s
`buildDtrFromDiscoveredReserve`) rather than reimplementing discovery logic
— a pass here is evidence the frontend's own code path works live, not
just that some other code can read these accounts. **Zero transactions
were sent** — every call is a read (`getAccountInfo`/`getTokenSupply`/
`getAccount`/`getMint` via a non-signing provider); no keypair was ever
loaded.

**Confirmed live:** RPC `https://api.devnet.solana.com` (the repo's
documented default, `src/merge/lib/solana-config.ts`), cluster identity
independently confirmed via genesis hash (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`,
the known DevNet genesis), program ID
`2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW` matching the documented
default, program account found and executable under the BPF Loader
Upgradeable program.

**Discovery result:** `ProtocolConfig.reserveCount = 16`. All 16 reserveIds
(0-15) were successfully enumerated and decoded on this run — 14 of the 16
are **not** one of the 2 committed fixtures, which could only have been
found by reserveId enumeration, not any fixture list. (A first run hit the
public RPC's documented heavy rate-limiting badly enough to abort on one
account; see "Script hardening" below — the fix made the second run
complete cleanly, 0 discovery issues, 0 integrity issues.)

**TestLo/MOCX — found, via general discovery, not a special case:**
Reserve id **13** (PDA `Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX`) is
the real, active, fully-seeded TestLo Reserve:
- Manager authority: `EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`
- Reserve Token mint: `DQ8ZTGnrgXjDwpn2nLULmY1DtfXKDN8fXM4DKzQZGm7w`, decimals **6** (verified live via `getMint`, not assumed)
- Reserve Token supply: 1,004,975,000 raw → **1,004.975** human-units — matches "~1,004 TestLo Reserve Tokens" almost exactly
- Underlying Reserve (asset): mint `2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu` at 100% target weight (10000 bps) — **this is `mintX`, the fixture registry's "mockX"** (`packages/sdk/fixtures/devnet-fixtures.json`). "MOCX" is `mintX` under the name the user knows it by; confirmed by mint-address match, not by guesswork or candidate-list position.
- Vault `8X9iSK84DkJeFFaCeHhRjqthSniypcvNJ8CjkF93y5xY`, verified live balance 1,005,000,000 raw → **1,005** MOCX (consistent with ~1,004.975 Reserve Tokens near-1:1 backed)
- Status: `active`
- **Name/ticker source:** resolved directly from this Reserve's own on-chain `metadataUri` field (`data:application/json,%7B%22name%22%3A%22StrategicSolReserve%22%2C%22ticker%22%3A%22TESTLO%22...%7D`), decoded to name `"StrategicSolReserve"`, ticker `"TESTLO"` — **not** hardcoded, not inferred from position in any candidate list. (Spacing/case differ slightly from "Strategic Sol Reserve"/"TestLo" as originally typed — same content.)
- A second Reserve, id **12** (PDA `AUW57xjqXmCKbP6wjPZfR5H3TCNah28fiTp6fwLZLNAq`), carries the **identical** metadataUri (same name/ticker) but has zero supply, zero assets, and status `created` — an earlier, abandoned/incomplete attempt at creating TestLo (never reached `seed_reserve`) that predates the successful id=13. Both are reported so the record is complete; id=13 is the real, live TestLo.

**What "MOCX" cannot be resolved from:** SPL mints on Solana carry no
intrinsic on-chain name/symbol field, and this program integrates no
Metaplex/token-metadata program at all (confirmed by repo-wide search,
zero matches for `mpl-token-metadata`/`TOKEN_METADATA_PROGRAM`/`Metaplex`).
The only place a "mockX"/"MOCX"-style label exists is the hardcoded
`devnet-fixtures.json` registry cross-referencing that one real mint
address to a human label — itself a discovery hint, not an on-chain
metadata reference. If TestLo's asset mint had NOT been one of the 3
fixture mints, it would show as an unresolved/unnamed asset (or simply not
be found, since it also wouldn't be in the candidate-mint hint list) —
not as "MOCX". This is now empirically confirmed, not just theorized.

**No further information is required from you regarding TestLo/MOCX** —
discovery resolved it completely and generically.

**Discovery universality:** candidate-hint-limited for per-Reserve
*composition* (asset mints, delegate wallets), exactly as documented in
Phase A's record — several of the 16 reserves (ids 0-5, 7; almost
certainly artifacts of `tests/ssr_protocol.ts` Anchor test runs, each of
which mints its own fresh, ad-hoc test tokens not in this app's candidate
list) show `resolvedAssetCount < assetCount`, honestly flagged, never
hidden. **Discovery of the Reserves themselves (which ones exist at all)
is universal, not candidate-hint-limited** — every one of the 16 was found
by `reserveId` enumeration alone.

**Account-integrity checks — all passed, 0 issues:** for every discovered
account (16 Reserves, every resolved `ReserveAsset`, every resolved
vault, every resolved `Delegate`): correct program owner, correct Anchor
discriminator (independently verified against the IDL's raw discriminator
bytes, not just "decode didn't throw"), correct PDA rederivation, vault
mint matches its declared asset mint (no cross-Reserve contamination),
vault authority matches the Reserve's derived `vaultAuthority`, vault
owned by SPL Token or Token-2022 (no unsupported token program
encountered), underlying asset mint decimals cross-checked against
`ReserveAsset`'s recorded decimals (matched), no duplicate Reserve PDAs or
Reserve Token mints across the 16.

**RPC/failure handling — genuinely exercised, not just theorized:** the
public DevNet RPC's documented heavy rate-limiting (429s) triggered
repeatedly and for real during this run. The first script version crashed
outright when a 429 occurred inside one of the script's own *extra*
integrity-check calls (a real bug, since fixed — see below); after
hardening, the second run absorbed every 429 via Solana web3.js's own
retry/backoff and completed 16/16 reserves with zero unhandled failures.
`packages/sdk/src/discovery.ts`'s core enumeration loop was already
resilient by design (per-reserve/per-asset/per-delegate try/catch, added
in this same pass) — a malformed/unreachable account at one `reserveId`
is recorded as an issue and does not abort discovery of any other
`reserveId`, genuinely exercised live (the first run's reserveId=10 429
was caught and skipped exactly this way, without aborting the other 15).

**Script hardening (a real fix made during this verification, not a
Phase B change):** `packages/sdk/src/discovery.ts`'s `discoverAllReserves`
now wraps each per-reserve/per-asset/per-vault/per-supply fetch in
try/catch and returns a new `issues: DiscoveryIssue[]` array (additive,
non-breaking for existing callers) instead of allowing one bad account to
throw away the whole enumeration; `discoverDelegatesForReserve` similarly
catches per-candidate decode failures and now cross-checks the decoded
`Delegate.reserve`/`Delegate.wallet` fields against what was requested
(defense against a future PDA-seed change silently mismatching data).
`src/merge/lib/RealReserveSync.tsx` logs (non-fatally) when `issues` is
non-empty. `scripts/verify_discovery.ts` itself was also hardened (its own
extra integrity-check RPC calls were not originally wrapped in try/catch,
which caused the first live run to crash at reserveId=5 on a 429 — fixed
by wrapping every per-reserve verification step and the reserve loop
itself in try/catch, recording failures as issues rather than aborting).

**Frontend-surface consistency:** confirmed by construction — Discover,
DTRDetail, Portfolio, and ManageDTR all read `dtrs` from the same
`useAppStore`, populated exclusively by `RealReserveSync.tsx` (mounted
once at the app root, `src/App.tsx`), which calls the identical
`discoverAllReserves`/`buildDtrFromDiscoveredReserve` functions this
verification script calls directly — the script's printed
"Frontend-equivalent DTR object" line for each Reserve **is** the literal
object those four surfaces would render (e.g. TestLo: `name="StrategicSolReserve"
ticker="TESTLO" aum=1005.00 nav=1.0000`). `npx vite build` passes with the
current code; a local `vite` dev server was started and confirmed to serve
`/` and `/#/discover` with HTTP 200. **Not verified in this pass:** an
actual rendered browser DOM/console (no browser-automation tool is
available in this environment — the same pre-existing limitation
`PROJECT_STATUS.md` already tracks for a real Phantom click-through).

**Tests/typecheck/lint/build, all clean:** `npx tsc -b` (repo-wide),
`npx tsc -p scripts/tsconfig.json --noEmit` (the new script), `npx oxlint`
(zero new warnings/errors), `npx vite build`, and
`tests/phase_a_discovery.ts` (12/12 passing, unchanged) — all pass.

**Phase B prerequisites, updated:** the discovery-layer live-verification
prerequisite noted in Phase A's record is now satisfied. Remaining,
unchanged: per-Reserve asset/delegate enumeration is still only as
complete as the candidate-hint lists (a dedicated/paid RPC provider
supporting `getProgramAccounts` memcmp would resolve this generally); the
public DevNet RPC's rate-limiting is real and will affect Phase B's own
future verification scripts the same way (budget for retries/backoff, as
this script now does). Phase B itself (the `devUSDC`/"SSR Test USD"
settlement mint, faucet, sponsored SOL onboarding) remains entirely
unstarted.

---

## Phase B — security model (written before implementation, 2026-07-29)

Per instruction, this section is written and reviewed *before* creating
the mint or any faucet endpoint. Implementation follows this design
exactly; any deviation found necessary during implementation is corrected
here first, not silently improvised in code.

### Pre-implementation inspection findings
- **No existing devUSDC/"SSR Test USD"/"Mule" mint, faucet, or treasury
  exists anywhere in the repo** (confirmed by repo-wide search — the only
  hits were this plan document's own prior round-3 design notes).
- **A real, funded, already-deployed signer already exists** and is the
  natural authority to reuse: the Gate-9 fixture "manager" keypair
  (`devnet-fixtures/manager-keypair.json`, gitignored, present in this
  environment), pubkey `Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj`. It
  is already: the mint authority for `mintX`/`mintY`/`mintZ`, the DevNet
  swap-authority co-signer for Buy/Sell (`api/devnet/swap-sign.ts`), and
  the signer behind the existing `mint-test-assets` faucet
  (`api/devnet/mint-test-assets.ts`). Its secret key is already configured
  in Vercel production as `DEVNET_SWAP_AUTHORITY_SECRET_KEY` (per
  `PROJECT_STATUS.md`'s Environment Status). **Confirmed live balance at
  design time: ~0.404 SOL** — real, but limited runway; see "Operational
  constraints" below.
- **No persistent store (KV/Redis/DB) exists in this project.** The one
  existing precedent for rate-limiting without one is the `/internal/status`
  dashboard's login lockout (`api/dashboard/login.ts`): a module-scope
  in-memory `Map`, explicitly documented there as resetting on cold start
  and not shared across warm instances — an accepted, real, already-shipped
  pattern in this codebase, not something Phase B is introducing for the
  first time.
- **No Metaplex/token-metadata program integration exists anywhere in this
  repo** (confirmed again during Phase A's live verification). `mintX`/
  `mintY`/`mintZ`'s "mockX"/"MOCX"-style names are an off-chain convenience
  registry (`packages/sdk/fixtures/devnet-fixtures.json`), never on-chain
  metadata. **Decision: devUSDC follows the identical pattern** — no new
  Metaplex dependency is introduced; name/symbol are recorded in the same
  kind of off-chain fixture registry, always shown alongside (never instead
  of) the mint address, exactly matching this repo's one existing
  convention rather than creating a one-off exception.

### Decisions

| Question | Decision | Why |
|---|---|---|
| Mint authority | The existing manager/swap-authority keypair (`Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj`) | Real, funded, already the mint authority for the other 3 DevNet test mints; reusing it means zero new secrets to provision, so deployment isn't blocked on the user adding a new Vercel env var today. Tradeoff, accepted and documented: concentrates more capability on one already-privileged DevNet-only key (see "Operational constraints"). |
| Freeze authority | Same keypair (kept, not set to `null`) | Defense-in-depth for an internal alpha faucet — lets a future admin action freeze a specific abusive wallet's devUSDC account without needing a new authority or a program change. Not exercised by Phase B itself (no freeze instruction is built yet); a deliberate, documented option to keep open. |
| Token program | Classic SPL Token (`TOKEN_PROGRAM_ID`), not Token-2022 | Matches `mintX`/`mintY`/`mintZ`'s existing convention; no Token-2022 extension is needed for a plain fungible test token. |
| Decimals | 6 | Matches the user's stated preference and this repo's existing convention (Reserve Token decimals, `mintX`/`mintY` decimals). |
| Initial supply | 0 (mint-on-demand only) | No pre-minted treasury balance to custody/secure; every devUSDC token in existence is traceable to a specific faucet claim transaction. |
| On-chain metadata | None (see inspection findings above) | Consistency with the one existing pattern in this repo; avoids a new dependency for Phase B's actual objective (a working faucet). Name/symbol shown in the UI always alongside the real mint address, never replacing it. |
| Faucet claim amount | 500 devUSDC per claim | Generous enough to be useful for repeated Phase C testing (mint/buy flows), small enough that "devUSDC has no value" is obviously true regardless. |
| Faucet eligibility (durable) | Reject if the requesting wallet's **current on-chain devUSDC balance** is already ≥ 2,000 (a hard ceiling, always re-checked live against the chain) | Unspoofable by a client (matches this repo's "never trust client-supplied balances" convention, e.g. `swap-sign.ts`'s dynamic Reserve validation) and needs no persistent store — the chain itself is the source of truth for "have they already got plenty." |
| Faucet eligibility (best-effort) | An in-memory, per-pubkey 60-second cooldown, module-scope `Map`, same pattern as `api/dashboard/login.ts` | Blocks rapid double-submission/accidental double-claims within a warm instance; explicitly documented as **not** a durable global rate limit (resets on cold start, not shared across instances) — the balance ceiling above is the real, durable defense. |
| SOL sponsorship amount | 0.01 SOL per grant | Enough for a handful of transaction fees / a small ATA rent, not enough to fund a full Reserve creation (intentionally — this is onboarding fuel, not a Reserve-funding mechanism). |
| SOL sponsorship eligibility | Reject if current on-chain SOL balance ≥ 0.03 SOL (durable, live-checked) + the same in-memory cooldown pattern | Same reasoning as devUSDC. |
| Mainnet guard | Every faucet/sponsorship endpoint independently queries the connection's **genesis hash** at request time and refuses to proceed unless it exactly matches Solana DevNet's known genesis hash, regardless of what `SOLANA_RPC_URL`/`VITE_SOLANA_CLUSTER` claim | A string-based cluster-name check could be silently misconfigured; the genesis hash is a property of the actual chain being talked to and can't be spoofed by an environment-variable typo. Fails closed (server returns an error, mints/transfers nothing) if the genesis hash can't be confirmed at all (e.g. RPC unreachable). |
| New required env vars | **None.** Reuses `DEVNET_SWAP_AUTHORITY_SECRET_KEY` and `SOLANA_RPC_URL`, both already configured in Vercel production | Avoids blocking today's deployment on a new secret the user would otherwise need to add manually before anything could go live. |

### Server-side vs. client-side responsibilities
- **Server (both new endpoints) owns, and the client can never override:** which mint is used (hardcoded, not client-suppliable), the claim/grant amount, the eligibility check (balance ceiling, re-fetched live from chain on every request), the cooldown check, cluster/genesis verification, and all signing.
- **Client owns:** collecting the connected wallet's own pubkey, displaying the server's response (pending/submitted/confirmed/failed), triggering a post-confirmation balance refresh, and offering the guided-fallback public-faucet link. The client is never trusted for eligibility or amounts — every value the server needs is re-derived server-side from live chain state or its own hardcoded config, matching this repo's existing `swap-sign.ts` convention.
- **No user wallet signature is required for either endpoint's actual mint/transfer transaction**, following the exact precedent already shipped in this repo for `mint-test-assets.ts`: both operations only ever **add** funds to the caller's own wallet and can never move anything out of it, so a signature would add UI friction without a security benefit. The user does still take an explicit UI action (clicking "Claim") while connected, and the transaction is genuinely signed (by the server-side authority) and genuinely submitted/confirmed on-chain with a real signature and Explorer link — satisfying the substance of "no synthetic success," if not a literal wallet-popup signature. **Flagged explicitly, not silently decided**: if a mandatory wallet-approval click is wanted specifically as a UX consent gate even for a pure gift, that's a one-line addition (`wallet.signMessage` as a non-transactional "I consent" step) that can be layered on without changing the transaction/signing architecture above.

### Operational constraints (documented, not hidden)
- The manager/swap-authority wallet now serves **four** roles: Buy/Sell zap co-signer, `mint-test-assets` faucet signer, devUSDC mint authority, and (new) devUSDC faucet signer + SOL sponsor. All draw from the same ~0.404 SOL balance. At 0.01 SOL/SOL-grant plus tx fees, this funds roughly **35-40 SOL grants** before needing a top-up, on top of its existing Buy/Sell-zap SOL-payout duties. This is the same single-dev-controlled-key risk already tracked in `PROJECT_STATUS.md`/DEC-0015 — Phase B does not introduce a new category of risk, but does increase how much rides on this one key running out. Recommend monitoring and topping up proactively, and revisiting authority separation before wider (non-internal) testing.
- **Authority rotation/revocation path:** rotating the mint/freeze authority requires (a) generating a new keypair, (b) a `SetAuthority` instruction signed by the *current* authority naming the new one, (c) updating `DEVNET_SWAP_AUTHORITY_SECRET_KEY` in Vercel. Because this pass reuses the existing swap-authority key, rotating it also affects Buy/Sell and the existing test-asset faucet — a real coupling cost of the reuse decision above, explicitly noted.
- **If the authority is exhausted (SOL runs out):** mint/faucet/sponsorship transactions fail cleanly with an honest RPC/insufficient-funds error surfaced to the UI — no silent fallback, no fake success.
- **If the authority is compromised:** the attacker could mint arbitrary (valueless) devUSDC, freeze/unfreeze devUSDC accounts, and drain the wallet's real DevNet SOL (which would also disable Buy/Sell and both faucets). Devalued-token minting is low-impact by design; SOL drain is the real risk. Response: rotate `DEVNET_SWAP_AUTHORITY_SECRET_KEY` immediately and, if reachable before drain, move remaining SOL to a fresh wallet first.
- **Production/Mainnet accidental-enablement prevention:** the live genesis-hash check (above) is the primary guard and runs on every request, not just at startup — a deployment accidentally pointed at Mainnet would have every faucet/sponsorship call fail closed rather than silently mint/transfer real-value assets on Mainnet (which is architecturally impossible anyway, since `DEVNET_SWAP_AUTHORITY_SECRET_KEY`'s keypair holds no Mainnet SOL and devUSDC is never deployed there — but the explicit runtime check exists so this isn't merely an assumption).

---

## Phase B — implementation and live verification record (2026-07-29)

Phase B is implemented, tested, and live-verified against real Solana
DevNet. This section is the factual record — see
`docs/protocol/FRONTEND_INTEGRATION.md`'s "Phase B" section for the
architecture summary.

### devUSDC mint — created and verified live
- **Mint address:** `Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k`
- **Token program:** classic SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) — verified live via `getAccountInfo().owner`
- **Decimals:** 6 — verified live via `getMint`
- **Mint authority / freeze authority:** both `Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj` — verified live
- **Initial supply:** 0 — verified live
- **Creation transaction:** `2fcshGpJMTytqZdCpysdbuvUMQwyGgtSMMTyeeAt2dyFCpEiN5qNmunaeXNo9dk4WHzFfg9xmtT5dLWC5uLhJDFd` ([Explorer](https://explorer.solana.com/tx/2fcshGpJMTytqZdCpysdbuvUMQwyGgtSMMTyeeAt2dyFCpEiN5qNmunaeXNo9dk4WHzFfg9xmtT5dLWC5uLhJDFd?cluster=devnet))
- **No on-chain metadata** — confirmed deliberate, matching the `mintX`/`mintY`/`mintZ` precedent; name ("SSR Test USD") and symbol ("devUSDC") live only in `packages/sdk/fixtures/devusdc.json`, never presented as a substitute for the mint address.
- Created via `scripts/create_devusdc_mint.ts`, which is idempotent-guarded (refuses to create a second mint once `devnet-fixtures/devusdc-mint.json`, gitignored, records one).

### Faucet + SOL onboarding — implemented, matching the security model exactly
- `api/devnet/faucet-devusdc.ts`: 500 devUSDC/claim, 2,000 devUSDC durable ceiling, 60s best-effort cooldown.
- `api/devnet/sponsor-sol.ts`: 0.01 SOL/grant, 0.03 SOL durable ceiling, 60s cooldown, 0.05 SOL authority floor (refuses to drain the shared authority below it).
- Both reuse `DEVNET_SWAP_AUTHORITY_SECRET_KEY` — **zero new required environment variables**.
- Both call a live genesis-hash check (`assertDevnetCluster`) before anything else — fails closed on any cluster mismatch.
- Shared helpers (`api/devnet/_lib/{authority,network,rateLimit,apiTypes}.ts`) also now back the pre-existing `swap-sign.ts`/`mint-test-assets.ts` (deduplicated, behavior unchanged — confirmed via `npx tsc -p api/devnet/tsconfig.json --noEmit` passing clean and the existing endpoints' logic untouched beyond the loader call site).
- Frontend: `src/merge/components/DevnetOnboarding.tsx`, mounted on Portfolio (an existing primary nav item) — no new page, no redesign.

### Live DevNet verification — full pass, all 15 required proofs confirmed
Via `scripts/verify_devusdc_faucet.ts`, which calls the **actual deployed
handler functions** (not a reimplementation) against a freshly-generated,
disposable test wallet (`827QX6fPtLvHRc1KRsqVa8utHcan6MLy3H7VShhU2GJh` —
no prior history, no further use planned):

1. Mint exists on DevNet: confirmed.
2. Mint owner/token program: confirmed (classic SPL Token).
3. Decimals (6) and authorities (both = manager pubkey): confirmed live.
4. Metadata resolves as "SSR Test USD"/"devUSDC": confirmed (off-chain registry, explicitly not on-chain).
5. Test wallet starting balances: 0 devUSDC, 0 lamports SOL — confirmed.
6-9. Real faucet claim requested, handler executed, real transaction built/signed/submitted, confirmed on-chain: signature `5ySJEctYwRUv8tQxkugcDtQ9FYa5msrUN55hR3VcADnKwGboszDBQUBnbuRBxEwdVnjSn3pCYQHUgeHKa6qpMQJi`.
10. Explorer link generated and matches the real signature: `https://explorer.solana.com/tx/5ySJEctYwRUv8tQxkugcDtQ9FYa5msrUN55hR3VcADnKwGboszDBQUBnbuRBxEwdVnjSn3pCYQHUgeHKa6qpMQJi?cluster=devnet`.
11. Test wallet received real devUSDC: post-claim balance 500,000,000 raw (500 devUSDC), re-fetched from chain, not trusted from the response.
12. Frontend refresh path: `DevnetOnboarding.tsx` re-fetches both balances from chain via the same `fetchTokenBalanceRaw`/`connection.getBalance` calls after every claim — same mechanism this script used to verify the balance change independently.
13. Immediate repeated claim limited: second call to the same handler for the same wallet returned HTTP 429, `"Please wait 60s before requesting devUSDC again."` — confirmed.
14. DevNet SOL onboarding exercised: `sponsor-sol` handler granted 0.01 SOL, signature `3Dec58wN3Xi2HCKpHmp3URh7ygXGJxqimT9rm9m2Ztadrev5E566pu4h2PWRY6dBbLnhipjpAKtXufDTQJ2z9sSY` ([Explorer](https://explorer.solana.com/tx/3Dec58wN3Xi2HCKpHmp3URh7ygXGJxqimT9rm9m2Ztadrev5E566pu4h2PWRY6dBbLnhipjpAKtXufDTQJ2z9sSY?cluster=devnet)), post-grant balance confirmed live at 10,000,000 lamports (0.01 SOL, up from 0), and an immediate repeat grant request was also correctly rejected with 429.
15. No Mainnet-compatible path: both handlers' unconditional `assertDevnetCluster()` call was exercised live this run (genesis hash matched DevNet) and its reject path is covered offline (`tests/phase_b_devusdc.ts`, simulated Mainnet genesis hash) — no code path in either handler builds a mint/transfer instruction before this check passes.

**Manager/swap-authority wallet balance after this pass:** ~0.391 SOL (down
from ~0.404 SOL before Phase B — spent on mint-account rent, two faucet ATA
creations, and one 0.01 SOL sponsorship grant; consistent with expected
costs, confirming no unexpected drain).

### Tests, typecheck, lint, build
- `tests/phase_b_devusdc.ts` (new, offline): 20/20 passing — devUSDC config, DevNet-only enforcement (including a simulated-Mainnet-genesis reject path), best-effort cooldown logic, authority-loading (missing-env-var honest failure; valid-env-var parses correctly using a disposable test keypair, never the real one), shared request-body parsing, invalid-pubkey rejection.
- `tests/phase_a_discovery.ts` (pre-existing): 12/12 passing, unaffected.
- `npx tsc -b` (repo-wide): clean.
- `npx tsc -p api/devnet/tsconfig.json --noEmit`: clean.
- `npx tsc -p scripts/tsconfig.json --noEmit`: clean.
- `npx tsc -p tsconfig.tests.json`: clean.
- `npx tsc -p tsconfig.node.json --noEmit`: clean (confirms the `api/devnet/_lib/` relocation, chosen specifically to avoid this project's stricter `nodenext`/`verbatimModuleSyntax` settings, didn't regress the dashboard's pre-existing `lib/dashboard/*` files).
- `npx oxlint`: zero new warnings/errors.
- `npx vite build`: passes.

### What offline tests do NOT cover (by design, matching this repo's existing split)
RPC failure mid-transaction, confirmation timeout, wallet disconnection
mid-flow, and faucet exhaustion are not independently unit-tested with
mocks — this repo has never mocked `@solana/web3.js`'s `Connection`/
`sendAndConfirmTransaction` for its DevNet endpoints (`swap-sign.ts`,
`mint-test-assets.ts` have no offline tests either); live verification
scripts are the established verification layer for real on-chain behavior.
The "sponsor exhausted" path and RPC-failure error paths are implemented
(honest error responses, no fabricated success) and code-reviewed but were
not artificially triggered this pass (the authority had sufficient balance
throughout); this is noted as a residual, low-risk gap rather than
silently claimed as fully proven.

### Known limitations
- Per-wallet cooldown is in-memory/best-effort (resets on cold start) —
  documented, matches the pre-existing dashboard-login precedent; the
  durable defense is always the live balance ceiling.
- The shared manager/swap-authority wallet now backs four DevNet duties on
  one ~0.39 SOL balance — will need periodic top-ups under sustained
  internal testing (see "Operational constraints" above).
- No dedicated "sponsor exhausted" or "RPC failure" live-fire test was
  performed (see above) — implemented and reviewed, not artificially
  forced.

### Phase C prerequisites (unchanged scope, now with real settlement-token infrastructure available)
Phase C (real creation, funding, Reserve Token minting/burning, proportional
redemption) can now build on: a real settlement token (devUSDC) testers can
actually acquire, a real (if tightly bounded) DevNet-SOL onboarding path,
and the shared `_lib/authority.ts`/`_lib/network.ts`/`_lib/rateLimit.ts`/
`_lib/apiTypes.ts` infrastructure this pass explicitly built for reuse.
Phase C itself — wiring devUSDC as an actual Buy-side settlement asset,
real minting against it, direct redemption — has **not** been started in
this pass, per instruction.

### Explicit confirmations (per instruction)
- **devUSDC has no monetary value.** Stated in the mint's own registry
  record, in the UI (`DevnetOnboarding.tsx`'s card description and
  per-asset disclosure text), and in this document.
- **DevNet SOL is used for network fees and account rent, not as the
  settlement asset for buying Reserve Tokens.** Buy still uses the existing
  SOL zap mechanism (unchanged, Phase A/pre-existing scope); devUSDC's role
  as an actual settlement asset for Buy is explicitly Phase C work, not
  built in this pass. The UI states this distinction directly.

---

## Phase C — implemented and live-verified (2026-07-29, continuous C-H pass)

**Finding: Phase C required zero protocol/program changes.** The deployed
program's `create_reserve`/`initialize_reserve_asset`/`seed_reserve`/
`mint_reserve_tokens_in_kind`/`redeem_reserve_tokens_in_kind` instructions
already work with any correctly-registered SPL mint — devUSDC only needed
to be added to the frontend/API's asset allowlists, exactly like a 4th
fixture mint:
- `CreateDTR.tsx`'s `DEVNET_REAL_ASSETS` (selectable when creating a real Reserve)
- `api/devnet/mint-test-assets.ts`'s `ALLOWED_MINTS` (seed-funding faucet — the swap authority is devUSDC's mint authority, same as mintX/Y/Z)
- `api/devnet/swap-sign.ts`'s `ALLOWED_ASSET_MINTS`/`ASSET_TEST_PRICES_USD` (Buy/Sell zap, priced at $1)
- `src/merge/lib/onChainReserve.ts`'s `TEST_ASSET_PRICES_USD` + symbol fallback (AUM/NAV display, discovery)
- `src/merge/lib/RealReserveSync.tsx` + `scripts/verify_discovery.ts`'s candidate-mint hint lists (so devUSDC-composed Reserves are discoverable)

**Live-verified** via `scripts/verify_devusdc_reserve.ts` (real client code,
not a reimplementation — mirrors `verify_e2e_fresh_reserve.ts`'s pattern): a
genuinely fresh Reserve (`HAaoBxSVAnaxEusxxYUnPpAJAyjRzti4zuqxrLWYS4VE`,
Reserve Token mint `48JyhsTD5bSM18NZMapMHK44Vhk2kreuP7utY5U9uNRW`) created
70% devUSDC / 30% mockX, seeded (devUSDC vault 3,500,000 raw, mockX vault
1,500,000 raw), Bought (vaults grew to 3,640,000 / 1,560,000), and Sold
(half the resulting Reserve Tokens redeemed proportionally: 1,820,000
devUSDC + 780,000 mockX out, then zapped to 0.13 SOL) — all real signatures,
real confirmations. Transaction signatures and Explorer links recorded in
the script's own output; not duplicated here to keep this section short.

**Tests/typecheck/lint/build:** `npx tsc -b`, `npx tsc -p api/devnet/tsconfig.json`, `npx tsc -p scripts/tsconfig.json`, `npx vite build`, `oxlint`: all clean. `tests/phase_a_discovery.ts` + `tests/phase_b_devusdc.ts`: 32/32 passing (unchanged, confirming no regression).

**What Phase C did NOT change:** the Sell zap still terminates in a fixed-rate SOL cash-out (Phase A's item 8/9 disclosure design, unchanged) — devUSDC being a Reserve *asset* is independent of devUSDC ever becoming the Sell *payout* asset, which remains future work if wanted. No new Rust code, no program upgrade.

## Phase D — implemented and live-verified (2026-07-29, continuous C-H pass)

**Finding: fee accrual and collection are Reserve-Token-denominated and
composition-agnostic by design — no protocol change needed.**
`mint_reserve_tokens_in_kind` accrues `mint_fee_bps` directly into
`pending_manager_fee_shares`/`pending_protocol_fee_shares` at mint time
(no separate step); `collect_fees` (permissionless) mints those pending
shares to the Reserve's configured `fee_destination` and
`ProtocolConfig.default_protocol_fee_destination`, verified against each
via `require_keys_eq!`. None of this reads or depends on which assets back
the Reserve.

**Live-verified** via `scripts/verify_devusdc_fees.ts` against the Phase C
Reserve (`HAaoBxSVAnaxEusxxYUnPpAJAyjRzti4zuqxrLWYS4VE`, 70% devUSDC / 30%
mockX): the Phase C Buy had already accrued 800 pending manager / 200
pending protocol Reserve Token shares (mint fee 50bps, 80/20 split, matching
configuration exactly). A real `collect_fees` call (signature
`2nAyMS45kLQRSKQheryzFcfknw55gTFjMQq8ovErNHvSiyfPBoBdPNzAcdqwz72PE3YZhjzkpiez7QHmPonqDQ6e`)
routed them correctly: manager balance 2,599,500 → 2,600,300 (+800),
protocol treasury (`EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq`) 0 → 200,
pending shares reset to 0.

**Tests/typecheck/build:** `npx tsc -b` clean; no new tests added (this
phase is pure verification of already-tested, unmodified protocol logic,
matching this repo's precedent for DEC-0035's original collect_fees
verification, which also had no accompanying offline test).

## Phase E — Jupiter feasibility: proven infeasible, flagged as a blocker (2026-07-29)

**Real, live API evidence, not an assumption:**
- `GET api.jup.ag/swap/v1/quote` for `SOL -> devUSDC`: HTTP 400,
  `{"error":"The token Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k is not tradable","errorCode":"TOKEN_NOT_TRADABLE"}`.
- The same endpoint for `SOL -> Mainnet USDC` (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`):
  HTTP 200, a real quote routed through real **Mainnet** AMM pools (Raydium
  CLMM, Manifest — real Mainnet program/pool addresses in the route plan).

**Conclusion: Jupiter's aggregator API has no DevNet awareness at all** —
it is not that our specific test mints aren't listed; it's that the API
only ever quotes against Mainnet liquidity, full stop. Even if a mint were
"tradable," the resulting quote/transaction would reference Mainnet pool
accounts, unusable on DevNet by construction. **No amount of additional
configuration or a different mint pair changes this — Jupiter cannot serve
DevNet, period.** This confirms DEC-0040's prediction exactly.

**Per the approved instructions, the fallback is "the smallest legitimate
controlled on-chain DevNet liquidity or swap mechanism for representative
test assets."** This is where this pass stops and flags a genuine,
unresolved product-decision blocker rather than proceeding unilaterally:

- Building any real on-chain swap/AMM mechanism is a **significant,
  scope-expanding architecture decision** that directly reopens
  DEC-0017/DEC-0021's deliberate v1 scope boundary ("SSR v1 does NOT
  implement on-chain trade execution"). It is not a small filled-in blank.
- Design space is genuinely open and consequential: a new dedicated
  program vs. an extension of `ssr_protocol`; a real constant-product AMM
  vs. a generalized version of the existing fixed-rate swap-authority
  mechanism; scope (just enough for Sell's optional "redeem and swap" leg,
  or also enough for Phase F's rebalance trade execution).
- Building this without checking would risk committing to an architecture
  the user did not actually want, on a live program other work already
  depends on.

**What this blocks, precisely:** item 8/9's optional "redeem and swap to
SOL" secondary Sell path (still correctly absent per Phase A's decision —
nothing regressed), and Phase F's actual rebalance **trade execution**
(moving real holdings toward target weights). **What this does NOT
block:** Phase F's composition-**management** (config-only: add/disable a
Reserve, change target weights — no trade execution involved) and Phase G
(wind-down) are both independent of this decision and proceed below.

**No code was written for this phase** — it is a research/decision
checkpoint only.

## Phase F: composition management (config-only) — security analysis + implementation

Scope confirmed above: config-only changes to an **Active** Reserve's asset
list (add a Reserve Asset, remove one, change target weights) — no trade
execution. `update_targets` already existed. This phase adds the missing
add/remove pair.

**Design constraint discovered before writing any Rust:** `common::
load_asset_legs` (used by mint/redeem) and `load_reserve_asset_configs`
(used by `update_targets`) both require **exactly** `reserve.asset_count`
accounts in `remaining_accounts`, unfiltered by `enabled`, in strict
`order_index` order. Two consequences that reshaped the original plan:

1. A simple `enabled` flag flip (the original "disable_reserve_asset" plan)
   would NOT stop new deposits into a "disabled" asset — nothing in
   `mint_reserve_tokens_in_kind`'s deposit math (`mul_div_ceil(requested,
   vault_balance_before, total_supply_before)` per asset) reads `enabled` or
   `target_weight_bps` at all; it's purely balance-ratio-based. A disabled
   asset would still receive deposits proportional to its existing vault
   balance on every Buy. So "disable" was replaced with actual **removal**.
2. Removal is only structurally safe, without renumbering every other
   asset's `order_index` or building a balance-draining mechanism, for the
   **last-registered** asset (`order_index == asset_count - 1`) with a
   **zero** vault balance. Both are enforced as hard requires. Removing a
   non-last or non-empty asset is explicitly out of scope for this pass.
3. A brand-new asset added to an *Active* Reserve starts at zero vault
   balance — and stays there forever under the same ratio-based math
   (`mul_div_ceil(x, 0, supply) = 0`). A dedicated bootstrap instruction was
   added to solve this rather than leaving newly-added assets permanently
   unfundable.

**Instructions added** (`programs/ssr_protocol/src/instructions/`):

- **`add_reserve_asset_active`** — registers a new zero-balance
  `ReserveAsset` + vault on a Reserve already in `Active` status. Does
  **not** modify `initialize_reserve_asset` at all (zero regression risk to
  the pre-Active creation flow already live-verified in Phases A–D) —
  mirrors its account/validation shape (max-asset-count ceiling, total
  target weight ≤ 10,000 bps, Token-2022 extension validation) but is a
  fully separate instruction and PDA-derivation-compatible module. Callable
  by the root manager or a delegate holding the `MANAGE_LIQUIDITY_CONFIG`
  permission bit — an existing flag defined in `state/delegate.rs` as
  "future-facing, not exercised by any v1 instruction," now given its first
  real use rather than inventing a new bit.
- **`fund_new_reserve_asset`** — manager-only (kept simple; no delegate
  path), additive-only transfer of the manager's own tokens directly into a
  target vault. Restricted to only work while that vault's balance is
  exactly zero (one-time bootstrap, not a general top-up). No Reserve Token
  is minted — this is a pure backing increase that benefits every existing
  holder equally and dilutes nobody.
- **`remove_reserve_asset`** — closes a `ReserveAsset` and its vault
  (rent reclaimed to the root manager, never to a calling delegate — the
  `manager` account is validated by address against `reserve.manager`
  regardless of who signs), decrements `asset_count`/
  `total_target_weight_bps`. Requires last-registered + zero balance (see
  above). Same manager-or-`MANAGE_LIQUIDITY_CONFIG`-delegate authorization
  as add.

New errors: `AssetNotLastRegistered`, `VaultNotEmpty`. New events:
`ReserveAssetAdded`, `ReserveAssetFunded`, `ReserveAssetRemoved`.

**Verified**: `cargo check` and `cargo clippy` against
`programs/ssr_protocol` — zero errors, zero new warnings (two pre-existing
`clippy::redundant_field_names` warnings in `update_protocol_config.rs`,
untouched by this pass). Runtime behavior not yet exercised against a
running validator — see the Phase F/G live-DevNet-verification section
below, done after the batched upgrade.

## Phase G: wind-down lifecycle — security analysis + implementation

Scope: one-way `Active -> WindDown -> Closed` lifecycle, root-manager-only
throughout (no delegate path — matches the existing "root-exclusive unless
explicitly defined otherwise" boundary already used for authority transfer
and unrestricted-delegate grant/revoke).

**`ReserveStatus` extended** (`state/reserve.rs`) with two new unit variants,
`WindDown` and `Closed`, appended **after** `Paused`. Confirmed safe:
Borsh encodes this enum by variant index, so `Created`=0/
`AssetsInitializing`=1/`Active`=2/`Paused`=3 keep their existing encoded
values for every already-initialized `Reserve` account on live DevNet;
appending new variants at the end never breaks existing deserialization.

**Design tension found and resolved during this pass:** the original sketch
planned to revoke the Reserve Token mint authority at `initiate_wind_down`
time as defense-in-depth against new issuance. This was dropped —
`collect_fees` needs the mint-authority PDA to remain usable during
`WindDown` (fees stay collectible while winding down, by design), and
revoking it would have permanently broken fee collection for every Reserve
that ever winds down. New issuance is already fully blocked with **zero**
code changes to `mint_reserve_tokens_in_kind`, since it requires
`status == Active` exactly — `WindDown` isn't `Active`, so it's already
excluded.

**Second, more consequential tension found and resolved:** `close_reserve`
requires the Reserve Token supply to reach exactly zero — reachable only if
holders can still redeem out during `WindDown`. But `redeem_reserve_tokens_
in_kind` called `Reserve::require_active_or_paused()`, which only allowed
`Active` or `Paused` — **not** `WindDown`. Left as-is, this would have made
`close_reserve` permanently unreachable for any Reserve that actually winds
down (supply could never hit zero). Fixed by extending that check to also
allow `WindDown`, and renaming it to `require_redemption_allowed` (one call
site, in `redeem_reserve_tokens_in_kind.rs`, updated to match) since
"active-or-paused" no longer accurately describes what it gates. Redemption
remains exempt from all pause-style blocking during `WindDown`, exactly as
it already was for `Paused` under DEC-0016.

**Instructions added:**

- **`initiate_wind_down`** — root-manager-only (`has_one = manager`, no
  delegate account at all), requires `status == Active`, sets `status =
  WindDown`. One-way; no reverse instruction exists or is planned.
- **`close_reserve`** — root-manager-only, requires `status == WindDown`,
  requires `reserve_token_mint.supply == 0`, and requires every registered
  asset's vault balance to be zero (verified via `remaining_accounts`: pairs
  of `[reserve_asset, vault]` per asset, in `order_index` order — lighter
  than `common::load_asset_legs` since no owner-token-account/mint/
  token-program per leg is needed here). Closes the `Reserve` account (via
  Anchor's `close = manager` constraint), every `ReserveAsset` account (via
  `Account::close`), and every vault token account (via a real SPL
  `CloseAccount` CPI signed by the vault-authority PDA) — all rent reclaimed
  to the manager. Deliberately does **not** attempt to close the
  `reserve_token_mint` account itself: SPL Token mint-account closing
  semantics are an unnecessary risk to take on a live program for a small,
  permanently-locked amount of rent (accepted, documented inefficiency).
  Once closed, the Reserve PDA no longer exists at all — `Closed` as a
  persisted status is therefore never actually read back; the existing
  discovery layer's `fetchNullable`-returns-null-for-this-PDA behavior
  already communicates "this Reserve is gone" without needing one.

New errors: `ReserveTokenSupplyNotZero`. New events: `WindDownInitiated`,
`ReserveClosed`.

**Verified**: `cargo check` and `cargo clippy` -- zero errors, zero new
warnings (same two pre-existing warnings noted above, unrelated to this
pass).

## Phase F/G: deployment + live-DevNet verification

Blocked briefly on a DevNet SOL shortfall (the larger binary's upgrade
buffer cost ~4.51 SOL; the deployer wallet held 3.65985132 SOL, and the
public faucet was fully rate-limited across every retry -- see DEC-0047).
The user resolved this with a real, finalized 5 SOL transfer to the
deployer wallet (confirmed via `solana confirm` against signature
`4oBt6rh3x8uLUDp9Zqm7De2wvvM97ysADZXgr2JXz1B7jjTUrKrUeEjJ69pqSgJakg58VD3fQjhophzUBexw8C2k`:
3.65985132 -> 8.65985132 SOL).

**Deployed**: `solana program deploy` succeeded (signature
`W9w5pn9wTwHayWPbVXL89WKYTYDQZ39ZpY5jZefi9ZTVVTNZzjMiE1SYqC8cVZvNyKhStuiRQuZnS4d5wD8sDK8`).
`solana program show` confirmed Data Length 647,608 bytes, matching the
built `.so` exactly, with the same upgrade authority as before.

**IDL regenerated**: plain `anchor build` still panics in
`cargo-build-sbf`'s toolchain-detection code in this environment (a
separate, pre-existing issue, unrelated to this pass's Rust changes --
direct `cargo build-sbf` works fine and is what produced the deployed
binary). `anchor idl build` uses a different code path and succeeded,
producing a fresh `target/idl/ssr_protocol.json` with all 23 instructions;
copied into `packages/sdk/idl/ssr_protocol.json` (the runtime IDL the
frontend/SDK/scripts actually load). The camelCase `.ts` type helper
(`packages/sdk/idl/ssr_protocol.ts`) was left stale rather than
hand-rolled -- it's compile-time-only convenience typing, not used by
Anchor's runtime instruction building, and this codebase already has an
established `(program.methods as any)` pattern for exactly this situation
(see `scripts/verify_devusdc_fees.ts`'s `collectFees()` call).

**Live-verified** via a new script, `scripts/verify_phase_f_g.ts`, real
transactions only:

- **Part 1** (persistent Gate-9 fixture `reserveOne`, NOT the Phase C
  script's own Reserve -- that one's manager was an ephemeral
  `Keypair.generate()` never persisted anywhere, discovered live when the
  script's own manager-mismatch guard correctly refused to proceed under
  the wrong signer): `add_reserve_asset_active` registers mockZ (not
  already on reserveOne) at 0 bps, asset_count 2->3, `order_index` 2 as
  expected; `remove_reserve_asset` removes it again, asset_count back to
  2, both the `ReserveAsset` and vault accounts confirmed actually gone via
  `getAccountInfo` returning null; `add_reserve_asset_active` re-registers
  it; `fund_new_reserve_asset` transfers 5,000,000 raw mockZ from the
  manager's own wallet directly into the vault, confirmed by balance.
- **Part 2** (a brand-new, disposable single-asset devUSDC Reserve created
  fresh in the script): `initiate_wind_down` flips status to `windDown`;
  an attempted `mint_reserve_tokens_in_kind` is rejected with custom
  program error `0x177a` (6010 = `UnexpectedReserveStatus`'s exact
  position in the error enum -- confirmed the *specific* intended check
  fired, not an incidental failure); `redeem_reserve_tokens_in_kind` for
  the full balance **succeeds** during `WindDown` (the exact invariant
  this pass's `require_redemption_allowed` fix exists for -- without it,
  this step would fail and `close_reserve` would be unreachable);
  Reserve Token supply confirmed 0 afterward; `close_reserve` succeeds,
  and the Reserve, `ReserveAsset`, and vault accounts are all confirmed
  actually gone on-chain (`fetchNullable`/`getAccountInfo` all return
  null), not merely reported as closed.

All 8 real transactions succeeded exactly as designed; see DEC-0048 for
every signature. `reserveOne` now permanently carries a 3rd asset (mockZ,
0 bps target weight, ~5.0 backing) as a harmless, documented side effect of
this live test -- the same "genuine on-chain side effect from real
verification" pattern already established by earlier phases.

