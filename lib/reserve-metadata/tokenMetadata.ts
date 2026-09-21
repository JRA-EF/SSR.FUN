// Pure mapping from a stored Reserve metadata payload (lib/reserve-metadata/
// payload.ts) to the JSON record a Reserve Token's on-chain Metaplex `uri`
// points at (see api/<cluster>/token-metadata.ts and packages/sdk/src/
// tokenMetadata.ts). Wallets, explorers and DEXes read the standard field
// names here: `name`, `symbol`, `description`, `image`. SSR.fun's own
// fields (`ticker`, `imageUrl`, `category`, ...) stay on the original record;
// this one is derived from it on every request, never stored separately.
//
// Dependency-free so tests/phase_token_metadata.ts can exercise it offline.
import type { ReserveMetadataPayload } from "./payload";

export interface TokenMetadataJson {
  name: string;
  symbol: string;
  description: string;
  /** Present only when the Reserve has a picture -- never an empty string. */
  image?: string;
  /** The Reserve's page on SSR.fun. */
  external_url?: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

export interface TokenMetadataOptions {
  /**
   * The Reserve's CURRENT picture URL, when the caller resolved one from the
   * reserve_image_pointer store (a Manager can change the picture without
   * republishing the payload). Falls back to the payload's own imageUrl.
   */
  currentImageUrl?: string | null;
  externalUrl?: string | null;
  /**
   * The origin serving this record (e.g. https://ssr.fun). A payload imageUrl
   * that points at one of this app's OTHER hosts (a Reserve launched on the
   * old domain, which is now the gated staging site) is rewritten onto it,
   * mirroring the frontend's rewriteAppMetadataUriToCurrentOrigin, so a
   * wallet fetching the image never hits a gated host.
   */
  rewriteOrigin?: string | null;
}

/** Hosts this app has been served from -- same set as packages/sdk/src/discovery.ts's APP_HOSTS. */
export const APP_HOSTS = new Set(["strategic-super-reserve.fun", "www.strategic-super-reserve.fun", "ssr.fun", "www.ssr.fun", "ssr-fun.vercel.app"]);

export function rewriteAppImageUrl(imageUrl: string, origin: string | null | undefined): string {
  if (!origin) return imageUrl;
  try {
    const u = new URL(imageUrl);
    if (!APP_HOSTS.has(u.hostname.toLowerCase())) return imageUrl;
    return `${origin.replace(/[/]+$/, "")}${u.pathname}${u.search}`;
  } catch {
    return imageUrl;
  }
}

export function buildTokenMetadataJson(payload: ReserveMetadataPayload, opts: TokenMetadataOptions = {}): TokenMetadataJson {
  const rawImage = (opts.currentImageUrl && opts.currentImageUrl.trim()) || (payload.imageUrl && payload.imageUrl.trim()) || "";
  const image = rawImage ? rewriteAppImageUrl(rawImage, opts.rewriteOrigin) : "";
  const out: TokenMetadataJson = {
    name: payload.name,
    symbol: payload.ticker,
    description: payload.description ?? "",
    attributes: [],
  };
  if (image) out.image = image;
  if (opts.externalUrl && opts.externalUrl.trim()) out.external_url = opts.externalUrl.trim();
  if (payload.category && payload.category.trim()) {
    out.attributes.push({ trait_type: "Category", value: payload.category.trim() });
  }
  out.attributes.push({ trait_type: "Type", value: "SSR.fun Reserve Token" });
  return out;
}
