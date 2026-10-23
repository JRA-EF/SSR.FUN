# Redeem resume: an expired redeem signature no longer blocks every retry

- **Date:** 2026-10-23
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `fix/launch-stale-price` -> `main`
- **Deployed to:** production (ssr.fun)
- **Decision log:** none (bug fix)

## What happened
The Creator's ALPHA redeem on production failed with "A previous redeem transaction for this redemption could not be verified yet (signature ZiogMh...k4N)" on every retry. The chain has no record of that signature: the transaction expired before landing, nothing was burned. The sale's localStorage record (`ssr_pending_sells_v1`) kept the signature, and `getSignatureStatuses` answers null for an expired transaction forever, so the resume check could never pass.

## Fix
`src/merge/lib/multiAssetSellClient.ts`: the record now stores each submitted transaction's `lastValidBlockHeight` (redeem and each swap leg). On resume, a signature the chain does not know is "expired" once the current block height is past that height; the redeem signature is then dropped and the redeem rebuilt. Records saved before this change fall back to the sale's age (over 10 minutes = expired). The existing balance guard still detects a redeem that did land, so nothing is redeemed twice. Test: `tests/phase_sell_expired_signature.ts`.

## Effect on others
- Shared helper `resolveSubmittedSignature` / `unknownSignatureExpired` in `rpcResilience.ts`: use it whenever a flow resumes from a saved signature. Save the transaction's `lastValidBlockHeight` next to the signature when you persist one.
- `sendAndConfirmWithRebroadcast` now polls up to 100 times (was 40), so it outlasts any blockhash and normally ends confirmed / failed / expired instead of "unknown".

Follow-up 2026-10-23 (Creator: "make sure this doesnt happen, or the user is informed, or both"):
- Prevent: a redeem that expires unlanded (nothing moved; usually a slow wallet approval or a dropped transaction) is now rebuilt and re-signed once automatically, like the mint step already was. Its signature is dropped either way, so it can never block a retry.
- Resume: a saved signature still in flight is waited for (up to ~2 minutes) instead of stopping the flow; one past its expiry is treated as never landed. Applies to the redeem, its swaps, the mint, the mint's swaps and the /recover check. The mint path no longer resets a not-yet-found swap and buys it again while it may still land.
- Inform: if the network still does not include the redeem, the message says nothing was redeemed or moved and to press Redeem again; if Solana cannot answer in time, it says nothing new was submitted, to wait a minute, and that the earlier transaction is checked first and never repeated.
Test: `tests/phase_sell_expired_signature.ts` (9). Suite 1681 passing / 5 pre-existing failures.
