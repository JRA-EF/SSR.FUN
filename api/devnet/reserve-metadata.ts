// POST /api/devnet/reserve-metadata -- stores a Reserve's off-chain
// name/ticker/description/category/buyTaxPct/sellTaxPct JSON payload in
// Postgres and returns a short, deterministic, content-addressed id.
// CreateDTR.tsx uploads here FIRST, then submits only
// `${window.location.origin}/api/devnet/reserve-metadata?id=<id>` on-chain
// as Reserve.metadata_uri -- never the JSON payload itself. This is the fix
// for the confirmed root cause of SsrError::MetadataUriTooLong: the
// frontend used to embed the entire JSON payload inline as a
// `data:application/json,...` URI, which routinely exceeded the on-chain
// 200-byte limit for any real name/description. See
// docs/project/DECISION_LOG.md's entry for this fix.
//
// GET /api/devnet/reserve-metadata?id=<id> -- serves the stored JSON
// payload back. This endpoint IS the permanent URL a Reserve's
// metadata_uri points at, so it (like every other public devnet read in
// this app -- e.g. reserve-activity.ts) needs no dashboard auth: it must
// be resolvable by anyone/anything reading a Reserve's metadata later.
import { validateReserveMetadataPayload, computeMetadataId } from "../../lib/reserve-metadata/payload";
import { getSql } from "../../lib/reserve-metadata/db";
import { parseJsonBody } from "./_lib/apiTypes";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");

  if (req.method === "POST") {
    let payload;
    try {
      payload = validateReserveMetadataPayload(parseJsonBody(req));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Invalid metadata payload." });
      return;
    }
    const id = computeMetadataId(payload);
    try {
      const sql = getSql();
      await sql`
        insert into reserve_metadata (id, payload)
        values (${id}, ${JSON.stringify(payload)}::jsonb)
        on conflict (id) do nothing
      `;
      res.status(200).json({ id });
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to store Reserve metadata." });
    }
    return;
  }

  if (req.method === "GET") {
    const url = new URL(req.url ?? "", "http://internal");
    const id = url.searchParams.get("id");
    if (!id) {
      res.status(400).json({ error: "Missing required 'id' query param." });
      return;
    }
    try {
      const sql = getSql();
      const rows = await sql`select payload from reserve_metadata where id = ${id}`;
      const row = rows[0] as { payload: unknown } | undefined;
      if (!row) {
        res.status(404).json({ error: "No Reserve metadata found for this id." });
        return;
      }
      res.status(200).json(row.payload);
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read Reserve metadata." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
