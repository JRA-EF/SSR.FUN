# GitHub branch cleanup

- **Date:** 2026-10-27
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** none (repository housekeeping)
- **Deployed to:** nothing; GitHub refs only. Prod deploys from `main` and is unaffected.

## What shipped
- **Deleted 64 GitHub branches; 16 are left.** Every deleted branch was either fully merged into `main` or one of 7 the Creator approved:
  - 2 already in main;
  - the co-manager fix carried into main in DEC-0230, plus its duplicate;
  - 3 that have exact copies in the `SSR.FUN-BACKUP` repo.
- **Checkpoint and release branches became tags under `archive/`,** e.g. `archive/mainnet-deployed-baseline`. So did the three commits that had no other copy.
- **Kept:**
  - `main`, `design`, `staging`, `staging-eth`, `roadmap-staging`;
  - `fix/rpc-coldload-burst` (unmerged fix);
  - the 6 multichain branches (`base`, `bnb`, `ethereum`, `ethmainnet`, `evm-chain-reference`, `feat/multichain-phase0`, all contained in `staging-eth`, pending their author's OK);
  - `feat/ops-alerts`, `feat/trade-tax-transfer-fee`, `feat/user-feedback` (pushed in the last 3 days).
- **Local clone:** stale local branches were removed. Branches checked out in a worktree, or with unmerged work, were kept.

## Effect on others: READ THIS
- **To restore a branch,** run `git push origin <sha>:refs/heads/<name>` with the sha from the list below. A branch marked "merged" is also in main's history.

| action | branch | sha | why |
|---|---|---|---|
| delete | `fix/tier-b-settlement-reconcile` | dcec9d433c | listed-safe |
| delete | `hotfix-mint-alt-cors` | a06aadd04e | listed-safe |
| delete | `hotfix/delegate-escalation-deployable` | 9111fd04a7 | listed-safe |
| delete | `release/mainnet-delegate-hotfix-2026-09-03` | 9111fd04a7 | listed-safe |
| delete | `dec-0173-usdc-fees` | 50977eac0e | listed-safe |
| delete | `experimental/devnet-amm-swap` | d6d1979f16 | listed-safe |
| delete | `main-old-backup` | 689ffe9838 | listed-safe |
| delete | `admin-page-actions` | f078ca4aa5 | merged |
| delete | `agent-feedback-in-repo` | bb90f5a49a | merged |
| delete | `fable-functional-port` | 2c3786d486 | merged |
| delete | `feat/buy-signall-swap-batch` | f8110c9328 | merged |
| delete | `feat/client-rpc-coalescing` | 42be026a12 | merged |
| delete | `feat/command-center` | 7592343ee8 | mine-merged |
| delete | `feat/create-preflight` | e575dd5ff6 | merged |
| delete | `feat/evm-create-parity` | 435ca01705 | merged |
| delete | `feat/holder-pool-split` | 15e59c8394 | merged |
| delete | `feat/liquidity-launch` | f4e8a72309 | merged |
| delete | `feat/lp-fee-basket` | dd7f9124f5 | merged |
| delete | `feat/native-sol-ux` | 8314b45e7a | merged |
| delete | `feat/profanity-filter` | 4d1ec47cc6 | merged |
| delete | `feat/rebalance-execution` | 9498d04b77 | merged |
| delete | `feat/token2022-transfer-fee` | 655c0e5eef | merged |
| delete | `feature/liquidity-arch` | 808b835744 | merged |
| delete | `feature/raydium-permissioned-cpmm` | 67dc87492e | merged |
| delete | `feature/road-to-mainnet` | 41b503d5aa | merged |
| delete | `feedback-botid` | 07e6fdac96 | merged |
| delete | `fees-trade-tax` | 33693ff7a8 | merged |
| delete | `fix/account-locks` | 558320dda8 | merged |
| delete | `fix/durable-rate-limit` | 438de4214b | merged |
| delete | `fix/empty-reserve-discoverable` | 7b48dc1097 | merged |
| delete | `fix/hide-one-approval-ui` | 5a9d5f4f77 | merged |
| delete | `fix/launch-nav-parity` | e284101046 | merged |
| delete | `fix/launch-token2022-metadata` | 550b4661f6 | merged |
| delete | `fix/liquidity-manage-tab` | 63b42c4b33 | merged |
| delete | `fix/liquidity-ui-polish` | ded4f84aca | merged |
| delete | `fix/metamask-off` | 11b3fa6609 | merged |
| delete | `fix/metamask-solana` | fe77c9775a | merged |
| delete | `fix/pubkey-env-guard` | 6adc8b9623 | merged |
| delete | `fix/rate-limit-commonjs-scope` | b8d7d9520a | merged |
| delete | `fix/rate-limit-tsconfig-exclude` | 6d0632578c | merged |
| delete | `fix/rpc-cache-and-legacy-reserve` | f5407255f6 | merged |
| delete | `fix/rpc-client-rate-limit` | 416a2ab4ca | merged |
| delete | `fix/tier-b-settlement-reconcile-rebased` | 1a8e714565 | merged |
| delete | `fix/trade-tax-min-guard` | 2662c958d7 | mine-merged |
| delete | `fix/usdc-mint-fee` | 9a309072c9 | merged |
| delete | `fix/wallet-logos` | b1aa3f90c0 | merged |
| delete | `fix/xstocks-nav` | 415dd1b4b6 | merged |
| delete | `integrate/design-2026-09-02` | ee6edc8bc0 | merged |
| delete | `integrate/legal-2026-09-02` | bf54c35094 | merged |
| delete | `liquidity-design` | 829a4d18f4 | merged |
| tag | `main-backup` | 2831e59cab | checkpoint |
| tag | `main-devnet-checkpoint-2026-08-17` | f443346c26 | checkpoint |
| tag | `main-pre-developer-access-checkpoint-2026-08-28` | f09eda9c52 | checkpoint |
| tag | `main-pre-mainnet-checkpoint-2026-08-17` | 1d21ae3099 | checkpoint |
| tag | `mainnet-deployed-baseline` | cc84b422d9 | checkpoint |
| tag | `protocol/devnet-v1` | 4e5da9aeab | checkpoint |
| delete | `qa-sept11` | d04a82eed9 | merged |
| tag | `release/2026-10-15` | 5e2ee8a8b9 | checkpoint |
| delete | `server-built-buy` | 6b1092a5ad | merged |
| delete | `terminology/mint-redeem-buy-sell` | 5bc1bf536e | merged |
| delete | `tier-b-client-cutover` | ca3ae970a4 | merged |
| delete | `tier-b-plus-warmcache` | 6b1092a5ad | merged |
| delete | `warm-cache-homepage` | 384b0f0a07 | merged |
| delete | `wip/incomplete-tx-recovery` | db968826e7 | merged |
