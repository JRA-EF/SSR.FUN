<!--
  Frontend integration plan for SSR Protocol. Includes the Phase-1
  "implementation map" (frontend action -> on-chain instruction) required by
  the mission, plus the Gate 10 replacement-order plan. Nothing in this
  document has been built into the frontend yet -- Gate 10 has not started
  (blocked behind Gates 7-9, which are blocked behind the toolchain gap, see
  DEVNET_RUNBOOK.md).
-->

# Frontend Integration

## Read this first: the economic-model reconciliation

See `docs/protocol/SSR_ARCHITECTURE.md` section 0 and `DECISION_LOG.md`
DEC-0009. The existing frontend's only reachable mint/redeem-shaped UI is
the AMM Buy/Sell tab on `DTRDetail.tsx`, which does **not** match the
on-chain program built here (oracle-free proportional in-kind mint/redeem).
Two consequences for this integration plan:

1. Items 7-8 below (proportional minting/redemption) require **new frontend
   UI that does not exist yet** -- not a re-skin of the existing Buy/Sell
   tabs, which model a fundamentally different mechanism (a bonding-curve
   swap, not a basket deposit/withdrawal).
2. The existing AMM Buy/Sell UI is **not being removed or replaced** by this
   plan. It's reclassified as the "optional swap-router entry and exit"
   concern, explicitly last (item 14) in the mission's own replacement
   order, and can eventually be rebuilt against a real router (e.g. Jupiter)
   without touching the core protocol this document integrates against.

## Data-source boundary (mock vs. DevNet mode)

