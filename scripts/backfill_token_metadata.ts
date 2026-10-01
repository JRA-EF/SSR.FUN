// Backfills Metaplex Token Metadata onto every existing Reserve Token mint
// (or one Reserve) by calling the program's set_reserve_token_metadata
// instruction as a protocol admin (or as a Reserve's Manager). Reads each
// Reserve's own metadata record for the name/ticker, derives the
// standard-format token-metadata URI (packages/sdk/src/tokenMetadata.ts),
// skips Reserves whose on-chain metadata already matches, and reports.
//
// Usage (from the repo root):
//   npx ts-node -P scripts/tsconfig.json scripts/backfill_token_metadata.ts --cluster devnet --dry-run
//   npx ts-node -P scripts/tsconfig.json scripts/backfill_token_metadata.ts --cluster mainnet --keypair ~/.config/solana/mainnet-deployer.json
//
// Flags:
//   --cluster devnet|mainnet   (required)
//   --keypair <path>           signer; defaults to ~/.config/solana/<cluster>-deployer.json
//   --reserve <address>        only this Reserve
//   --rpc <url>                RPC override; otherwise .env.local's HELIUS_<CLUSTER>_RPC_URL, else the public endpoint
//   --origin <https://host>    host for the token-metadata URI (Mainnet defaults to https://ssr.fun)
//   --dry-run                  build and print, send nothing
//
// The signer pays ~0.0056 SOL rent per Reserve on first creation plus fees.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  buildReadOnlyProgram,
  discoverAllReserves,
  resolveReserveMetadata,
  findDelegate,
  fetchReserveTokenMetadata,
  buildSetReserveTokenMetadataInstruction,
  fitTokenMetadataName,
  fitTokenMetadataSymbol,
  tokenMetadataUriFromReserveMetadataUri,
  tokenMetadataOriginFor,
  validateTokenMetadataFields,
} from "../packages/sdk/src";

// Program IDs per cluster -- see Anchor.toml ([programs.devnet] / [programs.mainnet]).
const PROGRAM_IDS = {
  devnet: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
  mainnet: "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9",
} as const;

type Cluster = keyof typeof PROGRAM_IDS;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main() {
  const cluster = arg("--cluster") as Cluster | undefined;
  if (!cluster || !(cluster in PROGRAM_IDS)) throw new Error("--cluster devnet|mainnet is required");
  const dryRun = process.argv.includes("--dry-run");
  const only = arg("--reserve");
  const env = loadEnvLocal();
  const rpc =
    arg("--rpc") ??
    env[cluster === "mainnet" ? "HELIUS_MAINNET_RPC_URL" : "HELIUS_DEVNET_RPC_URL"] ??
    (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
  const keypairPath = arg("--keypair") ?? path.join(os.homedir(), ".config", "solana", `${cluster}-deployer.json`);
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
  const originOverride = arg("--origin") ?? tokenMetadataOriginFor(cluster, undefined);
  const programId = new PublicKey(PROGRAM_IDS[cluster]);
  const connection = new Connection(rpc, "confirmed");
  const program = buildReadOnlyProgram(connection) as any;

  console.log(`cluster=${cluster} program=${programId.toBase58()} signer=${signer.publicKey.toBase58()} rpc=${rpc.replace(/api-key=[^&]+/, "api-key=***")} dryRun=${dryRun}`);
  const balance = await connection.getBalance(signer.publicKey);
  console.log(`signer balance: ${(balance / 1e9).toFixed(4)} SOL`);

  const { reserves, issues } = await discoverAllReserves(connection, programId, []);
  if (issues.length) console.log(`discovery issues: ${issues.length}`);
  const targets = only ? reserves.filter((r) => r.reserve === only) : reserves;
  if (only && targets.length === 0) throw new Error(`Reserve ${only} not found`);
  console.log(`${targets.length} Reserve(s) to check`);

  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (const r of targets) {
    const mint = new PublicKey(r.reserveTokenMint);
    const label = `#${r.reserveId} ${r.reserve.slice(0, 6)}…`;
    try {
      const meta = await resolveReserveMetadata(r.metadataUri);
      if (!meta) {
        console.log(`${label}: SKIP -- metadata record unresolved (${r.metadataUri.slice(0, 60)})`);
        skipped++;
        continue;
      }
      const uri = tokenMetadataUriFromReserveMetadataUri(r.metadataUri, r.reserve, originOverride);
      if (!uri) {
        console.log(`${label}: SKIP -- metadata URI is not this app's record (${r.metadataUri.slice(0, 60)})`);
        skipped++;
        continue;
      }
      const fields = { name: fitTokenMetadataName(meta.name), symbol: fitTokenMetadataSymbol(meta.ticker), uri };
      validateTokenMetadataFields(fields);
      const existing = await fetchReserveTokenMetadata(connection, mint);
      if (existing && existing.name === fields.name && existing.symbol === fields.symbol && existing.uri === fields.uri) {
        console.log(`${label}: OK -- already published as "${existing.name}" (${existing.symbol})`);
        skipped++;
        continue;
      }
      console.log(`${label}: ${existing ? "UPDATE" : "CREATE"} "${fields.name}" (${fields.symbol}) -> ${fields.uri}`);
      if (dryRun) continue;
      const [delegate] = findDelegate(new PublicKey(r.reserve), signer.publicKey, programId);
      const ix = await buildSetReserveTokenMetadataInstruction(program, programId, new PublicKey(r.reserve), mint, signer.publicKey, delegate, fields);
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [signer], { commitment: "confirmed" });
      console.log(`${label}: sent ${sig}`);
      const after = await fetchReserveTokenMetadata(connection, mint);
      if (!after || after.name !== fields.name || after.symbol !== fields.symbol) throw new Error("post-send read-back does not match");
      if (existing) updated++;
      else created++;
    } catch (e) {
      failed++;
      console.log(`${label}: FAILED -- ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`done: created=${created} updated=${updated} skipped=${skipped} failed=${failed}${dryRun ? " (dry run: nothing sent)" : ""}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
