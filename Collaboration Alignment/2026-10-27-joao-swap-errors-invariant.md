# Swap errors named correctly, Invariant excluded, alert review outcomes

- **Date:** 2026-10-27
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `feat/command-center`, merged into `main`
- **Deployed to:** production `dpl_6DJAHy1dyuLYGQ7zuDcknKwUr4Vu`, staging `dpl_FUYdhLbNjpr93UWP23J7TmpNWUoX` (both 49b4a86)
- **Decision log:** DEC-0267

## What shipped
- **A failed swap in a mint or redeem is now described as Jupiter's error, not SSR's.** Before this, Jupiter's 6001 (slippage) showed as "SsrError::ZeroValue".
- **"Insufficient funds" inside a route is no longer called slippage.** The message now says a token transfer in the route came up short, and tells the user to report it if it repeats.
- **Invariant is excluded from Jupiter routes, alongside ZeroFi and Quantum.** A Reserve #61 test redeem failed 17 times inside an Invariant pool.
- **Reviewed ops alerts now carry an outcome.** `scripts/review_ops_alerts.mjs --ack <n> --outcome <fixed|false_positive|user_error|not_fixed> --note "..."`. The command center lists the outcomes, and `not_fixed` items stay on the watch list.

## Effect on others: READ THIS
- **When you ack an alert you must now pass `--outcome`.**
- **To route through Invariant again,** set JUPITER_EXCLUDE_DEXES. Leaving it unset keeps the default list.
- **The local branch `fix/keeper-accrual-drain` (586103d) was deleted.** It was an earlier draft of fd7cf21, deleted with the Creator's approval.

- **Follow-up 2026-10-27:** both 2026-10-26 alerts are marked `fixed`, with notes. The review queue is empty: 6 kinds reviewed (3 fixed, 3 false positive).
