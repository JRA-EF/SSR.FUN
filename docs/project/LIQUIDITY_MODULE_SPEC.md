# SSR.fun Liquidity Module: Creator Liquidity and DEX Listing

**Status:** v0.2. Front-end DESIGN PREVIEW implemented 2026-09-30 (DEC-0195): `src/merge/lib/liquidityPreview.ts`, `src/merge/components/LiquidityModule.tsx`, `useAppStore.liquidityPreviews`, the Manager Dashboard "Liquidity" tab (root Manager only), and the post-first-mint prompt on the Reserve page. The preview is local state, labelled as such on every surface, and moves no funds -- the real Raydium/Uniswap client replaces the three `*LiquidityPreview` store actions. Decisions marked OPEN need a ruling and a DEC entry in `docs/project/DECISION_LOG.md`.
**Author:** Yeh (Enigma) with Claude. 2026-09-29.
**Audience:** SSR.fun developers, design, and marketing.
**Vocabulary note:** this is an internal document. User-facing copy derived from it must follow the Mandatory Terminology rules in the repo's `CLAUDE.md` (Reserve, reserve assets, Reserve Token, Co-Manager; never DTR/DTF/bundle/governance in anything public).

---

## 1. Summary

When a creator launches a Reserve and mints the first Reserve Tokens, those tokens exist and are backed, but they are not tradeable anywhere except mint/sell on SSR.fun itself. This module gives the creator a first-class flow to add DEX liquidity for their Reserve Token, directly from SSR.fun:

- **Solana Reserves:** liquidity pool on **Raydium**, paired with SOL or USDC.
- **Robinhood Chain Reserves:** liquidity pool on **Uniswap**, pairing asset TBD (see OPEN-2).
- Presented as a **split-screen step** after the creator's first mint (not a popup or modal), and permanently available as a **Liquidity section in the creator dashboard**.
- Recommends **at least $1,000** in total liquidity, **preferably $10,000**.
- Offers **liquidity locking**: lock for a chosen period, or lock all of it permanently.

The result: the Reserve Token gets a live market, a Dexscreener chart (indexing is automatic once a Raydium/Uniswap pool exists), and a trust signal (locked liquidity) that the Reserve page can surface as a badge.

---

## 2. Why this matters (the economics)

A Reserve Token has two possible prices:

1. **NAV price:** the value of the reserve assets backing each token. This is what mint and sell on SSR.fun settle against.
2. **Market price:** whatever a DEX pool says. This only exists once someone seeds liquidity.

Without a pool there is no market price, no chart, no ticker on aggregators, and no way for anyone to buy the token except minting on SSR.fun. With a pool, three things happen:

- **Discoverability.** The token appears on Dexscreener and aggregators within minutes of pool creation. This is the single biggest distribution unlock per dollar spent.
- **The arbitrage loop that makes the product work.** If the market price rises above NAV, anyone can mint at NAV on SSR.fun and sell into the pool. If it falls below NAV, anyone can buy from the pool and sell/redeem at NAV. Arbitrageurs keep the market price tethered to NAV. This is the same create/redeem mechanism that keeps ETFs at fair value, and it is why the Premium/Discount metric already in the app UI becomes meaningful the moment a pool exists.
- **Creator revenue.** LP positions earn the pool's trading fees. A creator who seeds and locks liquidity still earns swap fees on it (see Section 7), which stacks with mint fees, management fees, and buy/sell tax as a fourth creator revenue stream.

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
- Actions: add liquidity, lock (or extend a lock), and a one-click **Collect fees** button. Collected fees are routed to the **Reserve treasury wallet**, never to the connected wallet; the UI states this and shows the treasury address (hyperlinked). Removing liquidity is possible for unlocked LP only, and the UI should be honest that removing liquidity is visible on-chain and erodes holder trust.

---

## 4. The Liquidity panel (the artifact)

### 4.1 Inputs

