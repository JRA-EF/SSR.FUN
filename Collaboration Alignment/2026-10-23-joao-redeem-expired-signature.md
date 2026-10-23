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
The mint path (`multiAssetBuyClient.ts`) and `incompleteTransactions.ts` have the same "unknown forever" shape for swap signatures; not changed here.
