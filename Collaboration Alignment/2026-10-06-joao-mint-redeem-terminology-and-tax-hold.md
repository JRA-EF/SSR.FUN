# Mint / Redeem terminology made mandatory; Buy/Sell tax on hold

- **Date:** 2026-10-06
- **Author:** Joao via Claude Code (Claude Opus 5.5)
- **Branch / commits:** `main` @ `5bc1bf5`; merged into `design` in this commit
- **Deployed to:** none yet. Production deploy of `main` @ `5bc1bf5` is pending (run from a worktree linked to `ssr-fun`: `npx vercel deploy --prod --yes`)
- **Decision log:** DEC-0228

## What shipped
Mint and Redeem are now the only words for the in-app flow: getting Reserve Tokens from SSR.fun is a mint, handing them back is a redemption. Buy and Sell mean strictly secondary-market trades between holders (DEX pools, the liquidity provision engine). The Reserve page tabs read Mint / Redeem, and every toast, error, tooltip, docs-site page, legal page and living doc follows. The Buy tax and Sell tax are on hold: the app was charging them inside in-app mints and redemptions on top of the mint fee (the 2026-09-10 DEC-0198 fee entry). Nothing is charged now.

## Code touched
- `docs/protocol/TERMINOLOGY.md` (new) — the mandatory spec.
- `AGENTS.md` (new), `CLAUDE.md` — rule for every AI agent, including "correct developers who say buy/sell for the in-app flow".
- `lib/mainnet/tradeTaxHold.ts` (new), `api/mainnet/build-buy.ts`, `build-sell.ts` — `TRADE_TAX_ON_HOLD` stops the endpoints resolving any tax rate.
- `src/**` — user-facing copy only; identifiers, tab values (`"buy"`/`"sell"`), ledger values and CSS classes unchanged.
- `tests/phase_terminology_and_tax_hold.ts` (new) — fails on Buy/Sell/purchase copy under `src/` outside a reasoned allowlist, and pins the hold.

## Effect on others — READ THIS
- **Liquidity Module work:** Buy/Sell (and the Buy/Sell tax) now belong to the liquidity provision engine and secondary markets only. Use "Buy"/"Sell" there freely; never for minting/redeeming. Re-enabling the tax is a new decision, for secondary trades only. DEC-0221's open "Manager-half split" question moves to that work.
- New UI copy saying "Buy"/"Sell"/"purchase" for the in-app flow fails the guard test. Add an allowlist entry (with a reason) only for genuine secondary-market text.
- Next free decision id on `main`: DEC-0229 (`design` used DEC-0222..0224).

## Verification
Full offline phase suite on `main`: 1304 passing, 5 failing (the known pre-existing set). `npx tsc -b` exit 0, `vite build` OK, oxlint unchanged (7 pre-existing errors in ManageDTR.tsx). The guard test also passes on this merged `design` tree.
