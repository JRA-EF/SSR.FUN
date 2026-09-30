// A Robinhood Chain reserve's off-chain profile -- the same name / ticker /
// description / category / pictures / creator links a Solana Reserve carries
// in its metadata_uri payload -- and how the app finds it.
//
// The Folio contract has one free-text field, `mandate`. An SSR.FUN reserve
// stores the permanent URL of its metadata payload there
// (`https://<origin>/api/robinhood/reserve-metadata?id=<16 hex>`), exactly as
// a Solana Reserve stores its metadata_uri on-chain; a reserve created
// elsewhere (or before this existed) has a plain sentence there and simply
// shows no profile. Brand managers can change the mandate later, which is
// what makes a Manage-page edit possible without redeploying.
//
// Pure and viem-free on purpose: the router and the CommonJS test runner
// both load it, and neither can load the EVM stack.

export const ROBINHOOD_METADATA_PATH = "/api/robinhood/reserve-metadata";

/** Creator-supplied YouTube links (mirrors src/merge/lib/types.ts's ReserveYoutube). */
export interface EvmReserveYoutube {
  channelUrl: string;
  featuredVideoUrl?: string;
}

export interface EvmReserveMeta {
  name: string;
  ticker: string;
  description: string;
  category: string;
  /** Profile picture, permanent HTTPS URL. */
  imageUrl?: string;
  /** Wide header banner, permanent HTTPS URL. */
  headerImageUrl?: string;
  youtube?: EvmReserveYoutube;
}

const ID_RE = /^[0-9a-f]{16}$/i;

/**
 * The metadata id a mandate string points at, or null when the mandate is
 * not one of this app's metadata URLs. Host-agnostic: a payload minted on
 * one deployment (ssr.fun, the team site, a preview) is readable from any
 * other, since they share one store -- so only the path and id are judged.
 */
export function metadataIdFromMandate(mandate: string | null | undefined): string | null {
  if (!mandate) return null;
  let url: URL;
  try {
    url = new URL(mandate.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== ROBINHOOD_METADATA_PATH) return null;
  const id = url.searchParams.get("id");
  return id && ID_RE.test(id) ? id.toLowerCase() : null;
}

/** The mandate string to store on-chain for a payload uploaded from `origin`. */
export function mandateForMetadataId(origin: string, id: string): string {
  return `${origin}${ROBINHOOD_METADATA_PATH}?id=${id}`;
}

const isHttps = (v: unknown): v is string => typeof v === "string" && /^https:\/\//i.test(v.trim());

/**
 * Reads a served payload into the app's shape. Defensive on purpose -- the
 * document is fetched over the network and, on another deployment, might be
 * anything: only HTTPS picture/link URLs survive, so a hostile payload can
 * never put a scriptable scheme into an <img src> or an <a href>.
 */
export function parseEvmReserveMeta(json: unknown): EvmReserveMeta | null {
  if (!json || typeof json !== "object") return null;
  const p = json as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const ticker = typeof p.ticker === "string" ? p.ticker.trim() : typeof p.symbol === "string" ? p.symbol.trim() : "";
  if (!name || !ticker) return null;
  const meta: EvmReserveMeta = {
    name,
    ticker,
    description: typeof p.description === "string" ? p.description : "",
    category: typeof p.category === "string" ? p.category : "",
  };
  if (isHttps(p.imageUrl)) meta.imageUrl = p.imageUrl.trim();
  else if (isHttps(p.image)) meta.imageUrl = p.image.trim();
  if (isHttps(p.headerImageUrl)) meta.headerImageUrl = p.headerImageUrl.trim();
  if (isHttps(p.youtubeChannelUrl)) {
    meta.youtube = { channelUrl: p.youtubeChannelUrl.trim() };
    if (isHttps(p.youtubeFeaturedVideoUrl)) meta.youtube.featuredVideoUrl = p.youtubeFeaturedVideoUrl.trim();
  }
  return meta;
}

/**
 * Resolves a reserve's profile from its mandate. Best-effort by design: any
 * failure (not our URL, network down, malformed document) yields null, so a
 * profile hiccup can never blank a reserve out of the directory -- the
 * on-chain name and symbol still render.
 *
 * Tries this deployment's own copy of the store first (same-origin, no CORS,
 * works on the team site and previews that share the database) and only
 * then the URL as written on-chain.
 */
export async function fetchEvmReserveMeta(mandate: string | null | undefined, origin: string): Promise<EvmReserveMeta | null> {
  const id = metadataIdFromMandate(mandate);
  if (!id) return null;
  const candidates = [mandateForMetadataId(origin, id)];
  const asWritten = (mandate ?? "").trim();
  if (asWritten && !candidates.includes(asWritten)) candidates.push(asWritten);
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const meta = parseEvmReserveMeta(await res.json());
      if (meta) return meta;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
