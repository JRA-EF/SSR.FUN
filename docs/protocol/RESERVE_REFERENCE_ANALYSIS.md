<!--
  Comparative architecture analysis: Reserve Protocol's "Folio" (EVM/Solidity)
  vs. SSR's intended Solana-native design. Reference material only -- SSR is
  an independent protocol, not a port. See CLAUDE.md and
  docs/project/DECISION_LOG.md (DEC-0009 onward) for how these classifications
  turned into confirmed decisions.
-->

# Reserve Reference Analysis

## Reference repository

- **URL:** https://github.com/reserve-protocol/reserve-index-dtf (the user-supplied URL `reserve-protocol/resserve-index-dtf` does not exist -- 404/typo; this is the correct official repo, confirmed via the GitHub API listing of the `reserve-protocol` org)
- **Branch:** `main`
- **Commit:** `f02680d82ff34f6e719fbb586b5a1e6e96ffb518` ("Document optimistic veto supply design limitation (#196)", 2026-07-23)
- **License:** MIT
- **Local checkout:** `C:\Users\JRA DEVNET\Projects\references\reserve-protocol` (outside the tracked SSR repo, per mission instructions)
- **Stack:** Foundry + Solidity, pnpm workspace monorepo. Main contract `contracts/Folio.sol` (upgradeable, ERC1967 proxy via a dedicated `FolioDeployer` factory), auction/rebalance math in `contracts/utils/RebalancingLib.sol`, fee math in `contracts/utils/FolioLib.sol`.
- **Note on a second, related repo:** `reserve-protocol/reserve-index-dtfs-solana` also exists in the org -- Reserve Protocol's own Solana port of Folio. It was **not** cloned or studied for this analysis. The mission frames Reserve Protocol as EVM/Solidity reference material specifically ("not a Solidity-to-Rust translation," "not an EVM port"), and `reserve-index-dtf` is the canonical upstream Folio the Solana port itself would be based on. Its existence is recorded here for awareness; SSR's design below is derived independently from the EVM contract's concepts, not from Reserve's own Solana attempt.

All citations below are `file:line` against the commit above, gathered via direct inspection of `contracts/`, `test/`, `script/`, and `docs/` (not just the README).

## How to read the classification

Each mechanism below is tagged:
- **Adopt conceptually** -- the idea transfers to Solana with only mechanical changes.
- **Adapt for Solana** -- the idea is right but the concrete mechanism must change meaningfully for Solana's account/program model.
- **Defer** -- valid and eventually worth having, but out of scope for the first DevNet release.
- **Reject** -- doesn't fit SSR's requirements, is EVM-specific with no good Solana analogue, or conflicts with a stated SSR constraint (e.g. "no operator withdrawal power").

---

## 1. Deployment model

**Folio:** Factory (`FolioDeployer`) deploys a shared `Folio` logic contract once, then each new Folio is a `CREATE2`-addressed `FolioProxy` (ERC1967) + dedicated `FolioProxyAdmin`, initialized in the same transaction that pulls in the depositor's initial basket assets (`FolioDeployer.sol:51-121`). The logic contract disables its own `initialize()` (`Folio.sol:206`) so it can never be hijacked directly.

**Classification: Adapt for Solana.** There is no proxy/implementation split on Solana in the EVM sense -- an Anchor program is deployed once and upgraded in place; per-Reserve state lives in separate PDAs, not in separate proxy contracts at separate addresses. The parts that *do* transfer: (a) a factory-style creation instruction that atomically creates all of a Reserve's accounts and requires initial backing assets to be provided in the same transaction/workflow, and (b) guarding against an uninitialized/hijacked state account (Solana's analogue: PDA seed + discriminator + an explicit `initialized` flag checked on every instruction, rather than `_disableInitializers()`).

## 2. Factory model

**Folio:** `FolioDeployer` is a plain contract holding no ongoing custody -- it renounces its own temporary `DEFAULT_ADMIN_ROLE` immediately after deployment (`FolioDeployer.sol:116-118`). It is versioned; new protocol versions are new `FolioDeployer` deployments registered in `FolioVersionRegistry`.

