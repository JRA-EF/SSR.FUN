// Shared, non-fictional helpers used across the app: a deterministic logo
// pool (so every DTR -- real, on-chain -- gets a real image instead of just
// letters) and category name suggestions for the Create form.
//
// The fictional demo DTR catalog that used to live here (Solana Blue Chips/
// BLUE, Meme Machine, Solana DeFi, SSR Strategic Reserve, Solana
// Infrastructure, Solana Gaming & NFT) has been removed: this app now only
// discovers and displays genuine on-chain DevNet Reserves (see
// docs/project/PROJECT_STATUS.md's corrective DevNet data-integrity pass).
// Presenting a fully client-side, no-wallet-signature "Buy"/"Sell" against a
// fictional Reserve is exactly the legacy/mock behavior that pass removed.

import blueLogo from "@/assets/dtr-logos/blue.png";
import memeLogo from "@/assets/dtr-logos/meme.png";
import sdefiLogo from "@/assets/dtr-logos/sdefi.png";
import ssrresLogo from "@/assets/dtr-logos/ssrres.png";
import infraLogo from "@/assets/dtr-logos/infra.png";
import gamingLogo from "@/assets/dtr-logos/gaming.png";

/** Shared logo art pool -- every DTR (real, on-chain) gets a real image, never just letters. Reusing the same art assets as the retired demo catalog; these are just images, not fictional Reserve data. */
export const DTR_LOGO_POOL: string[] = [blueLogo, memeLogo, sdefiLogo, ssrresLogo, infraLogo, gamingLogo];

/** Deterministically picks a logo for any DTR id/ticker so every real, on-chain Reserve also gets one. */
export function pickLogoForId(id: string): string {
  const hash = hashSeed(id);
  return DTR_LOGO_POOL[hash % DTR_LOGO_POOL.length];
}

// --- Deterministic PRNG (mulberry32) seeded from a string hash ---------

function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

