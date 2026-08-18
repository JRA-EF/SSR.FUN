// GET /api/ledger/export -- the SSR Ledger's CSV export (requirement 5).
// Query params:
//   cluster   required, 'devnet' | 'mainnet-beta'
//   date      exact UTC date (YYYY-MM-DD) -- mutually exclusive with from/to
//   from, to  inclusive UTC date range (YYYY-MM-DD) -- mutually exclusive with date
//   (none of the above) -- complete historical export for the cluster
// Auth: same SSR_DASHBOARD_PASSWORD session as every other internal page
// (api/ledger/_session.ts -- see that file for why this is a duplicate,
// not a shared import, of the session-verification logic).
import { isAuthenticated, type DashboardRequest } from "./_session";
import { isValidUtcDateString, normalizeDateRange } from "../../lib/ledger/csv";
import { streamLedgerEventsCsvForDate, streamLedgerEventsCsvForRange, streamLedgerEventsCsvComplete } from "../../lib/ledger/query";

interface ApiRequest extends DashboardRequest {
  url?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
  json(body: unknown): void;
}

const VALID_CLUSTERS = new Set(["devnet", "mainnet-beta"]);

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (!(await isAuthenticated(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const url = new URL(req.url ?? "", "http://internal");
    const cluster = url.searchParams.get("cluster") ?? "";
    if (!VALID_CLUSTERS.has(cluster)) {
      res.status(400).json({ error: "Missing or invalid 'cluster' query param -- must be 'devnet' or 'mainnet-beta'." });
      return;
    }

    const date = url.searchParams.get("date");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    let generator: AsyncGenerator<string>;
    let filenameSuffix: string;

    if (date) {
      if (!isValidUtcDateString(date)) {
        res.status(400).json({ error: "'date' must be YYYY-MM-DD (UTC)." });
        return;
      }
      generator = streamLedgerEventsCsvForDate(cluster, date);
      filenameSuffix = date;
    } else if (from && to) {
      const range = normalizeDateRange(from, to);
      if ("error" in range) {
        res.status(400).json({ error: range.error });
        return;
      }
      generator = streamLedgerEventsCsvForRange(cluster, range.fromDateUtc, range.toDateUtc);
      filenameSuffix = `${range.fromDateUtc}_to_${range.toDateUtc}`;
    } else if (from || to) {
      res.status(400).json({ error: "Provide both 'from' and 'to' for a date-range export, or neither for a complete export." });
      return;
    } else {
      generator = streamLedgerEventsCsvComplete(cluster);
      filenameSuffix = "complete";
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ssr-fun-ledger-${cluster}-${filenameSuffix}.csv"`);
    res.status(200);

    try {
      for await (const chunk of generator) res.write(chunk);
    } catch (e) {
      console.error("ledger export stream failed:", e instanceof Error ? e.message : e);
    } finally {
      res.end();
    }
  } catch (e) {
    res.status(500).json({ stage: "handler", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
}
