# Reserve social links: X, Telegram, YouTube and DexScreener icons by the ticker

- **Date:** 2026-10-28
- **Author:** Joao via Claude (Opus 5.5)
- **Branch / commits:** `main` (this commit)
- **Deployed to:** production (see the follow-up line once the deploy id is known)
- **Decision log:** DEC-0271

## What shipped
- Launch step 1 (Identity) has two new optional fields, **X** and **Telegram**, under the YouTube fields (Solana and Robinhood create forms). A handle or a link both work; anything else shows an inline error and blocks Next.
- The Reserve page shows small round icons right of the ticker: X, Telegram, YouTube (each only when set) and DexScreener (always, once the token address is known; opens `dexscreener.com/search?q=<CA>`).
- Solana launches now save the YouTube channel and featured video in the Reserve's metadata too, so visitors (not just the creator's browser) see the video panel.

## Code touched
- `lib/reserve-metadata/payload.ts`: new optional `xUrl`, `telegramUrl` keys, appended last, https-only, omitted when empty (existing ids unchanged).
- `packages/sdk/src/discovery.ts`: `ParsedReserveMetadata` carries the YouTube/X/Telegram links (https only).
- `src/merge/lib/reserveSocials.ts` (new): X/Telegram normalizers and the DexScreener search URL.
- `src/merge/components/ReserveSocialLinks.tsx` (new): the icon row. `public/logo-dexscreener.png` (new).
- `src/merge/pages/CreateDTR.tsx`, `src/merge/lib/createDraft.ts`: fields, draft save/restore, metadata upload.
- `src/merge/pages/DTRDetail.tsx`, `src/merge/lib/onChainReserve.ts`, `src/merge/lib/types.ts`: `dtr.socials`, `dtr.youtube` from metadata, icon row.
- `src/merge/lib/evmReserveMeta.ts`, `src/merge/components/robinhood/RobinhoodCreateForm.tsx`, `RobinhoodReserveDetail.tsx`: same on Robinhood Chain.
- `tests/phase_reserve_socials.ts` (new).

## Effect on others: READ THIS
- **Links are fixed at launch.** They live in the immutable metadata record. Editing them later would need a mutable pointer like the profile picture's (not built).
- Any new metadata key must be appended after `telegramUrl` and omitted when empty, or existing Reserves' metadata ids change.
- DexScreener blocks automated fetches (Cloudflare), so the search link could not be checked headlessly; the same query works on their API.

## Verification
- `tsc -b` clean; full offline suite 1,772 passing with the 5 known baseline failures; new socials test 6 passing; headless Chrome render of the icon row.
