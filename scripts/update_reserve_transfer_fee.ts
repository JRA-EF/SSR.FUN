// Changes the Token-2022 transfer fee on every fee-carrying Reserve Token mint
// (or one Reserve) by calling update_transfer_fee as a Protocol Admin
// (DEC-0229). The rate is stored per mint, so a protocol-wide change is one
// instruction per mint; this batches several per transaction. Token-2022
// applies each new rate two epochs (~4-5 days) after it is set. The program
// refuses anything above MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS (25 = 0.25%).
//
// Classic SPL Token Reserves (created before DEC-0229) carry no fee and are
// skipped; so is any mint whose pending rate already equals --bps.
//
// Usage (from the repo root):
//   npx ts-node -P scripts/tsconfig.json scripts/update_reserve_transfer_fee.ts --cluster mainnet --bps 25 --dry-run
//   npx ts-node -P scripts/tsconfig.json scripts/update_reserve_transfer_fee.ts --cluster mainnet --bps 25 --keypair ~/.config/solana/mainnet-deployer.json
//
// Flags:
//   --cluster devnet|mainnet   (required)
//   --bps <0..25>              (required) new rate in basis points
//   --keypair <path>           Protocol Admin signer; defaults to ~/.config/solana/<cluster>-deployer.json
//   --reserve <address>        only this Reserve
//   --program <id>             program id override (throwaway DevNet test deploys)
//   --rpc <url>                RPC override; otherwise .env.local's HELIUS_<CLUSTER>_RPC_URL, else the public endpoint
//   --dry-run                  print the plan, send nothing
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import {
  buildUpdateTransferFeeInstruction,
  findProtocolConfig,
  findReserve,
  findReserveTokenMint,
  MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS,
} from "../packages/sdk/src";
import idl from "../packages/sdk/idl/ssr_protocol.json";

const PROGRAM_IDS = {
  devnet: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
  mainnet: "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9",
} as const;
type Cluster = keyof typeof PROGRAM_IDS;

/** update_transfer_fee is small; 8 per transaction stays well inside the size limit. */
const PER_TX = 8;

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
  const bps = Number(arg("--bps"));
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS) throw new Error(`--bps must be a whole number from 0 to ${MAX_RESERVE_TOKEN_TRANSFER_FEE_BPS}`);
  const dryRun = process.argv.includes("--dry-run");
  const only = arg("--reserve");
  const env = loadEnvLocal();
  const rpc =
    arg("--rpc") ??
    env[cluster === "mainnet" ? "HELIUS_MAINNET_RPC_URL" : "HELIUS_DEVNET_RPC_URL"] ??
    (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
  const keypairPath = arg("--keypair") ?? path.join(os.homedir(), ".config", "solana", `${cluster}-deployer.json`);
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
  const programId = new PublicKey(arg("--program") ?? PROGRAM_IDS[cluster]);
  const connection = new Connection(rpc, "confirmed");
  // IDL address overridden so --program (a throwaway DevNet deploy) builds against the right id.
  const program = new Program({ ...(idl as any), address: programId.toBase58() }, new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" })) as any;

  console.log(`cluster=${cluster} program=${programId.toBase58()} signer=${signer.publicKey.toBase58()} rpc=${rpc.replace(/api-key=[^&]+/, "api-key=***")} bps=${bps} dryRun=${dryRun}`);

  const config = await program.account.protocolConfig.fetch(findProtocolConfig(programId)[0]);
  const admins = [config.authority.toBase58(), config.admin2.toBase58()];
  if (!admins.includes(signer.publicKey.toBase58())) throw new Error(`Signer is not a Protocol Admin (${admins.join(", ")}).`);

  const reserves = only
    ? [new PublicKey(only)]
    : Array.from({ length: Number(config.reserveCount.toString()) }, (_, i) => findReserve(BigInt(i), programId)[0]);
  const mints = reserves.map((r) => findReserveTokenMint(r, programId)[0]);
  const infos: Awaited<ReturnType<typeof connection.getMultipleAccountsInfo>> = [];
  for (let i = 0; i < mints.length; i += 100) infos.push(...(await connection.getMultipleAccountsInfo(mints.slice(i, i + 100))));

  const todo: { reserve: PublicKey; mint: PublicKey; from: number }[] = [];
  reserves.forEach((reserve, i) => {
    const info = infos[i];
    if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return; // classic or closed: no fee
    const fee = getTransferFeeConfig(unpackMint(mints[i], info, TOKEN_2022_PROGRAM_ID));
    if (!fee) return;
    const pending = fee.newerTransferFee.transferFeeBasisPoints;
    if (pending === bps) {
      console.log(`skip ${reserve.toBase58()} -- already ${bps} bps`);
      return;
    }
    todo.push({ reserve, mint: mints[i], from: pending });
  });
  console.log(`${todo.length} mint(s) to change to ${bps} bps`);
  for (const t of todo) console.log(`  ${t.reserve.toBase58()} mint ${t.mint.toBase58()}: ${t.from} -> ${bps} bps`);
  if (dryRun || todo.length === 0) return;

  for (let i = 0; i < todo.length; i += PER_TX) {
    const tx = new Transaction();
    for (const t of todo.slice(i, i + PER_TX)) {
      tx.add(await buildUpdateTransferFeeInstruction({ program, programId, reserve: t.reserve, authority: signer.publicKey, newTransferFeeBps: bps }));
    }
    const sig = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
    console.log(`sent ${tx.instructions.length} update(s): ${sig}`);
  }
  console.log("Done. Each new rate applies two epochs after its transaction.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
