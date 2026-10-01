// Pure resolution + HTML for the public Reserve share page (DEC-0200).
//
// The app is a HASH router: a crawler or social-card fetcher asking for
// ssr.fun/#/dtr/mainnet-beta-24 sends the server only "/", because a fragment
// never leaves the browser. No amount of renaming that URL can produce a
// social card or an indexable page. So sharing goes through a real path the
// server actually sees, /r/<address>, which this module renders.
//
// The address IS the identity -- the pool (Reserve) account, or the Reserve
// Token mint, both of which already exist for every Reserve past and future.
// That means no slug table, no collision numerals, no backfill, and no
// creator-facing field to get wrong.
//
// Nothing here touches the network: the caller supplies the warm-cache
// snapshot and this decides what to render, so it is all directly testable.

/** The bits of the warm-cache snapshot this page needs. */
export interface ShareSnapshotReserve {
  reserveId: string;
  reserve: string;
  reserveTokenMint: string;
  status?: string;
}
export interface ShareSnapshot {
  reserves?: ShareSnapshotReserve[];
  metadataByReserve?: Record<string, { name?: string; ticker?: string; description?: string; imageUrl?: string } | null>;
}

export type ShareResolution =
  | { kind: "canonical"; reserve: ShareSnapshotReserve }
  /** The caller asked by mint; the canonical URL is the pool address. */
  | { kind: "redirect"; to: string }
  | { kind: "not-found" };

/** Base58 is 32-44 chars of the Bitcoin alphabet -- no 0, O, I or l. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isPlausibleAddress(value: string): boolean {
  return BASE58_ADDRESS.test(value);
}

/**
 * Resolves a shared address to a Reserve. The pool address is canonical; the
 * Reserve Token mint redirects to it so a link survives whichever address
 * someone happened to copy. An address that matches no Reserve is NOT
 * rendered -- we never emit a card for a stranger's account.
 */
export function resolveShareAddress(snapshot: ShareSnapshot, address: string): ShareResolution {
  if (!isPlausibleAddress(address)) return { kind: "not-found" };
  const reserves = snapshot.reserves ?? [];
  const byPool = reserves.find((r) => r.reserve === address);
  if (byPool) return { kind: "canonical", reserve: byPool };
  const byMint = reserves.find((r) => r.reserveTokenMint === address);
  if (byMint) return { kind: "redirect", to: byMint.reserve };
  return { kind: "not-found" };
}

export interface SharePageData {
  title: string;
  description: string;
  imageUrl: string | null;
  canonicalUrl: string;
  appUrl: string;
  mint: string;
  pool: string;
}

/** Escapes a value for use inside an HTML attribute or text node. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapses whitespace and trims to `max` graphemes-ish, for meta tags. */
export function clamp(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  // The ellipsis counts toward the budget: the RESULT is never longer than
  // `max`, so a caller can trust the cap it asked for.
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function buildSharePageData(
  origin: string,
  reserve: ShareSnapshotReserve,
  metadata: { name?: string; ticker?: string; description?: string; imageUrl?: string } | null | undefined,
): SharePageData {
  const name = (metadata?.name ?? "").trim();
  const ticker = (metadata?.ticker ?? "").trim();
  // A Reserve whose metadata has not resolved still gets an honest, specific
  // card -- its address -- never a generic app-wide title.
  const title = name && ticker ? `${name} (${ticker})` : name || ticker || `Reserve ${reserve.reserveId}`;
  const described = (metadata?.description ?? "").trim();
  const description = described
    ? clamp(described, 200)
    : `A tokenized reserve on SSR.fun. Reserve Token mint ${reserve.reserveTokenMint}.`;
  return {
    title,
    description,
    imageUrl: metadata?.imageUrl && /^https:\/\//i.test(metadata.imageUrl) ? metadata.imageUrl : null,
    canonicalUrl: `${origin}/r/${reserve.reserve}`,
    appUrl: `${origin}/#/dtr/${reserve.reserveId}`,
    mint: reserve.reserveTokenMint,
    pool: reserve.reserve,
  };
}

/**
 * The HTML a crawler, a social-card fetcher, or a human clicking a shared
 * link receives. Humans are moved into the hash app by a meta refresh plus a
 * script; crawlers keep the meta tags. Deliberately self-contained: no bundle,
 * no fonts, nothing that could fail to load before the card is scraped.
 */
export function renderSharePage(data: SharePageData): string {
  const t = escapeHtml(data.title);
  const d = escapeHtml(data.description);
  const canonical = escapeHtml(data.canonicalUrl);
  const app = escapeHtml(data.appUrl);
  const image = data.imageUrl ? escapeHtml(data.imageUrl) : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t} | SSR.fun</title>
<meta name="description" content="${d}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="SSR.fun" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:url" content="${canonical}" />
${image ? `<meta property="og:image" content="${image}" />\n<meta name="twitter:card" content="summary_large_image" />\n<meta name="twitter:image" content="${image}" />` : `<meta name="twitter:card" content="summary" />`}
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta http-equiv="refresh" content="0; url=${app}" />
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d0b12; color:#eeeaf6; font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { text-align:center; padding:32px; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { font-size:14px; color:#a89fbb; margin:0 0 16px; }
  a { color:#8b45ff; }
  code { font-size:12px; color:#a89fbb; word-break:break-all; }
</style>
</head>
<body>
<main>
  <h1>${t}</h1>
  <p>${d}</p>
  <p><a href="${app}">Open this Reserve on SSR.fun</a></p>
  <code>${escapeHtml(data.mint)}</code>
</main>
<script>window.location.replace(${JSON.stringify(data.appUrl)});</script>
</body>
</html>`;
}

/** The page shown when an address matches no Reserve. Never a card. */
export function renderShareNotFound(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Reserve not found | SSR.fun</title>
<meta name="robots" content="noindex" />
<meta name="description" content="No SSR.fun Reserve matches this address." />
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d0b12; color:#eeeaf6; font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif; }
  a { color:#8b45ff; }
</style>
</head>
<body><main style="text-align:center;padding:32px">
<h1 style="font-size:18px;margin:0 0 8px">Reserve not found</h1>
<p style="font-size:14px;color:#a89fbb">No Reserve on SSR.fun matches that address.</p>
<p><a href="${escapeHtml(origin)}/">Go to SSR.fun</a></p>
</main></body>
</html>`;
}
