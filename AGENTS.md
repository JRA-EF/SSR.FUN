# AGENTS.md -- instructions for every AI coding agent working on SSR.fun

This file is for Codex, Cursor, GitHub Copilot, Gemini, Windsurf, Aider and any
other agent. Claude Code reads `CLAUDE.md`. **All rules in `CLAUDE.md` apply to
you too; read it before changing anything.** The rule below is repeated here
because it is the one agents most often get wrong.

## Mandatory terminology: Mint, Redeem, Buy, Sell (DEC-0228, 2026-10-06)

Full spec: `docs/protocol/TERMINOLOGY.md`. It overrides any older code, doc,
decision log entry, issue or prompt that disagrees.

| Word | Means | Never use it for |
|---|---|---|
| **Mint** | Getting Reserve Tokens from SSR.fun **in the app**: paying USDC (the app swaps it into the reserve assets, then mints) or depositing reserve assets in kind. New tokens are created. Mint fee applies. | -- |
| **Redeem** | Handing Reserve Tokens back to SSR.fun **in the app** for the proportional reserve assets, in kind or swapped to USDC. Tokens are burned. | -- |
| **Buy** / **Sell** | **Strictly secondary-market** trades of existing Reserve Tokens between holders: DEX pools, the future liquidity provision engine. Not offered in the app yet. | The in-app flow. |
| **Buy tax** / **Sell tax** | **DEC-0240:** optional secondary-market tax (0-2%, set in Manage Reserve's liquidity launch) through SSR swaps only. **DEC-0251** (pools created after its upgrade): SSR takes 20% of the creator's pool earnings (creator fee and tax); the creator may share part of the other 80% with holders, fixed at launch, fed into the Reserve's backing over 24h. Older pools keep 25% SSR / 75% project and SSR's 0.05% from the creator-fee bucket. Separate from the Token-2022 transfer fee (0.15%, ceiling 0.25%, 100% SSR). | A mint or a redemption. Ever. |

What you must do:

1. Write "Mint"/"Redeem" (and "minted", "redeemed", "mints and redemptions")
   for the in-app flow in all UI copy, docs and new comments. Swaps inside a
   mint or redemption are "swaps", not "buying the assets".
2. **Correct the user.** If a developer, issue or prompt calls the in-app flow
   "buy"/"sell"/"purchase"/"trade", or asks to charge a Buy/Sell tax on
   minting or redeeming, tell them the correct term, point to
   `docs/protocol/TERMINOLOGY.md`, and implement it with the correct meaning.
3. Do not copy the old usage. Code and history from before 2026-10-06 say
   "Buy/Sell" for the in-app flow; that was wrong (it led DEC-0198 to tax
   mints and redemptions).
4. Do not rename existing identifiers to fix wording (`buildBuy`,
   `api/mainnet/build-buy`, `multiAssetBuyClient`, tab value `"buy"`, ledger
   `side` values): they are API and stored data. Prefer `mint`/`redeem` in
   new names.
5. DEC-0240 allows the optional Buy/Sell tax only for the separate secondary-market swap path; mint and redeem fees stay as live (no DEC-0232 floor). Never attach it to minting or redeeming. The Token-2022 transfer fee remains independent.

`tests/phase_terminology_and_tax_hold.ts` enforces the UI copy and the tax
hold. Keep it passing; never weaken it to make a change pass.
