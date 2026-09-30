// POST /api/robinhood/reserve-metadata -- stores a Robinhood Chain Reserve's
// off-chain name/ticker/description/category/pictures/links JSON payload in
// Postgres and returns a short, deterministic, content-addressed id.
// RobinhoodCreateForm.tsx uploads here FIRST, then submits only
// `${window.location.origin}/api/robinhood/reserve-metadata?id=<id>` on-chain
// as the reserve's `mandate` string (the Folio contract's one free-text
// field), NEVER the JSON payload itself -- the exact same shape as a Solana
// Reserve's metadata_uri.
//
// This is the exact same generic, cluster-agnostic store as
// api/mainnet/reserve-metadata.ts and api/devnet/reserve-metadata.ts (same
// lib/reserve-metadata/payload.ts validation, same lib/reserve-metadata/db.ts
// table) -- deliberately a separate file, not a shared handler branching on
// chain, for the same reason as the devnet/mainnet route pair: a Robinhood
// reserve's mandate must never be minted under a Solana-cluster path, and
// src/merge/lib/evmReserveMeta.ts recognises a reserve as an SSR.FUN reserve
// precisely by this path.
//
// GET /api/robinhood/reserve-metadata?id=<id> -- serves the stored JSON
// payload back. This endpoint IS the permanent URL a reserve's mandate
// points at, so (like every other public read in this app, and like the
// Solana routes in middleware.ts's PUBLIC_READ_API_PATHS) it needs no
// dashboard or site auth: it must be resolvable by anyone/anything reading
// the reserve later.
import { validateReserveMetadataPayload, computeMetadataId, toWalletFacingMetadata, type ReserveMetadataPayload } from "../../lib/reserve-metadata/payload";
import { getSql } from "../../lib/reserve-metadata/db";
import { parseJsonBody } from "../devnet/_lib/apiTypes";

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
    // computeMetadataId always produces exactly 16 lowercase hex characters
    // -- reject anything else before it ever reaches the database driver.
    if (!/^[0-9a-f]{16}$/i.test(id)) {
      res.status(400).json({ error: "Malformed 'id' query param." });
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
      // Served to explorers and other sites too (the on-chain mandate points
      // straight here), so allow cross-origin reads; and the row is immutable
      // (content-addressed id), so cache it hard.
      res.setHeader?.("Access-Control-Allow-Origin", "*");
      res.setHeader?.("Cache-Control", "public, max-age=3600, s-maxage=86400, immutable");
      res.status(200).json(toWalletFacingMetadata(row.payload as ReserveMetadataPayload));
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read Reserve metadata." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
