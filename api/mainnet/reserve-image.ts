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
import { validateReserveImageDataUrl, computeImageId, ALLOWED_IMAGE_CONTENT_TYPES } from "../../lib/reserve-image/payload";
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
    try {
      payload = validateReserveImageDataUrl(parseJsonBody(req).dataUrl);
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
      res.status(200).json({ id });
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to store the profile picture." });
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
