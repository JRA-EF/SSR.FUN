# SSR.fun Liquidity Module: Creator Liquidity and DEX Listing

**Status:** v0.3 (2026-10-02). Product rulings DEC-0222 and the conditional Solana architecture DEC-0223 are folded in below; Section 12 is the architecture. Front-end DESIGN PREVIEW implemented 2026-09-30 (DEC-0217): `src/merge/lib/liquidityPreview.ts`, `src/merge/components/LiquidityModule.tsx`, `useAppStore.liquidityPreviews`, the Manager Dashboard "Liquidity" tab (root Manager only), and the post-first-mint prompt on the Reserve page. The preview is local state, labelled as such on every surface, and moves no funds -- the real client replaces the four `*LiquidityPreview` store actions behind a liquidity adapter (Section 12.4). Decisions marked OPEN need a ruling and a DEC entry in `docs/project/DECISION_LOG.md`.
**Author:** Yeh (Enigma) with Claude. 2026-09-29.
**Audience:** SSR.fun developers, design, and marketing.
**Vocabulary note:** this is an internal document. User-facing copy derived from it must follow the Mandatory Terminology rules in the repo's `CLAUDE.md` (Reserve, reserve assets, Reserve Token, Co-Manager; never DTR/DTF/bundle/governance in anything public).

---

## 1. Summary

When a creator launches a Reserve and mints the first Reserve Tokens, those tokens exist and are backed, but they are not tradeable anywhere except mint/sell on SSR.fun itself. This module gives the creator a first-class flow to add DEX liquidity for their Reserve Token, directly from SSR.fun:

- **Solana Reserves:** liquidity pool on **Raydium**, paired with USDC (v1 is USDC-only; a SOL pair is OPEN-2b).
- **Robinhood Chain Reserves:** liquidity pool on **Uniswap**, pairing asset TBD (see OPEN-2).
- Presented as a **split-screen step** after the creator's first mint (not a popup or modal), and permanently available as a **Liquidity section in the creator dashboard**.
- Recommends **at least $1,000** in total liquidity, **preferably $10,000**.
- Offers **liquidity locking**: lock for a chosen period, or lock permanently. The lock is chosen per addition (tranche), not as a percentage (DEC-0222).
- **Entirely optional.** A Reserve is fully functional without a pool: the Reserve Token is redeemable at NAV against its reserve assets. The pool is a secondary-market venue the root Manager may add after launch, and may skip (DEC-0222).

The result: the Reserve Token gets a live market, a Dexscreener chart (indexing is automatic once a Raydium/Uniswap pool exists), and a trust signal (locked liquidity) that the Reserve page can surface as a badge.

---

## 2. Why this matters (the economics)

A Reserve Token has two possible prices:

1. **NAV price:** the value of the reserve assets backing each token. This is what mint and sell on SSR.fun settle against.
2. **Market price:** whatever a DEX pool says. This only exists once someone seeds liquidity.

Without a pool there is no market price, no chart, no ticker on aggregators, and no way for anyone to buy the token except minting on SSR.fun. With a pool, three things happen:

- **Discoverability.** The token appears on Dexscreener and aggregators within minutes of pool creation. This is the single biggest distribution unlock per dollar spent.
- **The arbitrage loop that makes the product work.** If the market price rises above NAV, anyone can mint at NAV on SSR.fun and sell into the pool. If it falls below NAV, anyone can buy from the pool and sell/redeem at NAV. Arbitrageurs keep the market price tethered to NAV. This is the same create/redeem mechanism that keeps ETFs at fair value, and it is why the Premium/Discount metric already in the app UI becomes meaningful the moment a pool exists.
- **Creator revenue.** LP positions earn the pool's trading fees. A creator who seeds and locks liquidity still earns swap fees on it (see Section 7), which stacks with mint fees, management fees, and buy/sell tax as a fourth creator revenue stream. **These are creator DEX earnings** (DEC-0222): they go to the creator's fixed treasury, they are a separate bucket from reserve fees, and they do not count toward the 50% $SSR buyback. The term covers two different mechanisms (Section 12): on permissioned CPMM a **native creator fee** that is independent of who supplies liquidity; on the CLMM fallback the **creator's share of LP-position fees**, earned pro rata to their share of active liquidity, not a guaranteed fee.
- **LP capital is separate from Reserve backing.** Reserve assets back redemption and are never taken out of the Reserve to seed a pool. Pool capital is additional capital the creator supplies voluntarily (DEC-0222).

