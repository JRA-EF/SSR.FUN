// Live DevNet verification of two bugs reported together on a real Reserve
// ("Unnamed Reserve (#57)" / "RSV57", a delegate added at creation time
// never appearing on the Manager Dashboard) -- see
// docs/project/DECISION_LOG.md's entry for this fix.
//
// PART A -- confirms an "Additional Manager" entered during Reserve
// creation now genuinely becomes a real, on-chain, restricted Delegate
// account in the SAME create-and-register transaction (previously silently
// discarded -- createReserveOnChain had no parameter for it at all).
//
// PART B -- confirms a freshly created Reserve's metadataUri (the
// permanent-URL convention from the MetadataUriTooLong fix) now correctly
// resolves back to its real name/ticker via resolveReserveMetadata,
// instead of falling back to "Unnamed Reserve (#N)".
//
// Both parts go through the exact real client code CreateDTR.tsx calls --
// no mocking of on-chain behavior, real Postgres write for the metadata
// upload (via the real api/devnet/reserve-metadata.ts handler, in-process,
// same technique scripts/verify_e2e_fresh_reserve.ts uses for
// mint-test-assets/swap-sign).
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

function loadEnvLocal() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (run `vercel env pull .env.local` first).");
  process.exit(1);
}

import reserveMetadataHandler from "../api/devnet/reserve-metadata";
import { buildReadOnlyProgram, findDelegate, resolveReserveMetadata, fetchReserveOnChain, DEVNET_FIXTURES } from "../packages/sdk/src";
import { createReserveOnChain, uploadReserveMetadata, ADDITIONAL_MANAGER_PERMISSIONS } from "../src/merge/lib/createReserveClient";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const PRODUCTION_ORIGIN = "https://strategic-super-reserve.fun";

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    setHeader() {},
    json(body: unknown) {
      state.body = body;
    },
    _state: state,
  };
}

const realFetch = global.fetch;
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
  if (url.includes("/api/devnet/reserve-metadata")) {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const req = { method, headers: {}, body, url: url.replace(PRODUCTION_ORIGIN, "") };
    const res = mockRes();
    await reserveMetadataHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode, json: async () => res._state.body } as Response;
  }
  return realFetch(url as any, init);
}) as typeof fetch;

function fakeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  } as any;
}

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync("C:\\Users\\JRA DEVNET\\.config\\solana\\devnet-deployer.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const creator = Keypair.generate();
  const additionalManager = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Creator pubkey:", creator.publicKey.toBase58());
  console.log("Additional manager pubkey (never funded/connected -- must still become a real delegate):", additionalManager.publicKey.toBase58());

  const metadataInput = {
    name: "Multi-Manager Test Reserve",
    ticker: "MMTR",
    description: "Verifies additional managers and metadata resolution together.",
    category: "DeFi",
    buyTaxPct: 0,
    sellTaxPct: 0,
  };
  console.log("\nUploading Reserve metadata via the real api/devnet/reserve-metadata.ts handler...");
  const uploadedUri = await uploadReserveMetadata(PRODUCTION_ORIGIN, metadataInput);
  console.log("Uploaded metadataUri:", uploadedUri);

  const mockX = DEVNET_FIXTURES.mints.mintX;
  const assets = [{ mint: mockX.address, weightBps: 10_000, seedWeightFraction: 1, decimals: mockX.decimals }];

  console.log("\nCalling the real createReserveOnChain WITH additionalManagers -- the exact function CreateDTR.tsx calls...");
  const result = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creator),
    metadataUri: uploadedUri,
    mintFeeBps: 50,
    tvlFeeBps: 100,
    feeDestination: creator.publicKey,
    additionalManagers: [additionalManager.publicKey.toBase58()],
    assets,
    seedTotalUsd: 2,
    onProgress: (step) => console.log("  step:", step),
  });
  console.log("\nReserve created:");
  console.log("  reserve:", result.reserve);
  console.log("  reserveId:", result.reserveId);
  console.log("  create-and-register signature:", result.transactions.createAndRegister);

  // ============================================================
  // PART A -- the additional manager must be a REAL on-chain delegate.
  // ============================================================
  console.log("\n=== PART A: verifying the additional manager is a real on-chain Delegate ===");
  const program = buildReadOnlyProgram(connection) as any;
  const [delegatePda] = findDelegate(new PublicKey(result.reserve), additionalManager.publicKey, programId);
  console.log("Expected delegate PDA:", delegatePda.toBase58());
  const delegateAccount = await program.account.delegate.fetchNullable(delegatePda);
  if (!delegateAccount) {
    console.error("PART A FAILED: no Delegate account exists on-chain for the additional manager.");
    process.exit(1);
  }
  console.log("Delegate account found on-chain:");
  console.log("  wallet:", delegateAccount.wallet.toBase58());
  console.log("  permissions:", delegateAccount.permissions, "(expected:", ADDITIONAL_MANAGER_PERMISSIONS, ")");
  console.log("  restricted:", delegateAccount.restricted, "(expected: true)");
  const partACorrect =
    delegateAccount.wallet.toBase58() === additionalManager.publicKey.toBase58() &&
    delegateAccount.permissions === ADDITIONAL_MANAGER_PERMISSIONS &&
    delegateAccount.restricted === true;
  if (!partACorrect) {
    console.error("PART A FAILED: delegate account exists but fields don't match expectations.");
    process.exit(1);
  }
  console.log("PART A CONFIRMED: the additional manager is a real, correctly-permissioned, restricted on-chain delegate.");

  // ============================================================
  // PART B -- the Reserve's metadata must resolve to its real name/ticker.
  // ============================================================
  console.log("\n=== PART B: verifying the Reserve's metadataUri resolves to its real name/ticker ===");
  const onChain = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), [new PublicKey(mockX.address)]);
  console.log("On-chain metadata_uri:", onChain?.metadataUri);
  const resolved = await resolveReserveMetadata(onChain?.metadataUri ?? "");
  console.log("Resolved metadata:", resolved);
  const partBCorrect = resolved?.name === metadataInput.name && resolved?.ticker === metadataInput.ticker;
  if (!partBCorrect) {
    console.error("PART B FAILED: resolveReserveMetadata did not recover the real name/ticker -- would still show 'Unnamed Reserve'.");
    process.exit(1);
  }
  console.log("PART B CONFIRMED: metadata resolves correctly -- this Reserve would display as", `"${resolved!.name}" (${resolved!.ticker})`, "not 'Unnamed Reserve'.");

  console.log("\n=== ALL CONFIRMED ===");
  console.log("Reserve:", result.reserve, "reserveId:", result.reserveId);
  console.log("Create-and-register signature:", result.transactions.createAndRegister);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
