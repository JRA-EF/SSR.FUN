# Liquidity UI: readable launch button, fresh-Reserve hint, live trust badges

- **Date:** 2026-10-23
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `fix/liquidity-ui-polish` -> `main`
- **Deployed to:** production `dpl_JAv9inJ83WLDKPbDcYL7xziidHPR` (ssr.fun, main 7411420); staging not redeployed
- **Decision log:** none (UI fixes; badges are DEC-0218's, now fed by live data)

## What shipped
Creator, 2026-10-23, three asks:
1. **"Launch liquidity" was blue on blue.** Root cause, not a one-off: `src/index.css` had an UNLAYERED `a { color: var(--accent-ink) }`. Unlayered CSS beats every Tailwind utility, so any `<Button asChild><Link/></Button>` lost `text-action-foreground` and rendered link-blue text on the indigo pill. The `a` / `a:hover` rules now sit in `@layer base` (same fix as the heading reset next to them), and the Button base classes add `no-underline hover:no-underline` (the `link` variant still underlines). Plain links keep the accent colour.
2. **Random error in the liquidity section right after creating a Reserve.** The pool state read and the launch preparation both fail for a few minutes on a brand-new Reserve (RPC catch-up, NAV/launch prices not yet available). The section now leads with "Liquidity isn't ready for this Reserve yet. If you just created this Reserve, please wait 2-3 minutes while Solana and our price feeds catch up, then try again." with the raw error underneath as "Details". Launch errors the creator fixes themselves (insufficient USDC/tokens, wrong wallet, SOL cap, pool exists, paused) are shown as before, without the hint.
3. **Liquidity badges on the Reserve page.** `LiquidityBadges` only ever rendered for design previews, so live Raydium pools showed nothing. A live pool now shows the same badges (unlocked / 100% locked · Nd left / locked forever, deep liquidity at $100k+) plus the pool link, for every viewer. Lock state is the creator treasury's position: any LP it can withdraw now (held, or in an expired lock) reads as unlocked; otherwise the earliest active timed lock; otherwise permanent. Third-party LP is not counted.

## Code touched
- `src/index.css` -- `a` / `a:hover` moved into `@layer base`.
- `src/merge/components/ui/button.tsx` -- `no-underline hover:no-underline` in the base classes.
- `src/merge/lib/liquidity/liveLiquidityClient.ts` -- `livePoolBadgeSource`, `FRESH_RESERVE_HINT`, `launchErrorText`.
- `src/merge/components/LiquidityModule.tsx` -- shared `readLivePool` (60 s cache: the launch banner and the badges make ONE `/api/mainnet/liquidity` read per page view; that endpoint allows 8 reads/min per IP), `useLiquidityBadgePool`, `ReserveLiquidityBadges`; `LiquidityLaunchNudge` uses the shared read.
- `src/merge/components/LiveLiquiditySection.tsx` -- fresh-Reserve copy for the read failure and the launch preparation.
- `src/merge/pages/DTRDetail.tsx` -- renders `<ReserveLiquidityBadges>` under the Reserve name.
- `tests/phase_liquidity_ui_polish.ts` (new, 10 tests).

## Effect on others -- READ THIS
- The CSS change is global: a link that carries a Tailwind `text-*` class now actually gets that colour (before, `--accent-ink` silently won). That is the intended behaviour, but a link that only looked right by accident may change colour.
- Every Mainnet Reserve page view now makes one liquidity read (before: only the root Manager's). Discover cards still use preview data only.

## Verification
`tsc -b` clean, oxlint clean on the changed lines, new suite 10 passing + `phase_liquidity_manage_tab` 8 passing; full offline suite unchanged apart from the 4 known `phase_chart_range_selector` failures (same 4 on main before this change). A `VITE_ENABLE_LIQUIDITY=true VITE_SOLANA_CLUSTER=mainnet-beta` build carries the new copy and `@layer base{h1,h2,h3,h4,p{margin:0}a{color:var(--accent-ink)...`.