**Classification: Adopt conceptually.** "The factory holds no standing custody or authority once creation completes" is exactly the property SSR needs (mission: "do not introduce central custody through the factory"). SSR's Reserve Factory is a set of creation instructions plus a `ProtocolConfig` PDA for global settings -- never a signer over any Reserve's vaults after creation. Version registries are deferred (see §13).

## 3. Account isolation / asset custody

**Folio:** No separate vault contract -- basket assets are literally the ERC20 balances of the Folio proxy contract itself, which is also the share-token contract (`_totalAssets()`, `Folio.sol:938-948`). Isolation between Folios is structural: each is a separate deployed contract at a separate address, not separate rows in a shared ledger.

**Classification: Adopt conceptually, adapt the mechanism.** The *isolation guarantee* (one Reserve's assets can never be reached through another Reserve's code path) is exactly right and is SSR's core security requirement. The *mechanism* must change: Solana has no "the token contract holds its own balance" concept. SSR instead uses **PDA-owned token accounts per Reserve Asset**, with vault ownership authority derived deterministically from the Reserve's own pubkey (see `ACCOUNT_MODEL.md`) -- so "isolation" is enforced by Anchor's account-constraint validation (seeds + owner checks) on every instruction, not by contract-address separation.

## 4. Share/token issuance (mint)

