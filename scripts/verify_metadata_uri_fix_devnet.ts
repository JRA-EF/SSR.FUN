// Live DevNet verification of the MetadataUriTooLong fix (see
// docs/project/DECISION_LOG.md's entry). Two parts, both against the real
// deployed program and the real Neon Postgres database (DATABASE_URL from
// `vercel env pull .env.local`), no mocking of on-chain behavior:
//
// PART A -- reproduces the ORIGINAL reported failure directly: builds the
// exact old `data:application/json,...` inline-payload metadataUri
// CreateDTR.tsx used to submit, bypassing this fix's new client-side guard
// on purpose (calling the raw instruction builder, not createReserveOnChain),
// and submits a real create-and-register transaction with it. Confirms it
// is genuinely rejected on-chain with SsrError::MetadataUriTooLong (6000),
// and that reserve_count is unchanged afterward (Solana's atomic rollback
// on a failed transaction already guarantees nothing partial was created --
// this just confirms it directly rather than assuming it).
//
// PART B -- exercises the FULL fixed flow through the real client code:
// uploads metadata to api/devnet/reserve-metadata.ts (in-process, same
// technique scripts/verify_e2e_fresh_reserve.ts uses for mint-test-assets/
// swap-sign -- the real handler, the real database, just not over a real
// HTTP round trip) via uploadReserveMetadata, then calls the real
// createReserveOnChain with the resulting URL through the entire
// create+register+seed flow. Confirms the on-chain Reserve's stored
// metadata_uri matches exactly what was submitted, and that GETting that
// URL back resolves to the real stored JSON payload.
import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

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
import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import { buildReadOnlyProgram, deriveNewReserveAddresses, buildCreateReserveInstruction, buildInitializeReserveAssetInstruction, deriveReserveAssetAddresses, fetchProtocolConfig, describeOnChainError } from "../packages/sdk/src";
import { createReserveOnChain, uploadReserveMetadata } from "../src/merge/lib/createReserveClient";
import { DEVNET_FIXTURES, fetchReserveOnChain } from "../packages/sdk/src";

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

