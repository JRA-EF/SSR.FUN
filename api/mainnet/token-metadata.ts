// GET /api/mainnet/token-metadata?id=<metadata id>&reserve=<reserve address>
//
// The standard-format JSON record a Mainnet Reserve Token's on-chain Metaplex
// metadata `uri` points at (set by the program's set_reserve_token_metadata
// instruction -- see packages/sdk/src/tokenMetadata.ts). Derived on every
// request from the SAME stored payload as /api/mainnet/reserve-metadata?id=
// (lib/reserve-metadata/tokenMetadata.ts does the field mapping), plus the
// Reserve's CURRENT profile-picture pointer (reserve_image_pointer, written
// by the Manage page's picture editor) so a picture change shows up in
// wallets without any transaction.
//
// Same deliberate cluster-route-pair convention as reserve-metadata.ts /
// reserve-image.ts: this file is Mainnet's, api/devnet/token-metadata.ts is
// DevNet's, never a shared handler branching on cluster. Public, GET-only,
// no auth (middleware.ts PUBLIC_READ_API_PATHS): it MUST be readable by any
// wallet or DEX, and it only ever serves what the Reserve already publishes.
import { getSql } from "../../lib/reserve-metadata/db";
import { buildTokenMetadataJson } from "../../lib/reserve-metadata/tokenMetadata";
import type { ReserveMetadataPayload } from "../../lib/reserve-metadata/payload";

const CLUSTER = "mainnet";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

function requestOrigin(req: ApiRequest): string {
  const raw = req.headers["x-forwarded-host"] ?? req.headers["host"];
  const host = (Array.isArray(raw) ? raw[0] : raw) ?? "ssr.fun";
  return `https://${host.split(",")[0].trim()}`;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader?.("Cache-Control", "no-store");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const url = new URL(req.url ?? "", "http://internal");
  const id = url.searchParams.get("id");
  const reserve = url.searchParams.get("reserve");
  if (!id || !/^[0-9a-f]{16}$/i.test(id)) {
    res.setHeader?.("Cache-Control", "no-store");
    res.status(400).json({ error: "Missing or malformed 'id' query param." });
    return;
  }
  if (reserve !== null && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(reserve)) {
    res.setHeader?.("Cache-Control", "no-store");
    res.status(400).json({ error: "Malformed 'reserve' query param." });
    return;
  }

  try {
    const sql = getSql();
    const rows = await sql`select payload from reserve_metadata where id = ${id}`;
    const row = rows[0] as { payload: ReserveMetadataPayload } | undefined;
    if (!row) {
      res.setHeader?.("Cache-Control", "no-store");
      res.status(404).json({ error: "No Reserve metadata found for this id." });
      return;
    }

    const origin = requestOrigin(req);
    let currentImageUrl: string | null = null;
    if (reserve) {
      const pointers = (await sql`select image_id from reserve_image_pointer where reserve = ${reserve}`) as { image_id: string }[];
      if (pointers[0]?.image_id) currentImageUrl = `${origin}/api/${CLUSTER}/reserve-image?id=${pointers[0].image_id}`;
    }

    const body = buildTokenMetadataJson(row.payload, {
      currentImageUrl,
      externalUrl: reserve ? `${origin}/#/dtr/${reserve}` : `${origin}/#/discover`,
    });
    // Short edge cache: a Manager's picture change should reach wallets
    // within a minute, and the record is cheap to rebuild.
    res.setHeader?.("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.setHeader?.("Access-Control-Allow-Origin", "*");
    res.status(200).json(body);
  } catch (e) {
    res.setHeader?.("Cache-Control", "no-store");
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read Reserve metadata." });
  }
}
