// Minimal, framework-agnostic request/response shapes shared by every
// api/devnet/*.ts serverless function (Vercel's Node runtime handler
// signature is structurally compatible with both). Centralized so Phase B's
// new endpoints and the pre-existing swap-sign.ts/mint-test-assets.ts share
// one definition instead of four near-identical copies.
export interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export function parseJsonBody(req: ApiRequest): Record<string, unknown> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}
