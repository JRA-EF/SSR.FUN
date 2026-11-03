// GET /api/mainnet/campaign-leaderboard -- PUBLIC (outside the BETA gate, see
// middleware.ts) Beta Campaign standings for ssr.fun/leaderboard (DEC-0279).
// Reads Postgres only (lib/campaign/leaderboard.ts); edge-cached for a minute
// so a busy page shares one origin read.
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { computeLeaderboard } from "../../lib/campaign/leaderboard";

export default async function handler(req: ApiRequest, res: ApiResponse & { setHeader(name: string, value: string): void }) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const board = await computeLeaderboard();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(board);
  } catch (e) {
    console.error("[campaign-leaderboard] failed:", e instanceof Error ? e.message : e);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "The leaderboard is temporarily unavailable." });
  }
}
