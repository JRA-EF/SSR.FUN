# DEX liquidity (Yeh's stack) and the USDC mint fee live on Mainnet

- **Date:** 2026-10-13
- **Author:** Joao via Claude Code (Opus 5.5)
- **Branch / commits:** `feat/liquidity-launch` @ `9b79ec3` (merge of `origin/design` into main after `92752e4`/`9a30907`), fast-forwarded to `main` and `design`
- **Deployed to:** production (`dpl_DuEwrLA5uLXst9g6mTpLijgo7Zo7`); Mainnet program (slot 456501417, Squads #13); earlier the same day DEC-0238 alone (slot 456462760, Squads #10, `dpl_EH1XVeuPHXSjpqXkebfsj7Hi5Kqi`)
- **Decision log:** DEC-0238, DEC-0240 (design's DEC-0234 renumbered DEC-0239)

## What shipped
- Mint and seed fees are paid in USDC to the SSR Treasury and the Manager inside the mint transaction (DEC-0238, server co-signed quote).
- Yeh's DEX liquidity flow is live for every Manager: Manage Reserve > Liquidity can launch a Raydium CPMM pool, add/withdraw, collect earnings and lock tranches. Compound stays a preview.
- Creator's fee ruling (DEC-0240): 0.15% transfer fee everywhere; SSR-created pools pay SSR 0.05% from the creator-fee bucket; optional project Buy/Sell tax 0-2% set in the liquidity launch, 25% SSR / 75% project, no minimum. DEC-0232's 0.5% floor on mint/redeem was NOT adopted.

## Code touched
- `programs/ssr_protocol/src/{lib,errors}.rs`, `instructions/{liquidity_revenue,liquidity_lock}.rs` — liquidity instructions; fee_math/mint/seed/redeem kept as main.
- `packages/sdk/idl/*` — purely additive over the previous IDL (9 new instructions, errors 6071-6075).
- `lib/mainnet/poolPayer.ts` (new) — server co-sign by the Raydium-approved payer, only for a self-built pool launch that refunds the payer in full.
- `lib/mainnet/createLiquidity.ts` — creator refund of the payer (two-pass simulation); `lib/mainnet/prepareCompound.ts` — fee payer may gain lamports.
- `lib/mainnet/liquidityRelease.ts` (new) — `LIQUIDITY_EXECUTION_ENABLED=true`, `COMPOUND_EXECUTION_ENABLED=false`; used by `api/mainnet/{liquidity,liquidity-setup,liquidity-release,prepare-compound}.ts`.
- `CLAUDE.md`, `AGENTS.md`, `docs/protocol/{FEE_MODEL,TERMINOLOGY}.md` — fee rules per DEC-0240.
- `tests/phase_pool_payer.ts` (new); `phase_liquidity_revenue`, `phase_compound_snapshot`, `phase_reserve_deploy_resumability` expectations follow live fees and the new error numbers.

## Repositories / environments adjusted
- Squads: #10 (DEC-0238 upgrade), #11 (extend attempt — approved but can never execute: the loader refuses ExtendProgram via CPI; ignore it), #12 (returned 1.45 SOL from the vault to the deployer), #13 (upgrade from buffer `EJAHnaitsR8sUMHnFqWcvp3oMoSyRTrbeBjTEowpWrnt`).
- ProgramData extended to 1,383,608 B by a top-level ExtendProgram signed by the deployer (tx 5HmABshA…SAdAw). `ExtendProgramChecked` is not active on Mainnet.
- Vercel env (Production): `SSR_RAYDIUM_POOL_PAYER_SECRET` added (Sensitive). `JUPITER_API_KEY`, `HELIUS_MAINNET_RPC_URL`, `SSR_FEE_SETTLEMENT_KEEPER_SECRET` confirmed present.
- Pool payer `6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS` funded with 0.05 SOL for fees; each pool launch refunds its rent from the creator.

## Effect on others — READ THIS
- The runbook's funded Mainnet lifecycle, Jupiter 1/5/10 quote matrix and browser multi-sign checks (steps 5-7) were NOT run before release — the Creator chose to enable immediately. The first real pool launch is the first end-to-end Mainnet run.
- New liquidity errors are 6071-6075 (not design's 6068-6072).
- Don't re-add DEC-0232's mint/redeem floor or a tax field in Create Reserve.
- Gaps: Compound execution; `lib/ledger/query.ts` daily totals exclude USDC mint fees; no indexing yet for `LiquidityRevenueDistributed` / `ProjectTaxCharged` events.

## Verification
- Mainnet programdata sha256 `88bce6d0…6466` == local build; slot 456501417; authority still the Squads vault.
- Post-upgrade read-only simulation: USDC-fee mint on Reserve #0 succeeds (60,813 CU); pool-creation builder reads Token-2022 Reserve #39 and refuses only on the Manager treasury's missing USDC.
- Rust 33/33; `tsc -b` and the Mainnet API type check clean; offline suite 1,515 passing with the 4 known failures; ssr.fun still serves Coming Soon + BETA gate, APIs 401 without a session.