**Folio:** `mint(shares, receiver, minSharesOut)` is permissionless; required amounts computed on the **pre-fee gross `shares`** via `_toAssets(shares, Ceil)` (ceiling rounds in the protocol's favor); assets are **pulled** from the caller via `safeTransferFrom` (approve-then-pull, not "assets already sent"); shares are minted only after transfers succeed within the same transaction (`Folio.sol:442-477`).

**Classification: Adopt conceptually (proportional math, atomicity, protocol-favoring rounding), adapt the transfer model.** The core invariant -- "compute proportional basket requirement on the current supply/balance ratio, only mint after backing assets are confirmed in the vault, round in the protocol's favor" -- is precisely SSR's mandated core-mint invariant. The mechanism differs: Solana has no allowance/pull pattern by convention; SSR's `mint_reserve_tokens_in_kind` instead requires the depositor's token transfers into each Reserve Vault to happen via CPI within the *same instruction* (or the same atomic transaction), with the program itself invoking the SPL Token transfer using the depositor as the signing authority on their own source accounts -- functionally equivalent atomicity, native Solana idiom instead of approve+transferFrom.

## 5. Redemption

**Folio:** `redeem(shares, receiver, assets[], minAmountsOut[])` permissionless, **not** blocked by deprecation (redemption stays live in "redemption-only mode"); proportional entitlement via `_toAssets(shares, Floor)` (floor rounds in the protocol's favor); burn happens **before** asset transfers; caller supplies the exact current asset list with per-asset slippage checks; a `receiver == address(this)` special case allows burning shares without receiving assets (donation to remaining holders) (`Folio.sol:485-513`).

**Classification: Adopt conceptually, near-direct fit.** This maps cleanly to SSR's mandated redemption flow (burn-then-transfer, proportional floor-rounding, per-asset slippage protection). The "donate shares back" special case is **deferred** -- interesting but not required for a first DevNet release and adds a footgun (redeemer must deliberately opt out of receiving assets) not worth the complexity yet.

## 6. First-deposit / initial-share behavior

**Folio:** No classic ERC-4626 virtual-shares/dead-shares defense, because there is **no public first-mint moment at all** -- the very first share mint happens inside `initialize()`, atomic with the factory deployment, which asserts every declared basket asset's on-chain balance is already nonzero before minting (`Folio.sol:239-255`). The residual attack surface Folio *doesn't* defend against: a deployer could still under-collateralize by minting a huge `initialShares` against a tiny real deposit -- this is treated as a **deployer-trust assumption**, not a contract-enforced invariant (confirmed: no test targets it, `test/Folio.t.sol:177-209` only tests the zero-balance/zero-shares reverts).

**Classification: Adapt for Solana, and go further.** SSR's `create_reserve`+`seed_reserve` flow is permissionless (unlike Folio's implicitly-trusted single deployer/DAO context), so the "deployer could under-collateralize" gap Folio accepts is **not acceptable for SSR** -- a malicious permissionless creator could mint an absurd `initialShares` against a token deposit of 1 base unit, griefing every subsequent depositor via rounding. SSR's seeding design (see `ACCOUNT_MODEL.md`) requires an explicit **minimum seed amount per asset** and derives `initialShares` deterministically from the seed deposit (e.g. a fixed initial price convention: 1 Reserve Token = 1 unit of seed value, applied per-asset) rather than accepting an arbitrary caller-supplied `initialShares`, closing the gap Folio leaves open specifically because SSR removes the trusted-deployer assumption Folio relies on.

## 7. Basket/portfolio accounting

**Folio:** Two separate structures -- an unordered `EnumerableSet` "basket" (which tokens are custodied at all, no cap, no weight-sum constraint) and a separate singleton `Rebalance` struct (weight *ranges* in `D27{tok/BU}` fixed point, tied back to share supply via `RebalanceLimits` in `D18{BU/share}`) that only exists transiently during an active rebalance (`Folio.sol:118,173`, `IFolio.sol:167-198`).

**Classification: Adapt for Solana.** SSR's simpler first-release model (manual rebalancing, no continuous weight-range auctions -- see §9) doesn't need Folio's two-tier basket-set/rebalance-target split. SSR instead keeps one `ReserveAsset` PDA per basket asset holding a single current `targetWeightBps` (basis points, sum ≤ 10000, remainder = Unallocated), matching the frontend's existing native domain model (`src/domain/types.ts` `Allocation.targetBps`) -- simpler, sufficient for manual rebalancing, and consistent with product copy already shipped. Folio's separate weight-*range* concept (for auction pricing flexibility) is **deferred** to whenever/if SSR adds an auction-based rebalance mechanism.

## 8. Fees

**Folio:** `tvlFee` (streaming, computed as discrete daily-boundary compounding via `_getPendingFeeShares`, not continuous per-second minting -- `Folio.sol:1036-1062`), `mintFee` (flat, deducted from gross mint), `folioFeeForSelf` (burn instead of distribute). DAO takes a registry-configured cut with a hard floor; fee-recipient tables enforce sum-to-100%, a 64-recipient cap, and a **ratchet** guarding previously-committed "immutable" recipients from ever being reduced. Every fee-setter forces `distributeFees()` first, preventing retroactive rate changes on already-accrued fees.

**Classification: Adopt conceptually (mechanism), defer concrete values.** The accrual pattern -- account for pending fees continuously in share-price math but only physically mint/collect on an explicit call, and force a settlement checkpoint before any rate change takes effect -- is exactly right and chain-agnostic; SSR should adopt the same shape (`accrue_fees` updates an accounting counter using deterministic integer math with a defined accrual interval; `collect_fees` is the only place tokens actually move; fee-parameter changes force a checkpoint first). Per mission instructions, **do not invent final fee percentages** -- SSR's `FeeConfig` fields (creation fee, mint fee, redemption fee if intended, annualized TVL fee, manager fee, platform allocation) are implemented as safe, explicitly-labeled DevNet placeholders now, with the actual accrual/distribution mechanism real and tested. The fee-recipient ratchet (immutable recipients can't be reduced) is **deferred** -- valuable but not needed until SSR supports multiple fee recipients per Reserve, which the current frontend Create-flow already partially models (`FeeRecipient[]` in `src/merge/lib/types.ts`) but with no accrual logic behind it yet either.

## 9. Rebalancing / auctions

**Folio:** A full Dutch-auction rebalancing subsystem -- `startRebalance` (governance-level, sets weight/price ranges) → `openAuction`/`openAuctionUnrestricted` (launcher-level, narrows within those ranges) → `bid`/`createTrustedFill` (fill, exponential price-decay curve, permissionless once a launcher window lapses) → `closeAuction`/`endRebalance`. Explicitly **not** oracle-checked; safety rests entirely on governance picking sane initial price ranges and a semi-trusted `AUCTION_LAUNCHER` (documented as a social/off-chain assumption, `Folio.sol:39-45`).

