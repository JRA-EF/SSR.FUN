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
| **Buy tax** / **Sell tax** | Manager's tax on secondary Buy/Sell trades. **ON HOLD** (`TRADE_TAX_ON_HOLD`). | A mint or a redemption. Ever. |

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
5. Do not re-enable the Buy/Sell tax. That needs a new decision in
   `docs/project/DECISION_LOG.md`.

`tests/phase_terminology_and_tax_hold.ts` enforces the UI copy and the tax
hold. Keep it passing; never weaken it to make a change pass.
