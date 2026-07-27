// Minimal structural types for Vercel's Node.js function (req, res) signature
// -- covers only what api/dashboard/*.ts actually uses. Deliberately not
// depending on @vercel/node: it pulls in a large build-toolchain dependency
// tree (ts-morph, undici, etc.) just for these two type shapes.

export interface DashboardRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

export interface DashboardResponse {
  status(code: number): DashboardResponse
  json(body: unknown): void
  setHeader(name: string, value: string): void
}
