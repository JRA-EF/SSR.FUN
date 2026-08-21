# USDC Fee-Settlement Runbook

Operational procedure for the USDC fee-settlement pipeline (2026-08-21 pass, see `docs/project/DECISION_LOG.md`'s entry for this pass for the full design, fee math, security analysis, and deployment plan). This runbook covers the steps AFTER Creator has explicitly approved the Mainnet program upgrade -- it is not itself an approval, and none of these steps should be run against Mainnet until that separate, explicit approval has been given.

## 0. Prerequisites

- Program upgrade deployed (`programs/ssr_protocol` rebuilt via `cargo-build-sbf`, upgraded on Mainnet at `8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9` using Creator's existing upgrade-authority wallet).
- `packages/sdk/idl/ssr_protocol.json`/`.ts` regenerated and matching the upgraded program (this pass already did this locally -- re-verify post-upgrade against the live program if there's any doubt).
- A dedicated keeper wallet generated (a fresh keypair, NOT Creator's own wallet, NOT any existing DevNet/Mainnet authority key) and funded with a small amount of SOL for transaction fees only. This wallet is never a fund-custody role -- see `SECURITY_INVARIANTS.md`'s invariant 20.

## 1. Configure the keeper on-chain

Call `set_fee_settlement_keeper` (Protocol Admin only, either `authority` or `admin_2`) with the keeper wallet's public key. This lazily creates `SettlementKeeperConfig` (a separate, protocol-wide singleton PDA -- see `ACCOUNT_MODEL.md`).

## 2. Configure the keeper secret on the deployment

Set `SSR_FEE_SETTLEMENT_KEEPER_SECRET` (base58 string or a JSON array of the keypair's secret-key bytes -- same convention as every other server-held keypair in this app) on the Vercel Production environment. `api/mainnet/fee-settlement-cron.ts` refuses to proceed (non-dry-run) if this doesn't match `SettlementKeeperConfig.keeper` exactly.

## 3. Dry run

`GET /api/mainnet/fee-settlement-cron?dryRun=true` -- no `CRON_SECRET` required, submits nothing. Reports every Reserve with a nonzero fee-vault balance or pending-settlement amount. Confirm the numbers look sane (a Reserve you know has had real Buy/mint activity should show a nonzero `feeSettlement.protocolSharesInVault`/`managerSharesInVault`) before proceeding.

## 4. First real run -- ONE Reserve, manually verified

Do NOT invoke the endpoint's real (non-dry-run) path yet if it would touch every discovered Reserve at once. Instead, for the first live verification:

1. Pick one real Reserve with a small pending fee balance (confirmed via the dry run above).
2. Manually build and submit just that Reserve's `redeemFeeVaultShares` instruction (via a one-off script, `buildRedeemFeeVaultSharesInstruction` from `@ssr/sdk`) using the keeper wallet.
3. Confirm on Explorer/Solscan that the fee vault's balance decreased and the expected per-asset staging ATA(s) now hold the entitlement.
4. Manually approve + swap ONE staged asset (`buildApproveSettlementSwapInstruction`, then a real Jupiter quote+swap signed by the keeper) -- confirm the staging ATA's balance decreased and the USDC staging ATA's balance increased by a sane amount (matching the quote, within slippage).
5. Manually call `distributeFeeUsdc` (`buildDistributeFeeUsdcInstruction`) -- confirm the Protocol Treasury's USDC balance and the Reserve's configured Manager recipient(s)' USDC balance both increased by the expected split.

Only once this full cycle has been verified end to end, with real signatures checked on-chain, should the automated endpoint be trusted for other Reserves.

## 5. Enable the automated keeper (optional, once step 4 is verified)

`api/mainnet/fee-settlement-cron.ts` is deployed but deliberately **NOT** added to `vercel.json`'s `crons` list by this pass. To enable a schedule:

1. Add an entry to `vercel.json`'s `crons` array pointing at `/api/mainnet/fee-settlement-cron` (a real `CRON_SECRET`-authenticated Vercel trigger, matching `api/devnet/accrue-fees-cron.ts`'s existing precedent).
2. Choose a cadence that matches "let small fees accumulate until conversion is economically worthwhile" (requirement 7) -- e.g. weekly, matching the existing TVL-accrual keeper's schedule, rather than per-transaction.
3. Monitor the first several scheduled runs' JSON responses (`results[].assets[].status`) for `skipped-price-impact`/`skipped-no-route`/`skipped-error` entries -- these are expected occasionally (a thin-liquidity asset, a temporary Jupiter outage) and self-heal on the next run, but a PERSISTENT skip for the same asset across many runs is worth investigating manually.

## 6. Ongoing operation notes

- Every step is independently idempotent and safe to retry (see `SECURITY_INVARIANTS.md` invariants 22-23) -- there is no scenario where re-running this endpoint after a partial failure double-charges anyone or loses a staged asset.
- The keeper wallet's own SOL balance should be monitored and topped up periodically (transaction fees only -- it never needs more than a small operating balance).
- If the keeper wallet is ever compromised, the fix is `set_fee_settlement_keeper` to a new wallet -- no Reserve funds are ever at risk beyond whatever is currently staged for one asset at that moment (see `SECURITY_INVARIANTS.md` invariant 20).