**Classification: Defer entirely for the first DevNet release; adopt the conceptual shape for later.** Mission instructions are explicit: "first DevNet release uses manual Reserve-Manager-authorized rebalancing," "do not implement... open auction systems." Folio's auction design is valuable future reference (the separation of update-targets / calculate-trades / get-quotes / approve / execute / reconcile / record as **distinct, non-atomic operations** is exactly the manual-rebalance shape the mission specifies), but the Dutch-auction pricing curve, permissionless-bid mechanism, and trusted-filler async-swap custody delegation are all out of scope now. SSR's first release: `update_targets` (changes intent only, moves nothing) is a separate instruction from any instruction that actually swaps assets via a validated external router (Jupiter route, quote-bounded, min-output-enforced) -- conceptually Folio's "auction" role split (who can *set* targets vs. who can *execute* trades) maps directly onto SSR's root-Reserve-Manager-vs-co-manager model even without the auction mechanism itself.

## 10. Roles & permissions

**Folio:** OpenZeppelin `AccessControlEnumerable`. `DEFAULT_ADMIN_ROLE` (expected: governance timelock) can reconfigure fees, basket escape-hatches, rebalance policy, deprecate, and grant/revoke any role including itself. `REBALANCE_MANAGER` (expected: trading governance timelock) starts rebalances. `AUCTION_LAUNCHER` (EOA/multisig, semi-trusted) opens/closes auctions only within pre-approved bounds -- cannot touch fees, basket, or roles. `BRAND_MANAGER` has **zero on-chain permissions** (explicitly off-chain-only labeling role).

**Classification: Adopt conceptually, near-direct fit.** This role hierarchy -- one root authority that can do anything including manage other roles, one or more narrowly-scoped operational roles that can only act within bounds the root already set, and one role with no on-chain power at all (a labeling/off-chain marker) -- maps almost exactly onto SSR's mandated model: root Reserve Manager (unrestricted, exclusive authority-transfer power) plus scoped co-manager permission flags (metadata, targets, rebalance-initiate, rebalance-execute, fees, liquidity-config, pause, unpause, add/remove *restricted* co-managers only). Folio's `BRAND_MANAGER` precedent directly supports SSR's existing frontend concept of a co-manager with `managePromotion`-only permissions (`src/domain/types.ts` `DelegatePermissions.managePromotion`) — a real, useful "no real authority" co-manager tier.

## 11. Governance separation

**Folio:** No built-in timelock in the Folio contract itself -- governance separation is a **deployment/role-assignment convention** (whichever address is granted `DEFAULT_ADMIN_ROLE`/`REBALANCE_MANAGER` is expected to be a governance timelock from a separate sibling package), not a hardcoded protocol invariant.

**Classification: Reject for v1 (no DAO), revisit later.** Mission instructions are explicit: "there is no DAO in the initial DevNet version" -- the inception wallet is root Reserve Manager directly, full stop. Folio's governance-as-a-role-holder pattern is architecturally clean and worth keeping in mind (SSR's root authority is *just an address* in the account model, so nothing prevents that address later becoming a multisig or a DAO-controlled PDA without any account-model migration) but building an actual governance/timelock system is out of scope now.

## 12. Pause & emergency controls

**Folio:** No generic pause switch at all -- the only global halt is one-way `deprecateFolio()` (admin-only, no un-deprecate), which blocks mint/rebalance/auction/bid but **explicitly does not block redemption** (`notDeprecated` modifier is absent from `redeem`, `Folio.sol:485-490`). A narrower `emergencyCloseTrustedFill` exists for clawing back an in-flight async swap.

