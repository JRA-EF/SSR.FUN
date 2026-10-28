# Open tabs no longer drain Helius: no background polling

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** production (pending: waiting for the DEC-0270 keeper deploy to be verified first)
- **Decision log:** none (Creator directive in chat: "we can't have open tabs continuously drain rpc calls")

## What shipped
- **An open ssr.fun tab sends nothing to Helius while it sits there.** Reserve data, co-manager checks, wallet token balances and the SOL balance are read:
  - on load, and when a wallet connects or switches;
  - after the user's own mint, redeem or launch finishes;
  - once when the user comes back to a tab that was hidden for 5+ minutes.
- **Why:** `/api/mainnet/rpc-proxy` handled ~590,000 calls on 2026-10-27, ~95% from one forgotten tab on the dev PC (IP 148.63.223.141, ~38,000 calls an hour, day and night since 2026-10-27 20:00). Every tab re-read all 37 Reserves every 30 s (co-manager checks are one `getAccountInfo` per candidate wallet), the SOL balance every 20 s, and the known-mint list every 3 min. A new mint-list array also restarted a full chain pass.
- **Measured locally** (mainnet dev build, a counting relay in front of Helius, headless Chrome for 150 virtual seconds): 885 calls before, still climbing; 253 after, all in the first 9 s, then none.

## Code touched
- `src/merge/lib/RealReserveSync.tsx`: no poll timer. Triggers are load or input change, txInFlight true->false, and returning to the tab after 5 min. A failed pass retries up to 3 times (5 s, 10 s, 20 s), then waits for the next trigger.
- `src/merge/lib/WalletSync.tsx`: no 20 s balance timer; same triggers.
- `src/merge/hooks/useMainnetKnownAssetMints.ts`: no 3 min refetch. It refetches on return after 5 min, and keeps the same array when the list is unchanged.
- `tests/phase_no_background_rpc.ts` (new): pins all of the above.

## Effect on others: READ THIS
- **Do not add `setInterval` or self-rescheduling RPC reads to the app.** Refresh on a user action or on returning to the tab. The new test fails on a timer in these files.
- `nextPollDelay` in rpcResilience.ts is no longer used by the app (its tests still pass); left in place.
- Still worth doing: a load pass is ~250 calls, mostly unbatched co-manager checks (`discoverDelegatesForReserve`). Batching them into `getMultipleAccounts` would cut that to a handful.

## Verification
- `tsc -p tsconfig.app.json` clean, oxlint clean, full offline suite 1,754 passing with the 5 known baseline failures (chart selector x2, native-control reset x2, deployed-binary pinning).
