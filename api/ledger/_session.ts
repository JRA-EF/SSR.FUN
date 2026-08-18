// Private (leading-underscore, matches api/devnet/_lib's convention),
// CommonJS-native session/auth helper used ONLY by api/ledger/*.ts.
//
// This is a deliberate DUPLICATE of api/kpis/_session.ts (itself a
// duplicate of lib/dashboard/session.ts + lib/road-to-mainnet/auth.ts's
// logic), not a cross-directory reuse -- api/ledger/ is its own isolated
// CommonJS project (api/ledger/package.json), same reasoning as
// api/kpis/'s own isolation from api/dashboard/: a real production
// incident (docs/project/DECISION_LOG.md's DEC-0109) traced a raw,
// try/catch-invisible platform crash to a CommonJS function synchronously
// `require()`-ing a genuine ESM module (ERR_REQUIRE_ESM). Nothing in
// api/ledger/ may import from lib/dashboard/ or lib/road-to-mainnet/, or
// from api/kpis/ or api/dashboard/, ever.
//
// SSR_DASHBOARD_PASSWORD is the same shared secret every other internal
// page already uses -- this reads the exact same env var and produces/
// verifies the exact same cookie format (ssr_dash_session,
// expiresAt.hmacHex), so a session created by /internal/status's login
// is valid here too, and vice versa.

const SESSION_COOKIE_NAME = "ssr_dash_session";

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySessionCookie(value: string | undefined, password: string): Promise<boolean> {
  if (!value || !password) return false;
  const sepIndex = value.indexOf(".");
  if (sepIndex === -1) return false;
  const expiresAtStr = value.slice(0, sepIndex);
  const sig = value.slice(sepIndex + 1);
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expectedSig = await hmacHex(password, `dash-session:${expiresAtStr}`);
  return timingSafeEqual(sig, expectedSig);
}

function parseCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface DashboardRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface DashboardResponse {
  status(code: number): DashboardResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export async function isAuthenticated(req: DashboardRequest): Promise<boolean> {
  const configuredPassword = process.env.SSR_DASHBOARD_PASSWORD ?? "";
  const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie;
  const sessionValue = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  return verifySessionCookie(sessionValue, configuredPassword);
}

export function isSameOriginRequest(req: DashboardRequest): boolean {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!origin) return true;
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function unauthorized(res: DashboardResponse) {
  res.status(401).json({ error: "Unauthorized" });
}
