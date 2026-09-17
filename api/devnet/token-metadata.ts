// GET /api/devnet/token-metadata?id=<metadata id>&reserve=<reserve address>
//
// DevNet twin of api/mainnet/token-metadata.ts (read that file's header):
// the standard-format JSON record a DevNet Reserve Token's on-chain Metaplex
// metadata `uri` points at. Deliberately a separate file per the
// cluster-route-pair convention, so a DevNet URI is never minted under the
// Mainnet path or vice versa.
import { getSql } from "../../lib/reserve-metadata/db";
import { buildTokenMetadataJson } from "../../lib/reserve-metadata/tokenMetadata";
import type { ReserveMetadataPayload } from "../../lib/reserve-metadata/payload";

const CLUSTER = "devnet";

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
    res.setHeader?.("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.setHeader?.("Access-Control-Allow-Origin", "*");
    res.status(200).json(body);
  } catch (e) {
    res.setHeader?.("Cache-Control", "no-store");
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read Reserve metadata." });
  }
}
