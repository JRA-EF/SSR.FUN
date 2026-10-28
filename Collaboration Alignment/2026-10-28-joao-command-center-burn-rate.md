# Command center: monthly burn rate in USDC

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** production (deploy id in the follow-up line once live)
- **Decision log:** none (internal page; the keeper change only stores a balance sample)

## What shipped
- **A "Burn rate … USDC / month" pill sits next to "Protocol wallets" on /internal/commandcenter.** Clicking it drops down the breakdown; each line opens its card.
- **Subscriptions:** the cost typed on each card ("$25/month", "$300/yr", "free") as USD per month. Vercel is live from its billing API: this cycle's spend projected to the whole cycle, with the top services listed.
- **On-chain fees:** the SOL the fee keeper and the pool payer actually spend, from hourly balance samples, priced at the current SOL price, with the keeper's runway in days. Only balance drops count, so a top-up is not negative spend. Shows "measuring" until six hours of samples exist.
- **"Not in the total yet"** lists services with no cost entered (Helius, Neon, GitHub, both domains at launch). Type the cost on each card to include it. Telegram and the Sheet count as free unless a cost is typed.
- First reading (local run on production data): 121.89 USDC/month = Vercel on pace for $96.89 (Observability Events $24.13 is the biggest line) + Jupiter $25.

## Code touched
- `lib/command-center/model.ts`: `BurnRate` types, `parseMonthlyCost`, `projectToMonth`, `solBurnPerDay` (pure).
- `lib/command-center/balances.ts` (new, no imports): the `command_center_balances` table, `recordSolSample` (at most one sample per wallet per 50 min, 90-day prune), `readSolSamples`.
- `lib/command-center/probes.ts`: `burnRate()` builds the breakdown; `valueWallets` now also returns the SOL price.
- `api/mainnet/fee-settlement-cron.ts`: one guarded line records the keeper's balance each hourly run. It runs after the alert checks, and any failure is swallowed, so settlement can never be blocked by it.
- `public/internal-commandcenter.html`: the pill and the dropdown.
- `tests/phase_command_center_burn.ts` (new): cost parsing, projection, drop-only SOL burn, and that the keeper sample is guarded.

## Repositories / environments adjusted
- Neon: new table `command_center_balances` (created on first use).

## Effect on others: READ THIS
- If you add a paid service to the command center, add its node id to `SUBSCRIPTION_NODES` in probes.ts.
- The fee figure is a measurement, not an estimate: a top-up between two samples hides that interval's spending.

## Verification
- `tests/phase_command_center.ts`, `phase_command_center_burn.ts`, `phase_ops_alerts.ts`: 20 passing. `tsc -p tsconfig.node.json` clean, oxlint clean.
- Local run of `collectCommandCenter` against production data, and headless-Chrome screenshots of the open dropdown at 1440 px and 600 px.
