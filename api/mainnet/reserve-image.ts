// POST /api/mainnet/reserve-image -- stores a Reserve's profile picture
// (sent as a data:image/...;base64 string, already downscaled client-side
// -- see src/merge/lib/reserveImageClient.ts) in Postgres and returns a
// short, deterministic, content-addressed id. The Manage page uploads here
// FIRST, then embeds only
// `${window.location.origin}/api/mainnet/reserve-image?id=<id>` in the
// Reserve's off-chain metadata payload as `imageUrl` (see
// lib/reserve-metadata/payload.ts), NEVER the image bytes themselves.
//
// This is the exact same generic, cluster-agnostic store as
// api/devnet/reserve-image.ts (same lib/reserve-image/payload.ts
// validation, same lib/reserve-image/db.ts table) -- deliberately a
// separate file, not a shared handler branching on cluster, for the same
// reason as the reserve-metadata route pair: a Mainnet Reserve's stored
// URL must never be minted under the /api/devnet/... path.
//
// GET /api/mainnet/reserve-image?id=<id> -- serves the stored image bytes
// back with their real Content-Type. This endpoint IS the permanent URL a
// Reserve's metadata `imageUrl` points at, so (like every other public
// read in this app) it needs no dashboard auth: it must be resolvable by
// anyone/anything rendering the Reserve later. Content-addressed ids never
// change meaning, so the response is cacheable as immutable.
//
// Pointer flow (signature-free picture changes -- see
// docs/project/DECISION_LOG.md's entry for this change): a POST may also
// carry `reserve` (the Reserve's on-chain address); the upload then ALSO
// upserts reserve_image_pointer so that Reserve's currently-shown picture
// becomes this image -- no update_metadata transaction, no wallet
// signature. GET ?pointers=1 returns every pointer as
// `{ pointers: { <reserve>: <image id> } }` -- RealReserveSync merges it
// over each Reserve's metadata-embedded imageUrl once per discovery pass.
// DELIBERATE TRADE-OFF: like the image store itself, the pointer write is
// public and unauthenticated (the product decision was to drop the wallet
// approval entirely); the on-chain metadata's own imageUrl is untouched by
// pointer writes, so wiping a bad pointer row restores the signed state.
import { validateReserveImageDataUrl, validateReserveAddress, computeImageId, ALLOWED_IMAGE_CONTENT_TYPES } from "../../lib/reserve-image/payload";
import { getSql } from "../../lib/reserve-image/db";
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
  /** Vercel's Node runtime response -- present at runtime; optional here so the minimal structural type stays test-friendly. */
  send?(body: unknown): void;
  end?(body?: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === "POST") {
    res.setHeader?.("Cache-Control", "no-store");
    let payload;
    let reserve: string | null = null;
    try {
      const body = parseJsonBody(req);
      payload = validateReserveImageDataUrl(body.dataUrl);
      // Optional: when present, this upload also repoints the named
      // Reserve's currently-shown picture (see the pointer-flow header).
      if (body.reserve !== undefined && body.reserve !== null && body.reserve !== "") {
        reserve = validateReserveAddress(body.reserve);
      }
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Invalid profile picture upload." });
      return;
    }
    const id = computeImageId(payload);
    try {
      const sql = getSql();
      await sql`
        insert into reserve_image (id, content_type, data_base64)
        values (${id}, ${payload.contentType}, ${payload.dataBase64})
        on conflict (id) do nothing
      `;
      if (reserve) {
        await sql`
          insert into reserve_image_pointer (reserve, image_id, updated_at)
          values (${reserve}, ${id}, now())
          on conflict (reserve) do update set image_id = excluded.image_id, updated_at = now()
        `;
      }
      res.status(200).json({ id });
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to store the profile picture." });
    }
    return;
  }

  if (req.method === "GET") {
    const url = new URL(req.url ?? "", "http://internal");
    if (url.searchParams.get("pointers") !== null) {
      // The full reserve -> image-id pointer map (small by construction:
      // one row per Reserve that has ever had its picture changed). Served
      // uncached -- this is exactly the mutable state whose freshness the
      // signature-free edit flow depends on.
      try {
        const sql = getSql();
        const rows = (await sql`select reserve, image_id from reserve_image_pointer`) as { reserve: string; image_id: string }[];
        res.setHeader?.("Cache-Control", "no-store");
        res.status(200).json({ pointers: Object.fromEntries(rows.map((r) => [r.reserve, r.image_id])) });
      } catch (e) {
        res.setHeader?.("Cache-Control", "no-store");
        res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read the profile picture pointers." });
      }
      return;
    }
    const id = url.searchParams.get("id");
    if (!id) {
      res.status(400).json({ error: "Missing required 'id' query param." });
      return;
    }
    // computeImageId always produces exactly 16 lowercase hex characters --
    // reject anything else before it reaches the database driver, same as
    // reserve-metadata's GET.
    if (!/^[0-9a-f]{16}$/i.test(id)) {
      res.status(400).json({ error: "Malformed 'id' query param." });
      return;
    }
    try {
      const sql = getSql();
      const rows = await sql`select content_type, data_base64 from reserve_image where id = ${id}`;
      const row = rows[0] as { content_type: string; data_base64: string } | undefined;
      if (!row) {
        res.status(404).json({ error: "No profile picture found for this id." });
        return;
      }
      // Serve only an allowlisted content type, even though the write path
      // already enforces it -- a row can only mislabel bytes, never inject
      // an arbitrary header value.
      const contentType = (ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(row.content_type) ? row.content_type : "application/octet-stream";
      res.setHeader?.("Content-Type", contentType);
      // Content-addressed: the bytes behind an id can never change.
      res.setHeader?.("Cache-Control", "public, max-age=31536000, immutable");
      const bytes = Buffer.from(row.data_base64, "base64");
      res.status(200);
      if (res.send) res.send(bytes);
      else if (res.end) res.end(bytes);
      else res.json({ error: "This runtime cannot serve binary responses." });
    } catch (e) {
      res.setHeader?.("Cache-Control", "no-store");
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read the profile picture." });
    }
    return;
  }

  res.setHeader?.("Cache-Control", "no-store");
  res.status(405).json({ error: "Method not allowed" });
}
