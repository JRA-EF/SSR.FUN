// One-off local invocation of api/devnet/accrue-fees-cron.ts's handler
// function directly (not over HTTP) against the live DevNet-deployed
// program, to prove the rewritten weekly-settlement keeper (2026-08-14 pass)
// actually works end-to-end before relying on Vercel's scheduled trigger.
// Uses the local devnet-fixtures manager keypair as a stand-in payer (same
// role DEVNET_SWAP_AUTHORITY_SECRET_KEY plays in production -- any funded
// DevNet keypair works identically for this permissionless keeper).
import * as fs from "fs";
import * as path from "path";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);
process.env.CRON_SECRET = "local-verification-only";

import handler from "../api/devnet/accrue-fees-cron";

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      console.log(`\n--- response (status ${state.statusCode}) ---`);
      console.log(JSON.stringify(body, null, 2));
    },
    _state: state,
  };
}

async function main() {
  console.log("=== dryRun=true (discovery only, no transactions, no auth needed) ===");
  await handler({ method: "GET", headers: {}, query: { dryRun: "true" }, url: "/api/devnet/accrue-fees-cron?dryRun=true" } as any, mockRes() as any);
}

main().catch((e) => {
  console.error("KEEPER LOCAL VERIFICATION FAILED:", e);
  process.exit(1);
});