| Field | Behavior |
|---|---|
| Pairing asset | Solana Reserves: SOL or USDC (selector). Robinhood: TBD (OPEN-2). |
| Reserve Token amount | Prefilled from the creator's balance; editable. |
| Pairing asset amount | Auto-calculated from NAV so both sides match in value; editable with warning (see 4.3). |
| Total liquidity readout | Big number: combined USD value of both sides. |
| Lock option | None / Lock for a period (presets: 1, 3, 6, 12 months) / Lock permanently. Applied to a chosen percentage of the LP position, default 100%. |

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
| Solana | Raydium | Standard constant-product pool (CPMM), full range | SOL or USDC | No concentrated-liquidity ranges in v1; CLMM is a footgun for non-professional LPs and complicates lock semantics. |
| Robinhood Chain | Uniswap | Full-range position (v3 full range behaves like v2) | OPEN-2 (USDC vs native gas asset) | Same simplicity rule: no custom ranges in v1. |
| Base | TBD | TBD | TBD | Not in scope per current direction; note that Base would likely mean Uniswap or Aerodrome (OPEN-5). |

The product intent Yeh set: "a simple methodology similar to how Uniswap or Raydium works." v1 is plain constant-product, full-range liquidity. No ranges, no advanced options, nothing to misconfigure.

**Chain-aware UI rule (hard requirement):** every DEX reference in the module derives from the Reserve's home chain, meaning the chain where the Reserve Token is minted and its vault lives. Solana Reserve: Raydium everywhere. Robinhood Reserve: Uniswap everywhere. This covers the DEX name in copy, the CTA label ("Add liquidity on Raydium/Uniswap"), the live-status pill, pool-type wording, outbound pool links, and the pairing-asset options (SOL on Solana; the Robinhood alternate is ETH pending OPEN-2). No hardcoded DEX strings anywhere in the UI; one chain flag drives all of it.

---

## 6. Locking

Three states, chosen at add time (and adjustable later in the dashboard, upward only):

1. **Unlocked.** LP tokens stay in the creator's wallet. Weakest trust signal; the badge reflects that.
2. **Time-locked.** LP position held in escrow until an unlock date. Presets 1/3/6/12 months; extending is allowed, shortening never is.
3. **Permanently locked.** The LP position is irrevocably locked. On Raydium this can follow the established permanent-lock pattern where the position is locked forever but the owner retains the right to claim accrued trading fees. Devs must verify the current Raydium locking mechanism and its fee-claim behavior before building against it, and choose the Uniswap-side equivalent (standard third-party locker or a protocol escrow contract).

**Partial locks:** the creator picks the percentage of their LP to lock (default 100%). "Lock all of it" is the permanent-lock option applied at 100%.

**Trust surfacing:** the Reserve detail page and Discover cards show a liquidity badge: pool size, and lock state ("$10.4k liquidity · 100% locked 12 months" or "locked forever"). This is the external payoff of the whole feature and should be designed as a first-class trust element, not fine print.

---

## 7. Developer implementation notes

1. **Integration approach.** Use the Raydium SDK/APIs for pool creation and add-liquidity server-assisted transaction building; the creator's wallet signs everything. SSR.fun never takes custody of LP tokens except in the time-lock escrow case, where a dedicated escrow (PDA on Solana, minimal contract on Robinhood) holds the position with an immutable unlock timestamp. Keep the interface-only legal posture intact: the user executes DEX transactions, we build them.
2. **Pool creation vs add.** First interaction creates the pool (with initial price from NAV) and registers it as canonical (see 4 below). Subsequent interactions add to the existing canonical pool only.
3. **Token program compatibility.** If Reserve Tokens use Token-2022 extensions (transfer fees for the buy/sell tax, for instance), verify Raydium pool-type compatibility with those extensions early; this is the likeliest hard blocker and should be spiked first.
4. **Canonical pool registry.** DEX pools are permissionless; nothing stops a third party from creating a rogue pool for any Reserve Token directly on Raydium. The app therefore cannot "gate" pool existence, only the in-app flow. Ship a registry (protocol state or ledger table) mapping Reserve to its canonical pool address, set when the root Manager creates the pool through SSR.fun. The UI, charts, Premium/Discount metric, and badges read only the canonical pool. Document this limit honestly in internal materials.
5. **Events and ledger.** Emit and index: pool created, liquidity added, lock created (amount, percentage, unlock time or permanent), lock extended, fees collected, liquidity removed. The dashboard and badges render from the ledger.
6. **Fee collection routing.** The Collect Fees action claims accrued LP trading fees and routes the proceeds to the Reserve's treasury wallet, not to the signing wallet. The treasury destination is configured at the Reserve level and is not editable from the collect flow (a hardcoded destination is what makes the "fees go to treasury" claim verifiable). Fee accrual continues while liquidity is locked; collecting never touches the locked principal.
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
- **OPEN-6:** Are time-locks built on a third-party locker or our own escrow? (Own escrow recommended for Solana: fewer dependencies, we control the badge data.)
- **OPEN-7:** Feature name for external communication. Working options: "Go to Market" or simply "Add Liquidity". Recommendation: use "Add Liquidity" in-product (plain language rule) and "take your Reserve to market" as the marketing phrase.
- **OPEN-8:** Which treasury receives collected LP fees: the Reserve's own treasury (assumed in this spec and in the design), or a creator-chosen address set at launch? And do collected LP fees count as "reserve fees" for the 50% $SSR buyback commitment, or are they a separate creator-revenue bucket? The public tokenomics claim depends on this ruling, so it needs deciding before any external copy mentions LP fees.