**Classification: Adopt conceptually, adapt reversibility.** The single most important thing to take from this section: **redemption staying available through a pause/deprecation is a deliberate, load-bearing design choice**, and it matches SSR's own explicit instruction ("holders' redemption rights should remain available unless a clearly documented technical safety issue makes that impossible... prefer designs that preserve redemption during pauses"). SSR adapts this by making pause **reversible** (`pause_reserve`/`unpause_reserve`, unlike Folio's one-way deprecation) since SSR's pause is meant as an operational safety valve, not an end-of-life mechanism -- and by scoping what pause blocks (new minting, target/rebalance changes) while never blocking redemption, exactly mirroring Folio's `notDeprecated`-modifier placement.

## 13. Upgradeability

**Folio:** Custom Transparent-Proxy variant on ERC1967 storage slots; a dedicated `FolioProxyAdmin` (one per Folio, plain `Ownable`) gates upgrades through a shared `FolioVersionRegistry` (rejects deprecated/unregistered versions); manual append-only storage layout with explicit version-boundary comments and deprecated-but-preserved storage slots to keep slot ordering stable across upgrades.

**Classification: Adapt for Solana.** Solana's native upgrade model (BPFLoaderUpgradeable + a `ProgramData` account holding the upgrade authority) already gives program-level upgradeability without needing a proxy/implementation split -- so the *specific* proxy-admin/version-registry mechanism is **rejected** as unnecessary complexity for Solana. What transfers conceptually: an explicit, documented upgrade-authority keypair (see `docs/protocol/DEVNET_RUNBOOK.md`), an account-level schema-version field on every persistent account struct (SSR's `Reserve.version`, `ProtocolConfig.schemaVersion`) analogous to Folio's version-boundary comments, and a stated intent to migrate the upgrade authority to a multisig before any restricted beta -- deferred concretely, but the *policy* is documented now (see Decision Log).

## 14. Valuation, rounding, dust

**Folio:** Fundamentally NAV-agnostic/proportional for mint/redeem -- no oracle read anywhere in the mint/redeem path (`_toAssets` is pure `shares * balance / totalSupply` arithmetic); oracle-shaped price inputs exist *only* inside the rebalancing/auction subsystem, and even there they're caller/governance-supplied, not fetched from an on-chain price feed. Rounding is explicit and consistently protocol-favoring (`Math.Rounding.Ceil` on mint requirements, `Floor` on redemption payouts, `Ceil` on all fee math). Dust is bounded implicitly by rounding precision and automatic basket-removal when a token's balance hits exactly zero; no active dust-tracking ledger remains in the current version.

**Classification: Adopt directly -- this is the most important conceptual match in the entire reference.** "Core proportional minting and redemption must not depend on an oracle" (mission requirement) is precisely how Folio's own mint/redeem already works. SSR adopts the identical rounding-direction policy (ceiling against the depositor on mint, floor against the redeemer on redemption, ceiling on all fee math) using Solana-native `u64`/`u128` checked integer arithmetic in place of Solidity's `mulDiv`. Dust handling (automatic basket-asset removal at exact zero balance, no separate dust ledger) is adopted as-is.

## 15. Asset limits & validation

**Folio:** No explicit basket-size cap (only gas/block-size as a practical ceiling); explicit duplicate/zero-address rejection at multiple entry points; an explicit "Weird ERC20s" support matrix in the README documenting exactly which non-standard token behaviors are and are not supported (fee-on-transfer and pausable/blocklist tokens explicitly **unsupported**, since balance-delta accounting silently under-collateralizes against them).

**Classification: Adapt for Solana; SSR needs a concrete cap where Folio doesn't.** Solana has hard, protocol-level constraints Folio doesn't (transaction size ≤ 1232 bytes, per-transaction compute-unit budget, max accounts per transaction) -- so unlike Folio, SSR **must** choose and document a concrete maximum Reserve Asset count rather than relying on an implicit gas ceiling (see `docs/protocol/ACCOUNT_MODEL.md` and Decision Log for the chosen cap and reasoning). Folio's "Weird ERC20s" documentation approach is adopted directly as a pattern: SSR must equivalently document which SPL Token / Token-2022 extensions (transfer fees, transfer hooks, non-transferable, interest-bearing) are supported vs. explicitly rejected at `initialize_reserve_asset` time, for the same underlying reason (balance-delta-based accounting cannot silently tolerate fee-on-transfer-equivalent behavior).

