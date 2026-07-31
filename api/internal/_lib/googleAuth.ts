// Server-only Google service-account authentication for the internal
// feedback tool (api/internal/feedback-submit.ts). Deliberately implemented
// with Node's built-in `crypto` module only (RS256 JWT signing), the same
// dependency-free approach lib/dashboard/session.ts already uses for its own
// HMAC signing -- avoids pulling in the full `googleapis` SDK (tens of MB)
// or even `google-auth-library` for what is otherwise a single OAuth2
// token-exchange REST call.
//
// GOOGLE_SERVICE_ACCOUNT_KEY holds the ENTIRE JSON key file Google Cloud
// generates for a service account (client_email + private_key, among other
// fields) -- never logged, never returned to a client, never imported by any
// browser-bundled file (this lives under api/, a server-only Vercel
// function directory).
import crypto from "node:crypto";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function loadServiceAccountKey(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not configured");
  const parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email or private_key");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

function base64Url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SCOPES = ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets"].join(" ");
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Cached in-memory across warm serverless invocations -- same accepted
// best-effort pattern as api/devnet/_lib/rateLimit.ts (resets on cold start,
// not shared across concurrent instances, which is fine here: worst case is
// one extra token exchange, never a correctness issue).
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

/** Returns a live, currently-valid OAuth2 access token for the service account, minting a fresh one only when the cached one is missing or within 60s of expiry. */
export async function getGoogleAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.accessToken;
  }

  const { client_email, private_key } = loadServiceAccountKey();
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: client_email, scope: SCOPES, aud: TOKEN_URL, iat, exp };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google OAuth2 token exchange failed: ${json.error_description || json.error || res.statusText}`);
  }
  cachedToken = { accessToken: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.accessToken;
}