---

## 9. Messaging

### Internal (team, investors under NDA)
Straightforward: creators seed and optionally lock DEX liquidity for their Reserve Token from inside SSR.fun; the arb loop between NAV mint/redeem and the pool keeps market price tracking NAV; locked liquidity becomes a verifiable trust badge; LP fees are a fourth creator revenue stream.

### External (site, X, video)
Approved-vocabulary framing, mechanism-light per the teasing protocol:
- "Mint it. List it. Lock it. Your Reserve Token, live on Raydium with one click."
- "Liquidity you can verify. Creators can lock their Reserve Token's liquidity on-chain, for months or forever, and keep earning fees the whole time."
- Never name pool types, escrow mechanics, registries, or arbitrage flows publicly. "Unchained ETF technology, socialised and agentic" remains the only technology description.
- All public claims ship only after the feature actually works on DevNet/Mainnet as described. No forward-dated "is live" claims.

---

## 10. Suggested v1 scope

Solana + Raydium only. Constant-product pool, SOL or USDC pairing, NAV-pinned initial price, $1k soft floor / $10k recommendation, lock states none/time/permanent at chosen percentage, canonical pool registry, dashboard Liquidity section, badges on Reserve detail. Robinhood/Uniswap as v1.1 once the Solana loop is proven.


## 11. Liquidity trust badges and the Reserve-page pool link (added 2026-09-30, DEC-0196)

Once a Reserve has a pool, its liquidity state becomes a PUBLIC trust signal, shown to every viewer of the Reserve page (not just the Manager), directly under the Reserve name:

- **Unlocked** (amber, open lock): "$10.4K LIQUIDITY · UNLOCKED". The honest default, and a gentle nudge for creators to lock.
- **Locked** (accent, closed lock): "$10.4K LIQUIDITY · 100% LOCKED · 347D LEFT". Countdown reads from the lock (live version: the on-chain escrow). Extending is allowed, shortening never is. An expired timed lock reads as Unlocked again.
- **Locked forever** (action yellow, closed lock): "LIQUIDITY LOCKED FOREVER". The strongest signal; the creator keeps earning trading fees but can never withdraw.
- **Deep liquidity** (emerald, droplets): an ADDITIONAL badge that appears next to the lock badge once pool TVL clears `DEEP_LIQUIDITY_USD` ($100,000 placeholder, OPEN-9), so "thick and locked forever" stacks as two signals instead of becoming a hybrid state.

Beside the badges sits a hyperlinked pool chip ("Raydium pool: mF7m...uPMD" with an external-link icon) so anyone can jump from the Reserve page straight to the pool explorer. DEX naming stays chain-derived (Section 5). Canvas reference: the "Liquidity trust badge states" artboard in the design canvas. The canvas also plans these badges for Discover cards; the implemented preview covers the Reserve page, with Discover cards a follow-up.

- **OPEN-9**: the deep-liquidity threshold. $100k absolute is a placeholder; a live version likely wants it relative to the Reserve's AUM (e.g. pool TVL >= 20% of AUM) so a small Reserve can also earn it honestly. Needs a Creator ruling.
