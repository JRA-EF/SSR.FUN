// One-time (but re-runnable/idempotent-checked) script that creates the real
// DevNet SPL settlement-token mint for Phase B -- see
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model" for the full design this implements exactly.
//
// Identity: "SSR Test USD" / devUSDC, 6 decimals, classic SPL Token program,
// mint authority AND freeze authority both set to the existing DevNet-only
// manager/swap-authority keypair (devnet-fixtures/manager-keypair.json,
// pubkey Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj) -- a deliberate reuse
// decision (documented in the plan doc), not an oversight. No on-chain
// metadata is created (matches the existing mintX/Y/Z convention -- see the
// plan doc's "no Metaplex integration" finding); the mint ADDRESS is and
// remains canonical identity.
//
// SAFETY: this sends REAL, state-changing DevNet transactions (rent-exempt
// mint-account creation + InitializeMint). It refuses to run against
// anything but Solana DevNet (live genesis-hash check) and refuses to
// create a second mint if devnet-fixtures/devusdc-mint.json already records
// one (idempotent re-run safety).
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createInitializeMint2Instruction, getMint, getMinimumBalanceForRentExemptMint, MINT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.join(__dirname, "..", "devnet-fixtures");
const RECORD_FILE = path.join(FIXTURES_DIR, "devusdc-mint.json");
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RPC_URL = "https://api.devnet.solana.com";
const DECIMALS = 6;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      const is429 = msg.includes("429") || msg.includes("Too Many Requests");
      if (!is429 || attempt >= delays.length) throw e;
      const delay = delays[attempt];
      console.log(`  [${label}] rate-limited, retrying in ${delay}ms (attempt ${attempt + 1})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function loadManagerKeypair(): Keypair {
  const file = path.join(FIXTURES_DIR, "manager-keypair.json");
  const secret = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  console.log("=".repeat(78));
  console.log("Phase B -- devUSDC ('SSR Test USD') mint creation");
  console.log("REAL, state-changing Solana DevNet transaction. Read the preview below.");
  console.log("=".repeat(78));

  if (fs.existsSync(RECORD_FILE)) {
    const existing = JSON.parse(fs.readFileSync(RECORD_FILE, "utf8"));
    console.log(`\nA devUSDC mint is already recorded at ${RECORD_FILE}: ${existing.mint}`);
    console.log("Refusing to create a second mint. Delete that file first if you intend to replace it (not recommended once a faucet has issued tokens against it).");
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const genesisHash = await withRetry("getGenesisHash", () => connection.getGenesisHash());
  console.log(`\nGenesis hash: ${genesisHash} (${genesisHash === DEVNET_GENESIS_HASH ? "confirmed DevNet" : "NOT DevNet -- ABORTING"})`);
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing to create a mint: connected cluster's genesis hash (${genesisHash}) does not match known DevNet genesis (${DEVNET_GENESIS_HASH}).`);
  }

  const manager = loadManagerKeypair();
  const balance = await withRetry("getBalance", () => connection.getBalance(manager.publicKey));
  console.log(`\nAuthority (fee payer, mint authority, freeze authority): ${manager.publicKey.toBase58()}`);
  console.log(`Current balance: ${(balance / 1e9).toFixed(5)} SOL`);

  const mintKeypair = Keypair.generate();
  const rentExemptLamports = await withRetry("getMinimumBalanceForRentExemptMint", () => getMinimumBalanceForRentExemptMint(connection));
  console.log(`\nPreview:`);
  console.log(`  New mint address (freshly generated): ${mintKeypair.publicKey.toBase58()}`);
  console.log(`  Decimals: ${DECIMALS}`);
  console.log(`  Mint authority: ${manager.publicKey.toBase58()}`);
  console.log(`  Freeze authority: ${manager.publicKey.toBase58()} (kept, defense-in-depth -- see plan doc)`);
  console.log(`  Token program: ${TOKEN_PROGRAM_ID.toBase58()} (classic SPL Token)`);
  console.log(`  Initial supply: 0 (mint-on-demand only, via the faucet)`);
  console.log(`  Rent-exempt cost: ${(rentExemptLamports / 1e9).toFixed(5)} SOL (one-time, locked in the mint account, not a fee)`);
  if (balance < rentExemptLamports + 10_000) {
    throw new Error(`Insufficient balance: have ${balance} lamports, need at least ${rentExemptLamports + 10_000} (rent + fee margin). Fund ${manager.publicKey.toBase58()} before retrying.`);
  }

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: manager.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports: rentExemptLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mintKeypair.publicKey, DECIMALS, manager.publicKey, manager.publicKey, TOKEN_PROGRAM_ID),
  );

  console.log("\nSubmitting real DevNet transaction (create account + InitializeMint)...");
  const signature = await withRetry("sendAndConfirmTransaction", () => sendAndConfirmTransaction(connection, tx, [manager, mintKeypair]));
  console.log(`Confirmed. Signature: ${signature}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

  console.log("\nVerifying the created mint by reading it back from chain (not assuming the above succeeded as expected)...");
  const mintInfo = await withRetry("getMint", () => getMint(connection, mintKeypair.publicKey));
  const accountInfo = await withRetry("getAccountInfo", () => connection.getAccountInfo(mintKeypair.publicKey));
  console.log(`  Owner program: ${accountInfo?.owner.toBase58()} (expected ${TOKEN_PROGRAM_ID.toBase58()}) -- ${accountInfo?.owner.equals(TOKEN_PROGRAM_ID) ? "MATCH" : "MISMATCH -- INVESTIGATE"}`);
  console.log(`  Decimals: ${mintInfo.decimals} (expected ${DECIMALS}) -- ${mintInfo.decimals === DECIMALS ? "MATCH" : "MISMATCH -- INVESTIGATE"}`);
  console.log(`  Mint authority: ${mintInfo.mintAuthority?.toBase58()} -- ${mintInfo.mintAuthority?.equals(manager.publicKey) ? "MATCH" : "MISMATCH -- INVESTIGATE"}`);
  console.log(`  Freeze authority: ${mintInfo.freezeAuthority?.toBase58()} -- ${mintInfo.freezeAuthority?.equals(manager.publicKey) ? "MATCH" : "MISMATCH -- INVESTIGATE"}`);
  console.log(`  Supply: ${mintInfo.supply.toString()} (expected 0) -- ${mintInfo.supply === 0n ? "MATCH" : "MISMATCH -- INVESTIGATE"}`);

  const record = {
    mint: mintKeypair.publicKey.toBase58(),
    decimals: DECIMALS,
    symbol: "devUSDC",
    name: "SSR Test USD",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    mintAuthority: manager.publicKey.toBase58(),
    freezeAuthority: manager.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: signature,
    network: "devnet",
    note: "No on-chain Metaplex metadata -- name/symbol here are an off-chain convenience record, matching this repo's existing mintX/Y/Z convention. The mint address above is canonical identity.",
  };
  fs.writeFileSync(RECORD_FILE, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nRecorded to ${RECORD_FILE} (gitignored, matches the devnet-fixtures/ convention).`);
  console.log("\nNext: register this mint's PUBLIC address (never the keypair) in packages/sdk so the frontend/faucet can use it.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
