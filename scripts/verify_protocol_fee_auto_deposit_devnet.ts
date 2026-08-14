// Live DevNet verification of the seed-mint-fee fix and the Protocol
// auto-deposit mechanism -- see docs/project/DECISION_LOG.md's entry for
// this pass. Two parts, both against the real deployed (just-upgraded)
// program:
//
// PART A -- seeds a genuinely fresh Reserve and confirms the initial seed
// mint now charges the same Mint Fee as any other mint: the creator
// receives strictly LESS than the gross requested amount, and BOTH
// pending_manager_fee_shares and pending_protocol_fee_shares are nonzero
// immediately after seeding (previously both stayed 0 forever -- the
// reported "0 collectible fees right after creation" bug).
//
// PART B -- calls the new, additive collect_protocol_fee instruction
// directly (the same instruction api/devnet/accrue-fees-cron.ts's weekly
// keeper calls) and confirms: the Protocol's pending share is minted to the
// real Protocol treasury ATA and zeroed on-chain, the Manager's pending
// share is left completely untouched (proving the two are independently
// collectible), and a second call correctly fails with NoPendingFees (no
// double-collection).
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";

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
import { buildReadOnlyProgram, buildCollectProtocolFeeInstruction, fetchProtocolConfig, fetchReserveOnChain, DEVNET_FIXTURES } from "../packages/sdk/src";
import { createReserveOnChain, uploadReserveMetadata, estimateNetSeedReserveTokens } from "../src/merge/lib/createReserveClient";

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
  const mintAuthoritySecret = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8"));
  const mockXMintAuthority = Keypair.fromSecretKey(Uint8Array.from(mintAuthoritySecret));

  const creator = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Creator pubkey:", creator.publicKey.toBase58());

  // Pre-fund the creator with plenty of mockX directly (mockXMintAuthority
  // IS mockX's real on-chain mint authority -- confirmed live) so
  // fundSeedAssetsIdempotent's balance check inside createReserveOnChain
  // finds zero shortfall and never calls the browser-relative
  // /api/devnet/mint-test-assets endpoint at all (which needs a real
  // browser origin to resolve -- an unrelated, pre-existing limitation of
  // running this client code from a Node script, not something this pass
  // touches).
  const mockX = DEVNET_FIXTURES.mints.mintX;
  const mockXMint = new PublicKey(mockX.address);
  const creatorMockXAta = getAssociatedTokenAddressSync(mockXMint, creator.publicKey);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, creatorMockXAta, creator.publicKey, mockXMint),
      createMintToInstruction(mockXMint, creatorMockXAta, mockXMintAuthority.publicKey, 1_000_000_000),
    ),
    [deployer, mockXMintAuthority],
  );
  console.log("Pre-funded creator with 1000 mockX directly (bypassing the faucet endpoint).");

  const metadataInput = {
    name: "Protocol Fee Auto-Deposit Test Reserve",
    ticker: "PFAD",
    description: "Verifies the seed mint fee and Protocol auto-deposit together.",
    category: "DeFi",
    buyTaxPct: 0,
    sellTaxPct: 0,
  };
  const uploadedUri = await uploadReserveMetadata(PRODUCTION_ORIGIN, metadataInput);
  console.log("Uploaded metadataUri:", uploadedUri);

  const mintFeeBps = 200; // 2% -- comfortably above the 0.5% Protocol floor, so both Manager and Protocol shares are unambiguously nonzero.
  const grossSeedTokens = 10; // $10 -> 10 gross Reserve Token units at 1:1 test pricing.
  const expectedNet = estimateNetSeedReserveTokens(grossSeedTokens, mintFeeBps / 100);
  console.log(`Gross seed target: ${grossSeedTokens}, expected net after ${mintFeeBps / 100}% mint fee: ${expectedNet}`);

  console.log("\n=== Calling the real createReserveOnChain (create-and-register, fund-seed-assets, seed) ===");
  const result = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creator),
    metadataUri: uploadedUri,
    mintFeeBps,
    tvlFeeBps: 100,
    feeDestination: creator.publicKey,
    assets: [{ mint: mockX.address, weightBps: 10_000, seedWeightFraction: 1, decimals: mockX.decimals }],
    seedTotalUsd: grossSeedTokens,
    onProgress: (step) => console.log("  step:", step),
  });
  console.log("Reserve:", result.reserve, "reserveId:", result.reserveId);
  console.log("seed signature:", result.transactions.seed);

  // ============================================================
  // PART A -- the seed mint genuinely charged a fee.
  // ============================================================
  console.log("\n=== PART A: confirming the seed mint charged Manager + Protocol fee ===");
  const reservePk = new PublicKey(result.reserve);
  const reserveTokenMint = new PublicKey(result.reserveTokenMint);
  const creatorRtAta = getAssociatedTokenAddressSync(reserveTokenMint, creator.publicKey);
  const creatorRtAccount = await getAccount(connection, creatorRtAta);
  console.log(`Creator received: ${creatorRtAccount.amount} raw units (expected NET, base units: ${expectedNet * 1_000_000})`);

  const onChainAfterSeed = await fetchReserveOnChain(connection, programId, reservePk, [mockXMint]);
  console.log("pending_manager_fee_shares:", onChainAfterSeed?.pendingManagerFeeShares);
  console.log("pending_protocol_fee_shares:", onChainAfterSeed?.pendingProtocolFeeShares);

  const partACreatorGotLess = creatorRtAccount.amount < BigInt(grossSeedTokens) * 1_000_000n;
  const partAManagerFeeNonzero = BigInt(onChainAfterSeed?.pendingManagerFeeShares ?? "0") > 0n;
  const partAProtocolFeeNonzero = BigInt(onChainAfterSeed?.pendingProtocolFeeShares ?? "0") > 0n;
  console.log("Creator received strictly less than gross:", partACreatorGotLess);
  console.log("Manager pending fee is nonzero:", partAManagerFeeNonzero);
  console.log("Protocol pending fee is nonzero (THE REPORTED BUG, now fixed):", partAProtocolFeeNonzero);

  if (!partACreatorGotLess || !partAManagerFeeNonzero || !partAProtocolFeeNonzero) {
    console.error("\nPART A FAILED.");
    process.exit(1);
  }
  console.log("\nPART A CONFIRMED live on real DevNet.");

  // ============================================================
  // PART B -- collect_protocol_fee sweeps ONLY the Protocol's share.
  // ============================================================
  console.log("\n=== PART B: collect_protocol_fee (the weekly-keeper mechanism) ===");
  const protocolConfig = await fetchProtocolConfig(connection, programId);
  if (!protocolConfig) throw new Error("ProtocolConfig not found.");
  const protocolFeeDestination = new PublicKey(protocolConfig.defaultProtocolFeeDestination);
  const protocolFeeDestinationAta = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
  const balanceBefore = await getAccount(connection, protocolFeeDestinationAta).then((a) => a.amount).catch(() => 0n);
  console.log("Protocol treasury balance for this Reserve's token BEFORE collection:", balanceBefore);

  const program = buildReadOnlyProgram(connection) as any;
  const collectIx = await buildCollectProtocolFeeInstruction(program, programId, reservePk, reserveTokenMint, protocolFeeDestination, deployer.publicKey);
  const collectTx = new Transaction().add(collectIx);
  const collectSig = await sendAndConfirmTransaction(connection, collectTx, [deployer]);
  console.log("collect_protocol_fee signature:", collectSig);

  const balanceAfter = await getAccount(connection, protocolFeeDestinationAta).then((a) => a.amount);
  console.log("Protocol treasury balance AFTER collection:", balanceAfter);

  const onChainAfterCollect = await fetchReserveOnChain(connection, programId, reservePk, [mockXMint]);
  console.log("pending_protocol_fee_shares after collection (expect 0):", onChainAfterCollect?.pendingProtocolFeeShares);
  console.log("pending_manager_fee_shares after collection (expect UNCHANGED):", onChainAfterCollect?.pendingManagerFeeShares);

  const partBTreasuryGrew = balanceAfter > balanceBefore;
  const partBProtocolZeroed = onChainAfterCollect?.pendingProtocolFeeShares === "0";
  const partBManagerUntouched = onChainAfterCollect?.pendingManagerFeeShares === onChainAfterSeed?.pendingManagerFeeShares;
  console.log("Protocol treasury balance grew:", partBTreasuryGrew);
  console.log("pending_protocol_fee_shares zeroed:", partBProtocolZeroed);
  console.log("Manager's pending share left untouched:", partBManagerUntouched);

  if (!partBTreasuryGrew || !partBProtocolZeroed || !partBManagerUntouched) {
    console.error("\nPART B FAILED.");
    process.exit(1);
  }

  console.log("\nConfirming a second collect_protocol_fee call correctly fails (NoPendingFees, no double-collection)...");
  let secondCallFailedAsExpected = false;
  try {
    const collectIx2 = await buildCollectProtocolFeeInstruction(program, programId, reservePk, reserveTokenMint, protocolFeeDestination, deployer.publicKey);
    const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(collectIx2), [deployer]);
    console.log("UNEXPECTED: second collection succeeded:", sig2);
  } catch (e) {
    secondCallFailedAsExpected = /NoPendingFees/i.test(String(e));
    console.log("Second call rejected as expected:", secondCallFailedAsExpected);
  }
  if (!secondCallFailedAsExpected) {
    console.error("\nPART B FAILED: a second collect_protocol_fee call should have failed with NoPendingFees.");
    process.exit(1);
  }

  console.log("\nPART B CONFIRMED live on real DevNet.");
  console.log("\n=== ALL CONFIRMED ===");
  console.log("Reserve:", result.reserve, "reserveId:", result.reserveId);
  console.log("seed signature:", result.transactions.seed);
  console.log("collect_protocol_fee signature:", collectSig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
