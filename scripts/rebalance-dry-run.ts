// DEC-0250: READ-ONLY dry run of the rebalance builder against a live Mainnet
// Reserve at its current on-chain targets: plans, quotes Jupiter, compiles
// every transaction and prints them. Signs with a throwaway key in place of
// the quote signer and never submits or simulates. Usage:
//   JUPITER_API_BASE=https://lite-api.jup.ag npx tsx scripts/rebalance-dry-run.ts
import fs from "node:fs";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildReadOnlyProgram, findReserveAsset } from "@ssr/sdk";
import { buildRebalanceTransactions } from "../lib/mainnet/buildRebalance";
import { buildJupiterSwapInstructionsWithRetry, fetchJupiterQuoteWithRetry } from "../lib/mainnet/jupiter";
const env = Object.fromEntries(fs.readFileSync("C:/Users/JRA DEVNET/Projects/SSR.FUN/.env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const PID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const RESERVE = new PublicKey("CfvFdbUJk9zvNpceRqWDoUp9bYWqoLMzcEugzkKUM3ty");
const SIGNER = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
(async () => {
  const connection = new Connection(env.HELIUS_MAINNET_RPC_URL, "confirmed");
  const program = buildReadOnlyProgram(connection) as any;
  const candidates = ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", "So11111111111111111111111111111111111111112", "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];
  const accts = await program.account.reserveAsset.fetchMultiple(candidates.map((m) => findReserveAsset(RESERVE, new PublicKey(m), PID)[0]));
  const rows = candidates.map((m, i) => ({ m, a: accts[i] as any })).filter((r) => r.a).sort((x, y) => x.a.orderIndex - y.a.orderIndex);
  const targets = rows.map((r) => ({ mint: r.m, targetBps: Number(r.a.targetWeightBps) }));
  console.log("on-chain targets:", targets.map((t: any) => `${t.mint.slice(-5)}=${t.targetBps}`).join(" "));
  const prices = async (mints: string[]) => { const j: any = await fetch("https://lite-api.jup.ag/price/v3?ids=" + mints.join(",")).then((r) => r.json()); return new Map(mints.map((m) => [m, { usdPrice: j[m]?.usdPrice ?? null }])); };
  const r = await buildRebalanceTransactions({ connection, program, ssrProgramId: PID, lookupReserveAlt: async () => null, fetchPrices: prices, feeQuoteSigner: Keypair.generate(),
    jupiterQuote: (p) => fetchJupiterQuoteWithRetry({ ...p, apiKey: "" }), jupiterInstructions: (q, u) => buildJupiterSwapInstructionsWithRetry({ quote: q, userPublicKey: u, apiKey: "", dynamicSlippage: false }) }, { reserve: RESERVE, signer: SIGNER, targets });
  console.log("total $", r.totalUsd.toFixed(4));
  for (const row of r.rows) console.log("  ", row.mint.slice(-5), "now $" + row.valueUsd.toFixed(3), "target $" + row.targetUsd.toFixed(3), row.targetBps);
  for (const t of r.transactions) console.log(t.kind, t.bytes + "B", t.sellMint?.slice(-5) ?? "", "->", t.buyMint?.slice(-5) ?? "", t.amountInRaw ?? "", "minOut", t.minOutRaw ?? "", "exp", t.expectedOutRaw ?? "", t.route?.join(">") ?? "", t.removes?.map((m) => m.slice(-5)).join(",") ?? "");
  for (const s of r.skipped) console.log("SKIPPED", s.sellMint.slice(-5), "->", s.buyMint.slice(-5), s.reason);
  for (const t of r.transactions) { const tx = VersionedTransaction.deserialize(Buffer.from(t.base64, "base64")); const req = tx.message.header.numRequiredSignatures; console.log("  sigs required", req, "accounts", tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((s, l) => s + l.writableIndexes.length + l.readonlyIndexes.length, 0)); }
})().catch((e) => { console.error("ERR", String(e?.message ?? e).replace(/api-key=[^&\s]+/g, "***")); process.exit(1); });