Not yet implemented. Planned shape: a single context/store flag (e.g.
`dataSource: 'mock' | 'devnet'`) read by both `src/data`/`src/state` (native,
currently entirely mock) and `src/merge/store/useAppStore.ts` (currently the
only reachable store). In DevNet mode, store actions that currently mutate
local/localStorage state directly instead call the SDK
(`packages/sdk`) to build and send a real transaction, then refetch on-chain
state to update the store. Mock mode remains the default and the fallback
during integration, per mission instruction ("do not remove mock mode until
the corresponding live flow works").

## Implementation map (Phase 1 deliverable)

Every simulated frontend action, and the real on-chain instruction it must
eventually become. "Frontend today" reflects the Gate 1 inspection findings
(see RESERVE_REFERENCE_ANALYSIS.md and the conversation's Gate 1 Explore
report) -- most of these actions are currently either AMM-shaped (not
matching the target instruction) or entirely absent from any reachable UI.

| Frontend action | Frontend today | Required instruction | Signer | Token movement | Event | Pending/confirm UI | Failure/recovery |
|---|---|---|---|---|---|---|---|
| Connect wallet | 100% simulated (`WalletModal.tsx`, fake delay + random address, even with a real wallet extension detected) | none (client-side only; real wallet adapter connection is a wallet-standard concern, not a program instruction) | user wallet | none | none | connecting → connected/failed (already exists, just fake) | already has not-installed/failed paths, just needs real `window.solana.connect()` wiring |
| Select network (mock/DevNet) | doesn't exist | none | n/a | none | none | new: a network/mode switcher | n/a |
| Reserve discovery (`Discover.tsx`) | reads `useAppStore.dtrs` (seeded + user-created, local only) | `getProgramAccounts` scan of `Reserve` accounts (or an off-chain indexer once one exists) via SDK | none (read-only) | none | n/a | list/loading/empty states already exist | fall back to mock catalog if RPC fails |
| Reserve detail (`DTRDetail.tsx`) | reads a `DTR` object from the store | fetch `Reserve` + all `ReserveAsset` + vault balances + `reserve_token_mint.supply` via SDK | none (read-only) | none | n/a | loading/error states needed (don't exist yet) | fall back to mock if account not found |
| Reserve creation (`CreateDTR.tsx` "Launch Reserve") | `createDTR()`, instant local mutation | `create_reserve` (+ manager keeps signing) | manager (creator) | none | `ReserveCreated` | needs: per-step tx submission, not one instant local write | if a later step fails, `Reserve.status` visibly shows partial creation (see SECURITY_INVARIANTS.md) |
| Composition step | client-side asset picker against a 14-asset hardcoded list | `initialize_reserve_asset` × N (one per asset) | manager | none | `ReserveAssetInitialized` | needs a per-asset tx progress indicator | a failed asset registration doesn't corrupt the Reserve -- can retry that one call |
| Initial seed / "Initial Liquidity" step | deducts `initialSeedUsdc` from mock wallet, sets `nav=10` | `seed_reserve` | manager | manager → vaults (all assets), mint → manager | `ReserveSeeded` | needs a single combined-transaction (or sequenced) confirmation UI | if it fails, Reserve stays `AssetsInitializing` (not `Active`) -- redeemable/mintable actions correctly stay blocked |
| Proportional mint | **does not exist in reachable UI** (only AMM "Buy" exists) | `mint_reserve_tokens_in_kind` | depositor | depositor → vaults, mint → depositor | `ReserveTokensMinted` | new UI entirely | slippage bounds computed via SDK `computeMintRequirements` |
| Proportional redeem | **does not exist in reachable UI** (only AMM "Sell" exists) | `redeem_reserve_tokens_in_kind` | redeemer | vaults → redeemer, burn | `ReserveTokensRedeemed` | new UI entirely | works even if `Reserve.status == Paused` |
| Portfolio (`Portfolio.tsx`) | reads store `holdings` + wallet balances | fetch redeemer's Reserve Token ATA balances across known Reserves (no cross-Reserve indexer query exists yet -- needs either a known-Reserve list or a getProgramAccounts scan) | none (read-only) | none | n/a | needs loading states | fall back to mock holdings |
| Manager: update targets (`ManageDTR.tsx` Rebalance tab) | `rebalanceDTR()`, instant local mutation, "Adjust Remaining" toggle | `update_targets` | manager/delegate w/ `UPDATE_TARGETS` | none | `TargetsUpdated` | needs tx confirmation UI | n/a, no tokens moved |
| Manager: record rebalance outcome | doesn't exist (no concept of "actually trading" in the UI at all) | `record_rebalance` | manager/delegate w/ `EXECUTE_REBALANCE` | none (attestation only -- actual trade execution is out of scope, DEC-0017) | `RebalanceRecorded` | new UI: "I traded manually, record the outcome" | n/a |
| Delegate management (`ManageDTR.tsx` Delegates tab) | `addDelegate`/`updateDelegatePermissions`/`removeDelegate`, instant local mutation | `add_delegate` / `update_delegate_permissions` / `remove_delegate` | manager (or delegate for restricted-only actions) | none (rent reclaim on remove) | `DelegateAdded`/`DelegatePermissionsUpdated`/`DelegateRemoved` | needs tx confirmation per action | n/a |
| Pause / unpause | **doesn't exist anywhere in the UI** despite permission fields existing on both domain models | `pause_reserve` / `unpause_reserve` | manager/delegate w/ the matching flag | none | `ReservePaused`/`ReserveUnpaused` | new UI entirely | redemption must visibly remain available while paused (mission requirement) |
| Transaction history | `DTR.trades` (real, session-only, AMM trades) | on-chain event log via indexer, or direct `getSignaturesForAddress`/log parsing via SDK | none (read-only) | none | n/a | needs a real fetch-and-render path | fall back to session-only mock trades |
| Pricing / performance data | fully synthetic random walks | Pyth (or another oracle) for display-only USD NAV; core mint/redeem never depends on this | none (read-only) | none | n/a | needs explicit "unpriced" state handling (mission requirement) | never block mint/redeem on missing price data |
| Swap-router entry/exit (existing AMM Buy/Sell) | fully reachable today, fake constant-product curve | a real router (Jupiter) CPI'd from outside the core accounting, OR left as-is as a clearly-labeled separate secondary-market feature | user | via router, validated per mission's Single-Asset Entry section | n/a yet | already exists | explicitly last in the replacement order; not required for "functional DevNet" per the acceptance criteria |

## Every wallet action must show (mission requirement, not yet built for any of the above)

Human-readable action summary; assets entering/leaving; expected Reserve
Token change; fees; required signer; simulation result where available;
wallet-approval/submitted/confirmed/failure state; explorer link; retry/
recovery guidance. None of the existing AMM Buy/Sell UI's confirmation flow
has been audited against this checklist yet -- do so before reusing any of
its components for the new mint/redeem UI.

## Replacement order (mission's own list, restated as the tracked plan)

1. wallet connection
2. network selection
3. Reserve discovery
4. Reserve state
5. Reserve creation
6. initial seeding
7. proportional minting
8. proportional redemption
9. Reserve Manager target updates
10. delegate management
11. pause controls
12. transaction history
13. pricing and performance data
14. optional swap-router entry and exit (existing AMM UI, last)

**Status: not started.** Blocked behind Gates 7-9 (no compiled program, no
deployed program, no generated IDL to build a typed frontend client against)
-- see DEVNET_RUNBOOK.md.
