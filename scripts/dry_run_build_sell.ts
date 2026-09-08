// READ-ONLY dry exercise of api/mainnet/build-sell against live Mainnet: builds
// the unsigned transactions for a real Reserve + wallet holding its Reserve
// Tokens and prints timings and sizes. Submits NOTHING.
// Run: set -a; . ./.env.local; set +a; npx ts-node -P tests/tsconfig.json --transpile-only scripts/dry_run_build_sell.ts <reserve> <wallet> <reserveTokensToRedeemRaw>
import handler from "../api/mainnet/build-sell";

async function main() {
  const [reserve, wallet, toRedeem] = process.argv.slice(2);
  if (!reserve || !wallet || !toRedeem) throw new Error("usage: <reserve> <wallet> <reserveTokensToRedeemRaw>");
  let statusCode = 0;
  let body: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      body = b;
    },
    setHeader() {},
  };
  const t0 = Date.now();
  await handler({ method: "POST", headers: { "x-forwarded-for": "127.0.0.1" }, body: { reserve, wallet, reserveTokensToRedeem: toRedeem } } as never, res as never);
  const wall = Date.now() - t0;
  const b = body as Record<string, unknown>;
  console.log("HTTP", statusCode, "wall-clock ms", wall);
  if (statusCode !== 200) {
    console.log(JSON.stringify(b, null, 2));
    return;
  }
  console.log("mode:", b.mode, "reserveAlt:", b.reserveAlt, "altToRegister:", b.altToRegister);
  console.log("timings:", JSON.stringify(b.timings));
  const txs = b.transactions as { kind: string; mint?: string; bytes: number }[];
  console.log("transactions:", txs.length);
  for (const t of txs) console.log("  ", t.kind.padEnd(11), (t.mint ?? "").slice(0, 8).padEnd(9), t.bytes, "bytes");
  const plan = b.plan as { legs: { mint: string; action: string; entitlementRaw: string; amountInRaw: string; quotedUsdcOutRaw: string }[]; quotedUsdcOutRaw: string; walletReserveTokenRaw: string };
  console.log("walletReserveTokenRaw:", plan.walletReserveTokenRaw, "quotedUsdcOutRaw total:", plan.quotedUsdcOutRaw);
  for (const l of plan.legs) console.log("  leg", l.mint.slice(0, 8), l.action.padEnd(5), "entitlement", l.entitlementRaw, "sell", l.amountInRaw, "-> USDC", l.quotedUsdcOutRaw);
}

main().catch((e) => {
  console.error("dry run failed:", e);
  process.exit(1);
});
