// GET /api/kpis/kpis-export -- the full Reserve Activity Log, every
// indexed event across every Reserve, as one downloadable CSV file (the
// "logged as one big file that we can extract as .csv" requirement). Same
// auth as kpis.ts. Streams via lib/reserve-activity/kpis.ts's
// streamActivityLogCsv (paginated Postgres reads, never one giant query
// result held in memory at once) rather than buffering the whole export
// into a single string first.
import { parseCookie, SESSION_COOKIE_NAME, verifySessionCookie } from "../../lib/dashboard/session.js";
import { streamActivityLogCsv } from "../../lib/reserve-activity/kpis.js";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
  json(body: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  // Wraps everything up to (not including) the streaming loop below in a
  // try/catch -- see kpis.ts's matching comment for why. Once headers are
  // sent, a JSON error response is no longer possible (see the inner
  // try/catch below for that separate, already-handled case), so this only
  // covers the auth/setup path, which is exactly where a crash would
  // otherwise be invisible (a raw platform 500 with no readable message).
  try {
    const configuredPassword = process.env.SSR_DASHBOARD_PASSWORD ?? "";
    const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie;
    const sessionValue = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
    const authenticated = await verifySessionCookie(sessionValue, configuredPassword);
    if (!authenticated) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
  } catch (e) {
    res.status(500).json({ stage: "handler", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack : undefined });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ssr-fun-activity-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.status(200);

  try {
    for await (const chunk of streamActivityLogCsv()) res.write(chunk);
  } catch (e) {
    // Headers are already sent by the time a mid-stream failure can happen
    // (a Postgres error on a later page) -- there is no clean way to report
    // a JSON error at this point without corrupting an already-started CSV
    // download, so terminate the stream; a truncated file is a visible,
    // honest failure mode rather than a silently wrong one.
    console.error("kpis-export stream failed:", e instanceof Error ? e.message : e);
  } finally {
    res.end();
  }
}
