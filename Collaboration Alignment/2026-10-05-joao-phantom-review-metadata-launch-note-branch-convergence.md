# Phantom review fixes (DEC-0226) + production branch convergence, merged into `design`

- **Date:** 2026-10-05
- **Author:** Joao via Claude Code (Claude Fable 5.1)
- **Branch / commits:** `main` @ `15e9057` (d67987f feature, 76c9b29 renumber, 0404f46 merge of `feat/evm-create-parity` into `main`, 15e9057 status); `feat/evm-create-parity` fast-forwarded to the same commits; this merge brings `main` into `design`
- **Deployed to:** production (`dpl_8468pRhTTSd4GMdbMAnErPaRnrDa` = `main` @ `0404f46`, promoted to ssr.fun)
- **Decision log:** DEC-0226

## What shipped
- Every Mainnet build now bundles the Reserve Token's on-chain name/symbol (Metaplex) into the launch batch, and the launch flow re-checks the account afterwards, publishing it with one more approval if it is missing. Phantom showed "Unknown" for three Reserves launched from a build whose `VITE_TOKEN_METADATA_LIVE` was unset (the env var exists only on Production).
- The launch success message now says the Reserve may take a few minutes to appear everywhere and that funds are safe on-chain.
- The moment a Mainnet Reserve launches, the client asks the warm-cache cron (`?trigger=reserve-created`, unauthenticated like `?dryRun=true`) to rebuild the Discover snapshot instead of waiting up to 10 minutes.
- A Buy or Sell that cannot fit one transaction now explains, before the wallet prompt, why Phantom previews each swap as USDC-out/asset-in and what the trader ends up holding.
- `main` and `feat/evm-create-parity` are converged: production had been running the feature branch (DEC-0219/0220/0221/0225) while `main` carried the README, the Helius-key redaction and this work. Deploy production from `main` only from now on.

## Code touched
- `src/merge/lib/solana-config.ts` — `TOKEN_METADATA_LIVE = IS_MAINNET || flag`
- `src/merge/lib/tokenMetadataAfterLaunch.ts`, `tokenMetadataAfterLaunchOnChain.ts` — post-launch metadata check/publish (pure + wiring)
- `src/merge/lib/walletPromptCopy.ts` — batch wallet-prompt copy, `RESERVE_VISIBILITY_NOTE`
- `src/merge/pages/CreateDTR.tsx` — metadata check, snapshot refresh, success-message note; `finalizeResumedReserve` is async now
- `src/merge/lib/multiAssetBuyClient.ts`, `multiAssetSellClient.ts`, `src/merge/pages/DTRDetail.tsx` — new progress phase `signing-batch`
- `src/merge/lib/reserveSnapshotClient.ts`, `lib/reserve-warm-cache/manualRefresh.ts`, `api/mainnet/warm-cache-cron.ts`, `api/mainnet/reserves-snapshot.ts` — launch-time snapshot refresh
- `tests/phase_launch_visibility_and_wallet_prompt.ts` — 12 offline tests

## Repositories / environments adjusted
- SSR.FUN: `origin/main`, `origin/feat/evm-create-parity` (now equal), `origin/design` (this merge)
- Vercel `ssr-fun`: production deploy + promote (a rollback earlier the same day pinned the domains, so the next deploy needed `vercel promote`)
- No env, Neon, Squads or key changes

## Effect on others — READ THIS
- **Deploy production from `main`.** Two production branches caused a 3-minute regression today (an `origin/main`-only deploy briefly reverted the Buffer polyfill, the keeper fix and DEC-0225); rolled back, converged, redeployed.
- **DEC ids:** 0217/0218 (Liquidity, this branch), 0219-0225 (evm branch), 0226 (this). Next free: **DEC-0227**.
- **Three Mainnet Reserve Tokens still lack metadata** and will show as "Unknown" in wallets until their Managers press "Publish to wallets and exchanges" on Manage Reserve: #26 SOLTEN (Manager `52b7pBNF…`, the Developer wallet), #27 TEST and #30 EERQR (Manager `6BjTPAWG…`). The deployer/Protocol Admin key cannot do it (`create_token_metadata` is Manager/co-manager only; error 6032).
- The wallet's own Buy preview for multi-asset Reserves cannot be changed from the app; a true "-USDC +Reserve Token" preview needs the USDC-at-mint program change (Decisions Required).
- Vercel's build log prints TS errors from `api/feedback/board.ts` on every deploy; pre-existing since 5cace6b, non-fatal.
- The repo is public: nothing with `api-key=` or a full RPC URL in tracked files.

## Verification
- `tsc -b` and `tsc --noEmit -p tsconfig.app.json` exit 0 on the merged `main`; `vite build` OK; offline suite 1289 passing / 5 pre-existing failures.
- Live: `POST https://ssr.fun/api/mainnet/warm-cache-cron?trigger=reserve-created` → `ok:true, trigger:"reserve-created"`; `assets/main-U3tSjTEC.js` contains `signing-batch`, the visibility note and the trigger; `/assets/polyfill-buffer.js` → 200.
- This `design` merge: only `docs/project/DECISION_LOG.md` and `PROJECT_STATUS.md` conflicted (both sides kept, main's production record first); code auto-merged. Not typechecked in this worktree (no node_modules here).

- **Follow-up (2026-10-05, evening):** DEC-0227 -- a batch Buy of a Reserve holding xStocks (Token-2022) refused to mint after every swap landed because the page read wallet balances through the classic token-account address. `fetchTokenBalanceRaw` now resolves (and memoises per session) the mint's token program; Buy/Sell legs and every Reserve Token / USDC read pass the program explicitly (Helius is at its request cap -- no new per-call reads). Production `dpl_8KNfcipLFX39Usd6NW6QmwghuzgV` = `main` @ `a072a22` (+ status 435ca01). Next free DEC id: DEC-0228.