Thin pools are worse than no pools in one respect: a $200 pool produces violent premium/discount swings and a chart that looks broken. This is why the flow pushes a $1,000 floor and a $10,000 recommendation.

---

## 3. The flow: where and when it appears

### 3.1 Trigger: the creator's first mint

- After the **root Manager's own first successful mint** of their Reserve Token, the mint success state transitions into a **split-screen view**:
  - **Left panel:** the familiar mint receipt (tokens received, reserve state), kept visible for continuity.
  - **Right panel:** the Liquidity panel (Section 4), introduced with a short headline explaining what it unlocks.
- **No modal, no popup.** The split screen is a deliberate "second act" of the launch flow, not an interruption. The creator can dismiss it ("I'll do this later") and nothing blocks them.
- **Gating: root Manager only.** Ordinary minters never see this step. Co-Managers do not see it in v1 (OPEN-3 covers whether a Co-Manager permission flag should unlock it later).
- Shown only while the Reserve has no canonical pool registered (Section 8.4). Once liquidity exists, the split screen never re-triggers; the dashboard section takes over.

### 3.2 Persistent home: the creator dashboard

The Manage view for a Reserve gains a **Liquidity** section with the exact same panel plus status:

- Pool exists or not, DEX, pair, and the **pool address, always rendered as a hyperlink** (to the pool's explorer page) and reachable at any stage: it appears both in the Liquidity section header, next to the live status pill, and in the pool detail card.
- Current pool size (TVL), creator's LP share, fees earned.
- Lock status: unlocked / locked until DATE / locked permanently, with a countdown where applicable.
- Actions: add liquidity, lock (or extend a lock), and two actions on the creator's DEX earnings: **Collect** (accrued earnings go to the creator's fixed treasury, never to the connected wallet; the UI states this and shows the treasury address, hyperlinked) and **Compound** (accrued fees are added back to the canonical pool as balanced liquidity, increasing the creator's position). Fees accrue in USDC (Section 12). Removing liquidity is possible for unlocked tranches only, and the UI should be honest that removing liquidity is visible on-chain and erodes holder trust.

---

## 4. The Liquidity panel (the artifact)

### 4.1 Inputs

| Field | Behavior |
|---|---|
| Pairing asset | Solana Reserves: USDC only in v1 (the selector shows no alternative; SOL is OPEN-2b). Robinhood: TBD (OPEN-2). |
| Reserve Token amount | Prefilled from the creator's balance; editable. |
| Pairing asset amount | Auto-calculated from NAV so both sides match in value; editable with warning (see 4.3). |
| Total liquidity readout | Big number: combined USD value of both sides. |
| Lock option | None / Lock for a period (presets: 1, 3, 6, 12 months) / Lock permanently. Applies to the liquidity added in this action (one tranche); a later addition may choose a different lock (DEC-0222). |

### 4.2 Recommendations and validation

- Soft floor at **$1,000 total**: below it, the panel warns plainly ("Pools under $1,000 produce unstable pricing and a poor chart. We recommend at least $10,000.") but does not hard-block (OPEN-4).
- **$10,000 is the highlighted recommendation**, presented as the default quick-select. Quick-select chips: $1,000 · $5,000 · $10,000 · custom.
- Interpretation note: these figures are **total pool value** (e.g. $5,000 USDC + $5,000 of Reserve Tokens at NAV = $10,000). If the intent was $10,000 per side, Section OPEN-1 flips and all copy changes.
- The creator needs capital on both sides: the USDC they spent minting went into the reserve vault to buy reserve assets, so the pairing-asset side is **new, additional capital**. The panel must say this clearly; it is the most common point of confusion.

### 4.3 Initial price = NAV, always

The pool's initial price is prefilled from the Reserve Token's current NAV. If the creator edits amounts such that the implied pool price deviates from NAV by more than 1%, show a hard warning: any deviation is free money for the first arbitrageur and a guaranteed instant loss for the creator. This is a place where protecting the creator from themselves is worth friction.

### 4.4 Panel copy direction (user-facing, vocabulary-compliant)

- Headline: "Take your Reserve Token to market."
- Subhead: "Add liquidity on Raydium and your Reserve Token becomes tradeable, with a live chart, in minutes."
- Lock section: "Locked liquidity is a promise your holders can verify on-chain. Locking does not stop you from earning trading fees."
- Never use: list/listing fees, bundle, or any mechanism language beyond what this panel does.

---

## 5. Chain and DEX matrix

| Chain | DEX | Pool type (v1) | Pairing asset | Notes |
|---|---|---|---|---|
| Solana | Raydium | **Preferred:** permissioned CPMM with native creator fee (0.25% trade + 0.75% creator), pending Raydium approval. **Committed fallback:** permissionless CLMM, full-range position, 0.8% fee tier. See Section 12 (DEC-0223). | USDC (fallback is USDC only; SOL pairing is OPEN-2b) | The creator never sees ranges in either path: the position is always full range. |
| Robinhood Chain | Uniswap | Full-range position (v3 full range behaves like v2) | OPEN-2 (USDC vs native gas asset) | Same simplicity rule: no custom ranges in v1. |
| Base | TBD | TBD | TBD | Not in scope per current direction; note that Base would likely mean Uniswap or Aerodrome (OPEN-5). |

The product intent Yeh set: "a simple methodology similar to how Uniswap or Raydium works." v1 is full-range liquidity in both paths. No ranges, no advanced options, nothing to misconfigure. Plain Raydium CPMM was ruled out (DEC-0223) because its LP fees compound into the pool and cannot be collected without withdrawing principal, which breaks the Collect/Compound rule.

**Chain-aware UI rule (hard requirement):** every DEX reference in the module derives from the Reserve's home chain, meaning the chain where the Reserve Token is minted and its vault lives. Solana Reserve: Raydium everywhere. Robinhood Reserve: Uniswap everywhere. This covers the DEX name in copy, the CTA label ("Add liquidity on Raydium/Uniswap"), the live-status pill, pool-type wording, outbound pool links, and the pairing-asset options (SOL on Solana; the Robinhood alternate is ETH pending OPEN-2). No hardcoded DEX strings anywhere in the UI; one chain flag drives all of it.

---

## 6. Locking

Locks apply to LP **principal**, never to earnings rights (DEC-0222). Three states, chosen per tranche at add time (and adjustable later in the dashboard, upward only):

1. **Unlocked.** The position stays in the creator's wallet. Principal withdrawable; fees collectable or compoundable. Weakest trust signal; the badge reflects that.
2. **Time-locked.** Position held in escrow until an unlock date. Presets 1/3/6/12 months; extending is allowed, upgrading to permanent is allowed, shortening never is. Fees stay collectable or compoundable throughout. Enforced on-chain by the escrow (Section 12.3), never by UI state alone.
3. **Permanently locked.** The position can never be withdrawn; the creator keeps earning trading fees indefinitely, collectable or compoundable. Uses Raydium's native permanent lock (Section 12.3). Uniswap-side equivalent to be chosen when Robinhood Reserves ship.

**No partial locks in v1** (DEC-0222): the lock chosen in an add-liquidity action covers that whole tranche. Different tranches may carry different locks. Badge semantics for mixed tranches are OPEN-10.

**Trust surfacing:** the Reserve detail page and Discover cards show a liquidity badge: pool size, and lock state ("$10.4k liquidity · 100% locked 12 months" or "locked forever"). This is the external payoff of the whole feature and should be designed as a first-class trust element, not fine print.

---

## 7. Developer implementation notes

1. **Integration approach.** Build the Raydium transactions client-side behind a liquidity adapter (Section 12.4); the creator's wallet signs everything. SSR.fun never takes custody of the position except in the time-lock escrow case, where the SSR escrow program holds it with an extend-only unlock timestamp. Keep the interface-only legal posture intact: the user executes DEX transactions, we build them. Every fund-moving step simulates first and goes through the normal wallet approval; copy describes outcomes in plain language.
2. **Pool creation vs add.** First interaction creates the pool (with initial price from NAV) and registers it as canonical (see 4 below). Subsequent interactions add to the existing canonical pool only.
3. **Token program compatibility.** Updated 2026-10-08 (DEC-0229/0231): new Reserve Token mints use Token-2022 with a protocol transfer fee; existing Reserves may use classic SPL Token. Resolve the mint owner and current fee settings; gross up deposits as required and open at NAV using amounts the pool actually receives. Raydium CPMM supports TransferFeeConfig, but other extensions require validation. OPEN-12 is relevant only if CLMM fallback lock work resumes.
4. **Canonical pool registry.** DEX pools are permissionless; nothing stops a third party from creating a rogue pool for any Reserve Token directly on Raydium. The app therefore cannot "gate" pool existence, only the in-app flow. Ship a registry (protocol state or ledger table) mapping Reserve to its canonical pool address, set when the root Manager creates the pool through SSR.fun. The UI, charts, Premium/Discount metric, and badges read only the canonical pool. Document this limit honestly in internal materials.
5. **Events and ledger.** Emit and index: pool created, liquidity added (tranche), lock created (tranche, unlock time or permanent), lock extended, fees collected, fees compounded, liquidity removed. The dashboard and badges render from the ledger plus chain reads; preview/localStorage state never masquerades as live.
6. **Earnings routing.** Collect claims the creator's accrued DEX earnings and pays them to the creator's treasury (the creator-designated fee recipient fixed at the Reserve level), not to the signing wallet; because the destination cannot be redirected, Collect may be permissionless. Compound is creator-authorised: it harvests the accrued USDC and forms additional balanced canonical liquidity -- how the Reserve Token side is obtained is OPEN-13 and blocks the live implementation. Fee accrual continues while liquidity is locked; neither action touches principal. Whether the treasury can ever change, and who can change it, is OPEN-11.
7. **Premium/Discount metric.** Wire the existing UI metric to canonical-pool price vs NAV once a pool exists; keep the current flatline/empty state when none does.
8. **Naming.** Internal identifiers are free (module name `liquidity`, whatever is idiomatic). User-facing copy follows Section 4.4 and the repo terminology rules. Log the shipped terminology as a DEC entry.
9. **First-mint detection.** The split-screen trigger is: mint event where minter == root Manager AND Reserve has zero prior mint events AND no canonical pool. Make the trigger state resumable (creator dismisses, returns via dashboard).

---

## 8. Open questions (need rulings)

- **OPEN-1:** $1,000 / $10,000: total pool value (assumed here) or per side?
- **OPEN-2:** Robinhood Chain pairing asset: USDC, the chain's native gas asset, or both?
- **OPEN-3:** Should a Co-Manager permission flag ever unlock the liquidity panel, or root Manager forever?
- **OPEN-4:** Is $1,000 a soft floor with a warning (assumed) or a hard minimum?
- **OPEN-5:** Base chain scope and DEX choice, when Base Reserves ship.
- **OPEN-6:** RESOLVED (DEC-0223): own minimal escrow program for timed locks; Raydium's native lock for permanent. Third-party lockers either cannot harvest fees from a custodied position or could not be verified.
- **OPEN-7:** Feature name for external communication. Working options: "Go to Market" or simply "Add Liquidity". Recommendation: use "Add Liquidity" in-product (plain language rule) and "take your Reserve to market" as the marketing phrase.
- **OPEN-8:** RESOLVED (DEC-0222): collected LP fees go to the creator's treasury (creator-designated fee recipient, fixed at the Reserve level) and are a separate creator-revenue bucket; they do not count toward the 50% $SSR buyback.
- **OPEN-2b:** Solana pairing asset. The CLMM fallback is USDC only (fees collected in USDC); whether a SOL pair is offered at all, and when, needs a ruling.
- **OPEN-10:** Badge semantics when a Reserve's tranches carry different locks (e.g. one tranche permanent, one unlocked): show the weakest state, the locked percentage of TVL, or a stacked badge?
- **OPEN-11:** Can the creator's fee treasury ever change after a lock exists, and who can change it?
- **OPEN-12:** Confirm USDC and SOL are not on Raydium's CLMM restricted-issuer freeze list (position NFTs in such pools are frozen and cannot enter a lock or escrow) before any lock is built.
- **OPEN-13 (blocks live Compound):** creator DEX earnings accrue in USDC only, but balanced liquidity needs a Reserve Token side. The live Compound implementation still needs a defined method for obtaining it -- `IncreaseLiquidityV2` (or a CPMM deposit) takes both tokens and cannot turn USDC-only earnings into balanced liquidity by itself. Candidates to compare: (a) SSR primary mint at NAV with half the USDC (in-kind mint means buying the constituents first; pays the mint fee; no price impact on the pool); (b) buying Reserve Tokens from the canonical pool with half the USDC (one swap, pays the pool's own fee and moves the pool price); (c) using Reserve Tokens the creator already holds (no cost, but requires creator inventory and consent, and changes the creator's own exposure). Also decide a single-sided fallback when none applies. **Do not implement Compound live until this is resolved.** The preview's Compound deliberately models (c)-like balanced re-adds at NAV and says nothing about mechanism.

---

## 9. Messaging

### Internal (team, investors under NDA)
Straightforward: creators seed and optionally lock DEX liquidity for their Reserve Token from inside SSR.fun; the arb loop between NAV mint/redeem and the pool keeps market price tracking NAV; locked liquidity becomes a verifiable trust badge; LP fees are a fourth creator revenue stream.

### External (site, X, video)
Approved-vocabulary framing, mechanism-light per the teasing protocol:
- "Mint it. List it. Lock it. Your Reserve Token, live on Raydium with one click."
- "Liquidity you can verify. Creators can lock their Reserve Token's liquidity on-chain, for months or forever, and keep earning fees the whole time."
- Never name pool types, escrow mechanics, registries, or arbitrage flows publicly. "Unchained ETF technology, socialised and agentic" remains the only technology description.
- All public claims ship only after the feature actually works on the staging site against Mainnet as described. No forward-dated "is live" claims.

---

## 10. Suggested v1 scope

Solana + Raydium only. Full-range position (permissioned CPMM preferred, 0.8% CLMM fallback, Section 12), USDC pairing, NAV-pinned initial price, $1k soft floor / $10k recommendation, lock states none/time/permanent per tranche, Collect and Compound, canonical pool registry, dashboard Liquidity section, badges on Reserve detail. Robinhood/Uniswap as v1.1 once the Solana loop is proven.


## 11. Liquidity trust badges and the Reserve-page pool link (added 2026-09-30, DEC-0218)

Once a Reserve has a pool, its liquidity state becomes a PUBLIC trust signal, shown to every viewer of the Reserve page (not just the Manager), directly under the Reserve name:

- **Unlocked** (amber, open lock): "$10.4K LIQUIDITY · UNLOCKED". The honest default, and a gentle nudge for creators to lock.
- **Locked** (accent, closed lock): "$10.4K LIQUIDITY · 100% LOCKED · 347D LEFT". Countdown reads from the lock (live version: the on-chain escrow). Extending is allowed, shortening never is. An expired timed lock reads as Unlocked again.
- **Locked forever** (action yellow, closed lock): "LIQUIDITY LOCKED FOREVER". The strongest signal; the creator keeps earning trading fees but can never withdraw.
- **Deep liquidity** (emerald, droplets): an ADDITIONAL badge that appears next to the lock badge once pool TVL clears `DEEP_LIQUIDITY_USD` ($100,000 placeholder, OPEN-9), so "thick and locked forever" stacks as two signals instead of becoming a hybrid state.

Beside the badges sits a hyperlinked pool chip ("Raydium pool: mF7m...uPMD" with an external-link icon) so anyone can jump from the Reserve page straight to the pool explorer. DEX naming stays chain-derived (Section 5). Canvas reference: the "Liquidity trust badge states" artboard in the design canvas. The canvas also plans these badges for Discover cards; the implemented preview covers the Reserve page, with Discover cards a follow-up.

- **OPEN-9**: the deep-liquidity threshold. $100k absolute is a placeholder; a live version likely wants it relative to the Reserve's AUM (e.g. pool TVL >= 20% of AUM) so a small Reserve can also earn it honestly. Needs a Creator ruling.


## 12. Solana architecture (added 2026-10-02, DEC-0223; conditional on Raydium)

Two paths, both behind one adapter so the UI, store and badges do not change when the primitive does. **Raydium permission verified on Mainnet on 2026-10-08 (DEC-0231).** The approved payer is `6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS`; permission PDA `HqMmvmtRUHup5ACL7mTf5bCj6STYB6ZUMgnd4CN8LmLB`. Permission applies to this payer, separately from each Reserve's fee treasury. The permissioned CPMM path is now selected; the CLMM path remains a fallback.

### 12.1 Preferred: permissioned Raydium CPMM with native creator fee

- Raydium CPMM `AmmConfig` index 9 (`LNmHRmMvk9kmtepfTSr98kqGLThd61kH1DPWf2cVRaC`) is 0.25% trade fee + 0.75% creator fee: 1.00% all-in for the trader. It is API-only (`showWithUI=false`); 98 pools use it today.
- Creator fees exist only on pools created with `InitializeWithPermission`, which requires a `Permission` PDA that only Raydium's admin / permission-owner keys can create (8 exist on Mainnet). Permission granted and independently verified (DEC-0231). For the integration: `pool_creator` = the creator's fixed treasury, so `CollectCreatorFee` / `CollectCreatorFeePermissionless` can only pay there; Compound = collect then deposit; permanent lock = Raydium's LP lock (fee harvest retained); timed lock = minimal SPL LP-token escrow.
- Since 2026-09-19 Raydium's program can keep a configurable share of creator fees at collection time (`creator_fee_share_rate`, verified at 50,000 / 1,000,000 = 5% on index 9 on 2026-10-08; the older zero-share snapshot is superseded). This must be part of the Raydium conversation.
- The creator fee here holds regardless of who else supplies liquidity. Normal LP economics remain separate and accrue to LP providers. The preview labels the Solana pool type neutrally as "liquidity pool" until the adapter knows which primitive is live; "full-range position" is CLMM-only wording.

### 12.2 Committed fallback: permissionless Raydium CLMM, full range, 0.8%

- Pool: Reserve Token / USDC on `AmmConfig` index 17 (`DQeN7dZyQvXKT7YwmgqyuC7AYFkwMoP7RwtucsDEdfYZ`, 0.8%, tick spacing 60). 12% of fees go to Raydium protocol, 4% to its fund, 84% to active LP positions. With 100% of active liquidity the creator earns ~0.672% of volume; with less, pro rata. This is LP income, not a privileged creator fee.
- Creation: `CreateCustomizablePool` with `sqrt_price_x64` from NAV, `collect_fee_on` = the USDC side (`Token0Only` or `Token1Only` depending on mint ordering, decided at creation), `enable_dynamic_fee = false`. Raydium derives the pool address from (config, mint0, mint1), so there is one pool per pair per tier; create the pool and add the first liquidity in one flow to avoid a stranger creating it first at the wrong price.
- Position: full range (ticks at the spacing-aligned min/max), so the creator never sees ranges and the pool behaves like x·y=k.
- Collect: `DecreaseLiquidityV2` with liquidity 0; the recipient USDC account is the fixed treasury's (the program does not check the recipient owner). Compound: harvest, obtain the Reserve Token side (OPEN-13 -- `IncreaseLiquidityV2` needs both tokens), then `IncreaseLiquidityV2` on the tranche, or a new full-range position when the tranche is permanently locked.
- 1.0% (index 3) was rejected: each 0.2% of fee buys ~0.168% of creator take for ~0.4% of extra arbitrage band.

### 12.3 Locks

- **Timed (1/3/6/12 months):** a minimal SSR escrow program holds the position (CLMM position NFT, or CPMM LP tokens in 12.1) with `unlock_ts`; instructions: extend (new > old only), make-permanent (one-way, hands the position to Raydium's lock), harvest (CPI to the DEX collect, recipient = fixed treasury, may be permissionless), compound (creator-authorised), withdraw (only when unlocked or expired). The escrow's upgrade authority must not be able to weaken a lock: immutable after audit, or behind a stricter time-delayed multisig than the current 1-of-3.
- **Permanent:** Raydium's native lock (`LockClmmPosition` / fee-key NFT for CLMM; LP lock for CPMM). Fee harvest is retained through the fee-key NFT, which must be held by (or route to) the treasury context, never the creator's connected wallet. Raydium will not add liquidity to a locked position, so Compound on a permanently locked tranche = harvest → open a new full-range position → lock it too; to the creator, "locked forever liquidity went up".
- Raydium's API and DexScreener recognise Raydium's own locks, not the SSR escrow; badges read chain state in both cases.

### 12.4 Adapter

`src/merge/lib/liquidity/` (to be created) exposes one interface used by the components and store: `createPoolAndAdd`, `addTranche`, `lock`, `extendLock`, `collect`, `compound`, `readPool` (TVL, price vs NAV, tranches with lock state, accrued fees). `RaydiumClmmAdapter` implements 12.2; `RaydiumPermissionedCpmmAdapter` implements 12.1 when permission exists. `dexInfoFor` keeps supplying every DEX name and pool-type label; the preview adapter is today's store slice.

### 12.5 NAV-arbitrage band

Fee-only no-arbitrage band with `ssr_protocol` defaults (mint fee 0.50%, redemption fee 0%), before basket execution cost:

| DEX fee | Discount side | Premium side | Width | LP take at 100% ownership |
|---:|---:|---:|---:|---:|
| 0.25% | −0.35% | +0.85% | 1.20% | 0.210% of volume |
| 0.60% | −0.70% | +1.20% | 1.90% | 0.504% |
| **0.80%** | **−0.90%** | **+1.40%** | **2.30%** | **0.672%** |
| 1.00% | −1.10% | +1.60% | 2.70% | 0.840% |

The band is asymmetric because of the minimum mint fee. Basket execution (one Jupiter leg per constituent, both mint and redeem being in-kind) adds the USDC→basket buy cost on the premium side and the basket→USDC sell cost on the discount side; the two legs are measured separately against Jupiter's mid price, since routing cost and price impact differ by direction and are not a constant. First pass (live quotes 2026-10-01, free API, rate-limited, round-trip only): roughly 0% for a 1-asset Reserve, 0.12–0.25% for 5 assets, ~0.3% for 10 assets at $1k. `scripts/liquidity_arb_band.ts` measures each direction with the keyed Jupiter API and must be run against real Reserve compositions before implementation (DEC-0223). A Reserve's own redemption fee widens the discount side by the same amount.


### 12.6 Permissioned CPMM implementation status (2026-10-08, DEC-0231)

- Grant transaction: `2k2tw5MiPcxhoorb5EsL8guFkuRtqDD3ZJLqWRSFN9vKAtAepuTYYcur6WQJ98X9wdUYEhxFgqjRKXbKLfS1HpG`, finalized slot 454602528, no error. Raydium's permission-granting authority created the expected 280-byte Permission account; its stored authority and derived address match the approved payer. The grant does not pin economics or authorize other wallets.
- Config 9 remains 0.25% trading + 0.75% gross native creator fee. Current default creator-fee retention is 5%, giving 0.7125% net creator earnings before any treasury-specific override. Read the override keyed by `(pool_creator, config)` at collection time. The payer's grant alone says nothing about a treasury's override. The 1% DEX fee excludes token transfer fees, execution price impact and network costs.
- DEC-0229 changes compatibility assumptions: newly created Reserve Tokens use Token-2022 with a protocol transfer fee; existing classic SPL mints remain. The older Section 7.3 classic-only assertion is historical and superseded. Resolve each mint's program and current-epoch transfer-fee configuration; calculate pool NAV from net amounts received, not nominal debits. Re-run the arbitrage model including transfer fees before live pool creation.
- `src/merge/lib/liquidity/raydiumCpmm.ts` is a read/prepare adapter: validates permission, config, pool pair, treasury, token programs and USDC-only native creator-fee mode; reads per-treasury fee-sharing overrides; prepares permissionless Collect to fixed treasury ATAs. It does not sign, submit, create a pool, or implement Compound. The UI remains a design preview.
- **OPEN-14 (blocks pool-creation wiring):** choose the approved payer's signing and funding arrangement. `InitializeWithPermission` requires both initial token accounts to be owned by the approved payer and initially issues LP tokens to that payer. A different Reserve Manager's ordinary wallet cannot create permissioned pools directly. Decide connected team-wallet creation versus an explicitly authorized service or program-mediated path, including how creator capital and final LP ownership move. Do not silently transfer creator capital to a service wallet.
- OPEN-13 still blocks live Compound. Timed locks and permanent-lock integration remain to implement; the permission grant does not provide them. Keyed Jupiter quote verification on representative real compositions remains required before enabling live liquidity.
- Inspected Raydium source revision: `raydium-io/raydium-cp-swap` `b3187ae53a1b95a201f855a59024a12ca8f5b51a`. Source read only; no dependency installed or upstream scripts executed.