## 16. Events

**Folio:** A comprehensive custom event set for auctions/rebalance/fees/basket-config/lifecycle (`IFolio.sol:7-58`), but **no dedicated Mint/Redeem events** -- these rely entirely on the standard ERC20 `Transfer(0x0, receiver, shares)`/`Transfer(sender, 0x0, shares)` events, meaning an indexer must correlate the share-token Transfer with accompanying basket-token Transfers in the same transaction to reconstruct what actually happened.

**Classification: Adopt conceptually, improve on the gap.** SSR should **not** repeat the "no dedicated mint/redeem event" gap -- emitting a structured `ReserveTokensMinted`/`ReserveTokensRedeemed` event with the full asset-amount breakdown directly (rather than relying on indexers to correlate SPL Token transfer instructions within a transaction) is strictly better and cheap to do from day one, and is required by the mission's own indexing-architecture instructions. Everything else (basket-change events, fee-set events, role-change events, lifecycle events) is adopted conceptually with SSR's own terminology.

## 17. Testing architecture

**Folio:** 9,400+ lines of Foundry tests: large per-feature unit/integration suites (`test/Folio.t.sol` alone is 5,482 lines), dedicated allowlist/deployer/registry suites, **fork tests** against real deployed state for governance-proposal validation, and a distinctive **"Extreme" parametrized combinatorial stress harness** (not native fuzzing) sweeping decimals/amounts/rates/time to probe rounding-precision boundaries with `assertApproxEqAbs` tolerance checks. Concrete adversarial patterns worth replicating: dishonest bidder-callback under-delivery (balance-delta verification, not trusting a callback's return value), a "donating" attacker probing balance-delta-based accounting, a front-run race between admin basket-removal and an in-flight async settlement, and a reentrant mock ERC20 validating the reentrancy guard actually holds.

**Classification: Adopt conceptually.** The overall shape -- unit tests per calculation, integration tests per full flow, a dedicated adversarial suite, and an extreme-parameter sweep for rounding/precision -- maps directly onto the mission's own required test categories (unit/integration/adversarial/property). The specific adversarial scenarios adapt directly: "dishonest callback" → SSR's Jupiter-route validation (never trust a claimed output amount, verify actual balance deltas); "reentrant token" → SSR's CPI-based equivalent (validate that a malicious token program's transfer CPI can't corrupt Reserve state assumed-safe by the caller); "extreme decimal/amount sweep" → SSR's own rounding-direction verification across varying token decimals (6 for USDC-like, 9 for SOL-like, etc.).

## 18. Audit material

**Folio:** Five audit reports present (`audits/`) from Trust Security, Cantina, Pashov Audit Group, and two rounds from Trail of Bits (tracking the 2.0.0 → 4.0.0 architecture transition from repeatable pairwise auctions to basket-auctions-around-a-rebalance). PDF contents were not extracted in this pass (out of scope for the code-focused inspection); no inline "audit finding" code comments exist.

**Classification: Requires later production-security review.** Per mission instructions, a full security review is a Mainnet-readiness gate, not a first-DevNet-release requirement. Noted here as a concrete forward pointer: before any restricted beta, a targeted read of these five reports (especially the two Trail of Bits reports covering the exact basket/rebalance-limit redesign SSR is drawing conceptual lessons from in §9) is worth doing to see whether any finding maps to an SSR design choice.

## 19. EVM-specific mechanisms that do not map to Solana

Covered in depth by the underlying research pass; summarized:

| Mechanism | Why it doesn't transfer | What actually transfers |
|---|---|---|
| ERC1967 delegatecall proxy (implementation shared by many proxies) | No delegatecall/shared-bytecode-at-many-addresses concept on Solana; programs upgrade in place | The authority-gated-upgrade *concept* |
| `_disableInitializers()` on the logic contract | No "shared logic contract reachable at its own address" on Solana | The underlying concern: validate PDA seeds/discriminator/init-flag on every account |
| `nonReentrant` / reentrancy guards | EVM's arbitrary-external-call model differs fundamentally from Solana's CPI/ownership model | CPI-composability hazards are a live concern in a different shape -- needs its own model, not a port |
| Raw `assembly` storage-slot writes (`_setName` workaround) | Solidity/OZ namespaced-storage-slot-specific hack | N/A -- Anchor account structs make this a non-issue |
| Unbounded loop / gas-limit DoS risk | EVM gas-cost-per-opcode accounting is chain-specific | The general lesson (bound iteration over user-influenced-size collections) is directly relevant -- hence SSR's explicit Reserve Asset cap (§15) |
| `CREATE2` deterministic salted addresses | EVM-address-model-specific | Concept maps *well* -- Solana PDAs are arguably a more natural fit for "derive an address from a seed" than CREATE2 is |

## 20. Frontend independence

**Folio:** Not a focus of the Solidity repo itself (no frontend lives in this reference repo) -- but the mint/redeem contract interface is fully self-describing and callable directly against the chain with no off-chain dependency, which is the property that matters.

**Classification: Adopt conceptually.** SSR's mission requirement (a holder must be able to inspect state, derive vaults, calculate mint/redemption amounts, and redeem entirely through the SDK with the website/indexer unavailable) is a direct analogue of "you can call Folio's `mint`/`redeem` from any EVM tool with no Reserve-Protocol-operated service involved." This is a testable requirement for SSR's Gate 6/7 SDK work, not something Folio's code teaches a specific mechanism for.

## 21. Indexing

**Folio:** No first-party indexer/subgraph in this repo (a sibling `dtf-index-subgraph` repo exists in the org, not inspected here); on-chain events are the only indexing surface, and as noted in §16, mint/redeem specifically requires correlating multiple events rather than reading one purpose-built event.

**Classification: Adopt conceptually, improve on the gap** (see §16) -- SSR emits purpose-built structured events for every state-changing instruction so a Helius-or-similar indexer never needs cross-event correlation, and the on-chain program remains authoritative regardless of indexer availability (per mission instruction).

---

## Summary table

| # | Mechanism | Classification |
|---|---|---|
| 1 | Deployment model | Adapt |
| 2 | Factory model | Adopt |
| 3 | Asset custody / isolation | Adopt (concept) / Adapt (mechanism) |
| 4 | Mint | Adopt (concept) / Adapt (transfer model) |
| 5 | Redemption | Adopt |
| 6 | First-deposit behavior | Adapt + strengthen (permissionless creation needs a real minimum-seed invariant Folio doesn't need) |
| 7 | Basket accounting | Adapt (simplify for manual rebalancing) |
| 8 | Fees | Adopt (mechanism), defer (concrete values, ratchet) |
| 9 | Rebalancing/auctions | Defer (full auction system), adopt (role-separation shape) |
| 10 | Roles & permissions | Adopt |
| 11 | Governance separation | Reject for v1 (no DAO yet) |
| 12 | Pause/emergency | Adopt (concept: redemption stays live), adapt (make pause reversible) |
| 13 | Upgradeability | Adapt (Solana's native program-upgrade model replaces the proxy/registry system) |
| 14 | Valuation/rounding/dust | Adopt directly |
| 15 | Asset limits/validation | Adapt (SSR needs an explicit cap Folio doesn't) |
| 16 | Events | Adopt + improve (dedicated mint/redeem events) |
| 17 | Testing architecture | Adopt (shape and adversarial scenarios) |
| 18 | Audits | Defer to pre-beta/pre-mainnet review |
| 19 | EVM-specific mechanisms | Reject (see table above) |
| 20 | Frontend independence | Adopt (concept) |
| 21 | Indexing | Adopt + improve |

See `docs/project/DECISION_LOG.md` (DEC-0009 onward) for where these classifications became confirmed SSR architecture decisions, and `docs/protocol/SSR_ARCHITECTURE.md` / `docs/protocol/ACCOUNT_MODEL.md` for the resulting design.
