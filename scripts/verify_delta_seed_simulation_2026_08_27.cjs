// Read-only Mainnet reproduction of the DELTA seed failure (DEC-0166
// investigation). Takes the EXACT failed transaction
// 2zFpPZ5yX9SpJrDWkbmNdzjp9gWMJgP5ZKmezg9ascEMV1J6H793LK2ch1SyRHbWBGyGzqbgNpSCDxrvHtW2P65D
// (which died at "exceeded CUs meter": consumed 202,850 of the default
// ~200k budget -- no setComputeUnitLimit instruction was ever sent),
// re-assembles the identical message with ONLY a raised compute-unit
// limit prepended, and SIMULATES it (sigVerify: false) against current
// Mainnet state. Never submits anything; never spends anything.
//
// Answers, empirically: (1) does the identical 10-asset seed succeed when
// given a real compute budget, and (2) what is its true CU requirement.
//
// Usage: node scripts/verify_delta_seed_simulation_2026_08_27.cjs
// Requires HELIUS_MAINNET_RPC_URL in .env.local (read-only usage).
const fs = require("node:fs");
const path = require("node:path");
const {
  Connection,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const FAILED_SIGNATURE =
  "2zFpPZ5yX9SpJrDWkbmNdzjp9gWMJgP5ZKmezg9ascEMV1J6H793LK2ch1SyRHbWBGyGzqbgNpSCDxrvHtW2P65D";
// Default: Solana's per-transaction maximum (the diagnosis run). Override
// via CU_LIMIT to prove a specific production limit is sufficient -- e.g.
// CU_LIMIT=500000 matches seedComputeUnitLimit(10) in createReserveClient.ts.
const CU_CEILING = Number(process.env.CU_LIMIT || 1_400_000);

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

async function main() {
  loadEnvLocal();
  const rpc = process.env.HELIUS_MAINNET_RPC_URL;
  if (!rpc) throw new Error("HELIUS_MAINNET_RPC_URL is not set (see .env.local).");
  const connection = new Connection(rpc, "confirmed");

  const failed = await connection.getTransaction(FAILED_SIGNATURE, {
    maxSupportedTransactionVersion: 0,
  });
  if (!failed) throw new Error("Failed transaction not found on this RPC.");
  const msg = failed.transaction.message;

  // Resolve the transaction's own lookup table so the message decompiles.
  const lookups = msg.addressTableLookups ?? [];
  const altAccounts = [];
  for (const l of lookups) {
    const resp = await connection.getAddressLookupTable(l.accountKey);
    if (!resp.value) throw new Error(`Lookup table ${l.accountKey.toBase58()} not found.`);
    altAccounts.push(resp.value);
  }

  const decompiled = TransactionMessage.decompile(msg, { addressLookupTableAccounts: altAccounts });
  console.log(`original instructions: ${decompiled.instructions.length} (expect 2: setComputeUnitPrice + seed_reserve)`);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const rebuilt = new TransactionMessage({
    payerKey: decompiled.payerKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CEILING }), ...decompiled.instructions],
  }).compileToV0Message(altAccounts);
  const vtx = new VersionedTransaction(rebuilt);

  const sim = await connection.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });

  console.log("err:", JSON.stringify(sim.value.err));
  console.log("unitsConsumed:", sim.value.unitsConsumed);
  console.log("--- logs ---");
  for (const l of sim.value.logs ?? []) console.log(l);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
