// GET /r/<address> (rewritten here by vercel.json) -- the crawlable Reserve
// share page (DEC-0200).
//
// Why a server route at all: the app is a hash router, so a crawler or a
// social-card fetcher asking for ssr.fun/#/dtr/mainnet-beta-24 sends the
// server only "/" -- the fragment never leaves the browser. Renaming that URL
// could never produce a social card or an indexable page. This route is a real
// path the server sees, renders the Reserve's own title/description/image as
// meta tags, and then moves a human visitor into the hash app.
//
// The address IS the identity: the pool (Reserve) account is canonical, and
// the Reserve Token mint 301s to it, so a shared link works whichever address
// someone copied. No slug table, no collisions, no backfill.
//
// Data comes from the warm-cache snapshot the homepage already uses, so this
// costs one indexed row read and no RPC.
import { readReserveSnapshot } from "../../lib/reserve-warm-cache/db";
import {
  buildSharePageData,
  isPlausibleAddress,
  renderSharePage,
  renderShareNotFound,
  resolveShareAddress,
  type ShareSnapshot,
} from "../../lib/share/resolveReserve";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  send?(body: string): void;
  json(body: unknown): void;
  end?(): void;
}

const CLUSTER = "mainnet-beta";

function originOf(req: ApiRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers["x-forwarded-host"] as string) || (req.headers.host as string) || "ssr.fun";
  return `${proto}://${host}`;
}

function html(res: ApiResponse, status: number, body: string, cacheSeconds: number): void {
  res.setHeader?.("Content-Type", "text/html; charset=utf-8");
  res.setHeader?.("Cache-Control", `public, max-age=60, s-maxage=${cacheSeconds}, stale-while-revalidate=600`);
  res.status(status);
  if (res.send) res.send(body);
  else res.json(body);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const origin = originOf(req);
  const url = new URL(req.url ?? "", "http://internal");
  const address = (url.searchParams.get("address") ?? "").trim();

  if (!isPlausibleAddress(address)) {
    html(res, 404, renderShareNotFound(origin), 60);
    return;
  }

  let snapshot: ShareSnapshot | null = null;
  try {
    const row = await readReserveSnapshot(CLUSTER);
    snapshot = (row?.snapshot as ShareSnapshot) ?? null;
  } catch {
    snapshot = null;
  }
  if (!snapshot) {
    // Never invent a card from nothing; a transient miss is a 503 a crawler
    // will retry, not a wrong page cached for a day.
    res.setHeader?.("Cache-Control", "no-store");
    res.status(503).json({ error: "Reserve data is not available right now." });
    return;
  }

  const resolved = resolveShareAddress(snapshot, address);
  if (resolved.kind === "not-found") {
    html(res, 404, renderShareNotFound(origin), 60);
    return;
  }
  if (resolved.kind === "redirect") {
    res.setHeader?.("Location", `${origin}/r/${resolved.to}`);
    res.setHeader?.("Cache-Control", "public, max-age=3600");
    res.status(301);
    res.end?.();
    return;
  }

  const metadata = snapshot.metadataByReserve?.[resolved.reserve.reserveId] ?? null;
  html(res, 200, renderSharePage(buildSharePageData(origin, resolved.reserve, metadata)), 300);
}
