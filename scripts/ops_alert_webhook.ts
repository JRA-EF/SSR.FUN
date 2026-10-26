// DEC-0261: create (or update) the Helius webhook that sends every FAILED
// transaction touching the SSR program to /api/mainnet/alert-helius.
// Idempotent: reuses the webhook already pointing at the same URL.
//
// usage: HELIUS_API_KEY=... HELIUS_ALERT_WEBHOOK_SECRET=... npx ts-node scripts/ops_alert_webhook.ts [https://ssr.fun]
// The secret must equal the HELIUS_ALERT_WEBHOOK_SECRET set on that Vercel project.
const PROGRAM = "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9";

async function main() {
  const key = process.env.HELIUS_API_KEY;
  const secret = process.env.HELIUS_ALERT_WEBHOOK_SECRET;
  if (!key || !secret) throw new Error("Set HELIUS_API_KEY and HELIUS_ALERT_WEBHOOK_SECRET.");
  const url = `${(process.argv[2] ?? "https://ssr.fun").replace(/\/$/, "")}/api/mainnet/alert-helius`;
  const api = `https://api-mainnet.helius-rpc.com/v0/webhooks`;
  const body = { webhookURL: url, transactionTypes: ["ANY"], accountAddresses: [PROGRAM], webhookType: "raw", txnStatus: "failed", authHeader: secret };
  const existing = (await (await fetch(`${api}?api-key=${key}`)).json()) as { webhookID: string; webhookURL: string }[];
  const match = Array.isArray(existing) ? existing.find((w) => w.webhookURL === url) : undefined;
  const r = await fetch(match ? `${api}/${match.webhookID}?api-key=${key}` : `${api}?api-key=${key}`, {
    method: match ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = (await r.json()) as { webhookID?: string; error?: string };
  if (!r.ok) throw new Error(`Helius ${r.status}: ${JSON.stringify(out)}`);
  console.log(`${match ? "updated" : "created"} webhook ${out.webhookID} -> ${url} (failed transactions on ${PROGRAM})`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