// Route this app's own metadata-store endpoint to the real handler
// in-process (real Postgres, real validation logic) -- same technique
// verify_e2e_fresh_reserve.ts uses for mint-test-assets/swap-sign. Every
// other fetch() call (there are none in this script) would pass through.
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
  if (url.includes("mint-test-assets")) {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const req = { method: "POST", headers: {}, body };
    const res = mockRes();
    await mintTestAssetsHandler(req as any, res as any);
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

const skipPartA = process.argv.includes("--skip-part-a");
let oldStyleByteLength = 0;
const mockX = DEVNET_FIXTURES.mints.mintX;

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync("C:\\Users\\JRA DEVNET\\.config\\solana\\devnet-deployer.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  if (skipPartA) {
    console.log("=== PART A: skipped (--skip-part-a; already confirmed live in a prior run) ===\n");
  } else {
  // ============================================================
  // PART A -- reproduce the ORIGINAL reported failure, for real.
  // ============================================================
  console.log("=== PART A: reproducing the original MetadataUriTooLong failure ===\n");

  const creatorA = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creatorA.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Part A creator pubkey:", creatorA.publicKey.toBase58());

  const program = buildReadOnlyProgram(connection) as any;
  const protocolConfigBefore = await fetchProtocolConfig(connection, programId);
  console.log("reserve_count BEFORE Part A attempt:", protocolConfigBefore?.reserveCount.toString());

  const addressesA = await deriveNewReserveAddresses(program, programId);
  console.log("Derived candidate reserveId for this attempt:", addressesA.reserveId.toString());

  // The EXACT old CreateDTR.tsx construction (before this fix) -- a
  // realistic name/ticker/description/category, inline as a data: URI.
  const oldStyleMetadataUri = `data:application/json,${encodeURIComponent(
    JSON.stringify({
      name: "Strategic Solana Reserve",
      ticker: "SSR1",
      description: "A diversified basket of Solana ecosystem assets, rebalanced periodically to track long-term protocol growth.",
      category: "DeFi",
      buyTaxPct: 0,
      sellTaxPct: 0,
    }),
  )}`;
  oldStyleByteLength = Buffer.byteLength(oldStyleMetadataUri, "utf8");
  console.log(`Old-style metadataUri byte length: ${oldStyleByteLength} (on-chain MAX_METADATA_URI_LEN is 200)`);

  const assetAddressesA = deriveReserveAssetAddresses(addressesA.reserve, new PublicKey(mockX.address), programId);

  const createIxA = await buildCreateReserveInstruction(program, addressesA, creatorA.publicKey, {
    metadataUri: oldStyleMetadataUri,
    mintFeeBps: 50,
    redemptionFeeBps: 0,
    tvlFeeBps: 100,
    feeDestination: creatorA.publicKey,
  });
  const registerIxA = await buildInitializeReserveAssetInstruction(program, addressesA, assetAddressesA, creatorA.publicKey, 10_000);

  let partAFailedAsExpected = false;
  let partAErrorMessage = "";
  try {
    const txA = new Transaction().add(createIxA, registerIxA);
    const sig = await sendAndConfirmTransaction(connection, txA, [creatorA]);
    console.log("UNEXPECTED: Part A transaction succeeded:", sig);
  } catch (e) {
    partAErrorMessage = describeOnChainError(e);
    partAFailedAsExpected = /MetadataUriTooLong/i.test(partAErrorMessage) || /6000/.test(partAErrorMessage);
    console.log("Part A transaction rejected on-chain, as expected.");
    console.log("Decoded error:", partAErrorMessage);
  }

  const protocolConfigAfter = await fetchProtocolConfig(connection, programId);
  console.log("reserve_count AFTER Part A attempt:", protocolConfigAfter?.reserveCount.toString());
  const reserveCountUnchanged = protocolConfigBefore?.reserveCount === protocolConfigAfter?.reserveCount;
  console.log("reserve_count unchanged by the failed attempt (nothing partial created):", reserveCountUnchanged);

  if (!partAFailedAsExpected) {
    console.error("\nPART A FAILED: expected a genuine on-chain MetadataUriTooLong rejection and did not get one.");
    process.exit(1);
  }
  if (!reserveCountUnchanged) {
    console.error("\nPART A FAILED: reserve_count changed after a failed transaction -- unexpected partial state.");
    process.exit(1);
  }
  console.log("\nPART A CONFIRMED: the exact reported root cause reproduces live on real DevNet, and the failed attempt left zero on-chain trace.\n");
  }

  // ============================================================
  // PART B -- the FULL fixed flow, real upload + real Reserve creation.
  // ============================================================
  console.log("=== PART B: the fixed flow (upload metadata, then create the Reserve with the resulting URL) ===\n");

  const creatorB = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creatorB.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Part B creator pubkey:", creatorB.publicKey.toBase58());

  const metadataInput = {
    name: "Strategic Solana Reserve",
    ticker: "SSR1",
    description: "A diversified basket of Solana ecosystem assets, rebalanced periodically to track long-term protocol growth.",
    category: "DeFi",
    buyTaxPct: 0,
    sellTaxPct: 0,
  };
  console.log("Uploading Reserve metadata via the real api/devnet/reserve-metadata.ts handler (real Postgres write)...");
  const uploadedUri = await uploadReserveMetadata(PRODUCTION_ORIGIN, metadataInput);
  console.log("Uploaded metadataUri:", uploadedUri);
  console.log("Byte length:", Buffer.byteLength(uploadedUri, "utf8"), "(vs. old-style", oldStyleByteLength, "bytes for the same content)");

  console.log("\nFetching the uploaded metadata back via GET (real Postgres read, through the real handler)...");
  const getRes = await fetch(uploadedUri);
  const fetchedPayload = await getRes.json();
  // Field-by-field, not JSON.stringify string equality -- Postgres jsonb
  // doesn't guarantee preserving the original key insertion order, so a
  // naive string comparison would report a false mismatch even though
  // every value round-trips correctly.
  const roundTripMatches = (Object.keys(metadataInput) as (keyof typeof metadataInput)[]).every((k) => fetchedPayload[k] === metadataInput[k]);
  console.log("Fetched payload:", fetchedPayload);
  console.log("Round-trips exactly to what was uploaded:", roundTripMatches);
  if (!roundTripMatches) {
    console.error("\nPART B FAILED: uploaded metadata did not round-trip correctly.");
    process.exit(1);
  }

  const assets = [{ mint: mockX.address, weightBps: 10_000, seedWeightFraction: 1, decimals: mockX.decimals }];
  const seedTotalUsd = 2;

  console.log("\nCalling the real createReserveOnChain (the exact function CreateDTR.tsx calls) with the uploaded URL...");
  const result = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creatorB),
    metadataUri: uploadedUri,
    mintFeeBps: 50,
    tvlFeeBps: 100,
    feeDestination: creatorB.publicKey,
    assets,
    seedTotalUsd,
    onProgress: (step) => console.log("  step:", step),
  });
  console.log("\nReserve created successfully:");
  console.log("  reserve:", result.reserve);
  console.log("  reserveId:", result.reserveId);
  console.log("  reserveTokenMint:", result.reserveTokenMint);
  console.log("  transactions:", result.transactions);

  const onChain = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), [new PublicKey(mockX.address)]);
  console.log("\nOn-chain Reserve read-back:");
  console.log("  metadata_uri stored on-chain:", onChain?.metadataUri);
  console.log("  matches what was submitted:", onChain?.metadataUri === uploadedUri);
  console.log("  reserveTokenSupplyRaw (seeded):", onChain?.reserveTokenSupplyRaw);

  if (onChain?.metadataUri !== uploadedUri) {
    console.error("\nPART B FAILED: on-chain metadata_uri does not match what was submitted.");
    process.exit(1);
  }

  console.log("\nPART B CONFIRMED: real Reserve creation succeeds end-to-end with the fixed metadata flow.");
  console.log("\n=== Create-and-register signature:", result.transactions.createAndRegister, "===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
