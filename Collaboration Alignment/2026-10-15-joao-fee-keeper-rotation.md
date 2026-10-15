# Fee keeper rotated so staging can launch and mint

- **Date:** 2026-10-15
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** docs only (no code change)
- **Deployed to:** production ssr.fun dpl_5YTM8YUKnPSeRzwoAyR9e5rqh1zx (redeploy of main 7b48dc1 code with the new key); staging strategic-super-reserve.fun dpl_nZJqLWEDvrLWWDz1iKwnWC7bmU8j (redeploy of the same release/2026-10-15 + 2259908 code as before, new secrets only)
- **Decision log:** DEC-0248

## Why
On staging, Launch (Resume, step 2/2 Seeding) failed with "Launching is temporarily unavailable: the USDC mint-fee signer is not configured on this deployment." Since DEC-0238, every seed and mint needs the server to co-sign the USDC fee with `SettlementKeeperConfig.keeper`. That key (…GPhsF) existed only as a Sensitive variable on ssr-fun, which Vercel cannot read back. ssr-fun-staging never had it, and it also lacked the Raydium pool payer.

## What changed
- New keeper wallet `6adZbFYM83jKSK4fjy7QbSCA8vRLCosBh6m8DoFBqDVN` (…FBqDVN), funded 0.05 SOL from …4Rw8. Its secret is in `SSR_FEE_SETTLEMENT_KEEPER_SECRET` (Sensitive) on BOTH ssr-fun and ssr-fun-staging, with a local copy on Joao's machine.
- On-chain: `set_fee_settlement_keeper` signed by Protocol Admin …4Rw8, run right after the production redeploy went live, which kept the mismatch window to seconds.
- ssr-fun-staging: `SSR_RAYDIUM_POOL_PAYER_SECRET` added (same …CFoqAS key as production) so pool launches work there.

## Effect on others — READ THIS
- Old keeper …GPhsF is retired. Its 0.383 SOL is stranded, because nothing holds its secret any more.
- Staging has no `CRON_SECRET`, so its fee-settlement cron still stops before loading the key. Only production settles fees.
- Anyone who can read ssr-fun-staging's env can now sign fee quotes. The Creator accepted this trade-off.
- Do not remove or overwrite these variables. Any redeploy of either project picks up the new key.

## Verification
- On-chain keeper now reads …FBqDVN.
- A server-built USDC-fee mint for Reserve …spB3Zs (wallet …4Rw8), co-signed with the new key, simulated on Mainnet: err null, 93,746 CU.
- ssr.fun and strategic-super-reserve.fun aliased to the new deployments.
