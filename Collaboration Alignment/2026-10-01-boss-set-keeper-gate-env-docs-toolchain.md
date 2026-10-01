# Gate /internal/set-keeper, back-fill .env.example, status snapshot, local Solana toolchain

- **Date:** 2026-10-01
- **Author:** Boss (enigma@enigma-fund.com) via Claude Code (Fable 5.1)
- **Branch / commits:** `design` @ `fa1c045` (on top of `origin/design` `829a4d1`); folder bootstrap commit follows. Not merged to `main`.
- **Deployed to:** none
- **Decision log:** DEC-0221 (appended on `design`). **Next free id is DEC-0222.**

## What shipped
1. `/internal/set-keeper` (the Protocol-Admin page that signs `set_fee_settlement_keeper`) now requires the team dashboard password (Gate 2), not just a beta key. No visible change for team members who already hold the dashboard session; external beta testers can no longer reach the page.
2. `.env.example` now lists every server variable the code reads (it was missing ~14).
3. `PROJECT_STATUS.md` got dated 2026-10-01 "current state" paragraphs prepended to Current Phase / Current Objective / Executive Summary; the historical text underneath is untouched. Production deployment line updated to `dpl_2a4dQsCottx7UpPpzrsJCyxnJmvg` = `main` @ `5a94d8e`.
4. This `Collaboration Alignment/` folder and the CLAUDE.md rule that every agent reads it first and writes to it on every ship.
5. Local-only: Solana/Anchor toolchain installed on the Boss's Mac (not a repo change — see "Effect on others").

## Code touched
- `middleware.ts` — `INTERNAL_PAGE_PATHS` gains `/internal/set-keeper` and `/internal-set-keeper.html`.
- `.env.example` — new sections: server RPC URLs (`HELIUS_RPC_URL`, `SOLANA_RPC_URL`, `HELIUS_MAINNET_RPC_URL`, `MAINNET_RPC_URL`, `ROBINHOOD_RPC_URL`), `CRON_SECRET`, `DATABASE_URL`, site gate (`SSR_SITE_GATE_ENABLED/MODE`, `SSR_SITE_PASSWORD`, `SSR_BETA_KEYS`, `SSR_TEAM_KEYS`, site lockout vars), `SSR_FEE_SETTLEMENT_KEEPER_SECRET`, `JUPITER_API_KEY/BASE/EXCLUDE_DEXES`, `VITE_ENABLE_EVM`, `FEEDBACK_DAEMON_SECRET`. `LEDGER_CLUSTER` comment updated — note Joao reports it is set nowhere in Vercel.
- `docs/project/PROJECT_STATUS.md` — three prepended paragraphs + production deployment line.
- `docs/project/DECISION_LOG.md` — DEC-0221 appended.
- `CLAUDE.md` — new "Collaboration Alignment" section.
- `Collaboration Alignment/README.md` — the protocol and template.

## Repositories / environments adjusted
- SSR.FUN only, branch `design`. No Vercel, Neon, Squads or key changes.

## Effect on others — READ THIS
- **Merge path:** per Joao, `design` reaches `main` via one merge from `staging` after the Robinhood work (DEC-0219/0220) lands. Do not PR `design` → `main` separately; `fa1c045` should ride along in that merge. `staging` will need `origin/design` merged in to pick it up.
- **DEC numbering:** 0217/0218 = design (Liquidity Module), 0219/0220 = staging (Robinhood), 0221 = this. Use **0222** next. The duplicated 0197–0202 block on `main` still needs renumbering (canonical = the 2026-09-08→09-11 block; renumber the 09-14→09-16 block) — owner not yet assigned.
- **Approved next pass (not started):** DevNet-retirement docs pass on `design` — keep on-chain identifiers and `api/devnet/*`, decide on the weekly `/api/devnet/accrue-fees-cron` in `vercel.json`, move DevNet runbooks to `docs/project/superseded/`. Tell the folder if you start it.
- **Do not flip** `VITE_ENABLE_EVM` on `ssr-fun` production without the Creator's go (Joao, 2026-10-01).
- **Boss's machine now builds programs:** rustc 1.99, Agave 4.1.2, anchor-cli 1.1.2, `anchor build` green. Local builds use platform-tools v1.51; Joao's Mainnet buffers used v1.54, so hashes differ. Proposal: add `solana_version = "4.1.2"` under `[toolchain]` in `Anchor.toml` on `main` so builds are byte-comparable before a Squads proposal — Joao to confirm the exact version his last buffer used.
- Liquidity Module files (`src/merge/components/LiquidityModule.tsx`, `src/merge/lib/liquidityPreview.ts`, `docs/project/LIQUIDITY_MODULE_SPEC.md`) are the Boss's in-flight design area — coordinate before editing.

## Verification
- `npx tsc -b` and `oxlint middleware.ts` clean on `design` (after `npm run build --workspace=packages/sdk`, which is required or tsc reports phantom "no exported member" errors from the stale SDK dist).
- `anchor build` succeeds on the Boss's Mac; `solana program dump -u m 8hTW7fHw…` confirms RPC + CLI work against Mainnet (read-only).
- Middleware change not yet exercised in a browser: `vercel dev` with a dashboard session is the check before deploy.
