// Creates the small canonical set of genuine, functional DevNet replacement
// Reserves for the quarantined legacy ones (see
// docs/project/DECISION_LOG.md's entry for this pass and
// packages/sdk/src/reserveEligibility.ts for why reserveId 0-8 etc. were
// quarantined). Uses the exact real, unmodified on-chain instruction
// builders CreateDTR.tsx's browser flow calls (packages/sdk/src/
// createReserveFlow.ts) -- no reimplementation, no simulation -- driven from
// a script only because no browser/wallet-adapter is available in this
// environment (the same established pattern every other scripts/verify_*.ts
// in this repo already uses).
//
// Idempotent: re-running this script checks live discovery for an existing
// Reserve whose on-chain metadata name already matches one of the 3
// canonical names below and skips creating a duplicate.
//
// The DevNet protocol deployer wallet (~/.config/solana/devnet-deployer.json,
// ProtocolConfig.authority) is used as the creator/manager for these 3
// Reserves -- an intentional, identifiable owner for the canonical product
// catalogue, distinct from the disposable throwaway keypairs used elsewhere
// for Buy/Sell verification. devnet-fixtures/manager-keypair.json (the
// DevNet swap-authority / mint authority for devUSDC and mockX/Y/Z) is used
// ONLY to mint the seed test-asset amounts into the deployer's own wallet
// before creating each Reserve -- never as the Reserve's own manager.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"), "utf-8");

import handler from "../api/devnet/swap-sign";
import {
  buildReadOnlyProgram,
  discoverAllReserves,
  fetchReserveOnChain,
  parseReserveMetadataUri,
  evaluateReserveEligibility,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  DEVNET_FIXTURES,
  DEVUSDC,
  DEVUSDC_MINT,
} from "../packages/sdk/src";
import { buildDtrFromDiscoveredReserve } from "../src/merge/lib/onChainReserve";

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const MOCK_X = new PublicKey(DEVNET_FIXTURES.mints.mintX.address);
const MOCK_Y = new PublicKey(DEVNET_FIXTURES.mints.mintY.address);
const MOCK_Z = new PublicKey(DEVNET_FIXTURES.mints.mintZ.address);
const DEC_X = DEVNET_FIXTURES.mints.mintX.decimals;
const DEC_Y = DEVNET_FIXTURES.mints.mintY.decimals;
const DEC_Z = DEVNET_FIXTURES.mints.mintZ.decimals;

interface CanonicalAsset {
  mint: PublicKey;
  decimals: number;
  weightBps: number;
  seedAmountUnits: number; // human units, e.g. 100 = 100 mockX
}

interface CanonicalReserveSpec {
  name: string;
  ticker: string;
  description: string;
  category: string;
  assets: CanonicalAsset[];
}

// NOTE: metadataUri has a strict 200-byte on-chain cap
// (programs/ssr_protocol/src/constants.rs's MAX_METADATA_URI_LEN, enforced
// as MetadataUriTooLong) -- descriptions here are deliberately terse to fit
// the encoded data: URI (see parseReserveMetadataUri's decode side, which
// tolerates a missing/empty `category`).
const SPECS: CanonicalReserveSpec[] = [
  {
    name: "Single-Asset Reserve",
    ticker: "SGL-X",
    description: "100% mockX.",
    category: "",
    assets: [{ mint: MOCK_X, decimals: DEC_X, weightBps: 10_000, seedAmountUnits: 100 }],
  },
  {
    name: "Balanced Reserve",
    ticker: "BAL-XY",
    description: "50% mockX / 50% mockY.",
    category: "",
    assets: [
      { mint: MOCK_X, decimals: DEC_X, weightBps: 5_000, seedAmountUnits: 50 },
      { mint: MOCK_Y, decimals: DEC_Y, weightBps: 5_000, seedAmountUnits: 50 },
    ],
  },
  {
    name: "Diversified Reserve",
    ticker: "DIV-XYZ",
    description: "40% mockX / 35% mockY / 25% mockZ.",
    category: "",
    assets: [
      { mint: MOCK_X, decimals: DEC_X, weightBps: 4_000, seedAmountUnits: 40 },
      { mint: MOCK_Y, decimals: DEC_Y, weightBps: 3_500, seedAmountUnits: 35 },
      { mint: MOCK_Z, decimals: DEC_Z, weightBps: 2_500, seedAmountUnits: 25 },
    ],
  },
];

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return { status(c: number) { state.statusCode = c; return this; }, json(b: unknown) { state.body = b; }, _state: state };
}

async function callSwapSign(body: Record<string, unknown>) {
  const req = { method: "POST", headers: {}, body };
  const res = mockRes();
  await handler(req as any, res as any);
  const b = res._state.body as any;
  console.log(`    swap-sign status=${res._state.statusCode}${b.error ? ` ERROR="${b.error}"` : ""}`);
  return b as { transactionBase64?: string; error?: string; code?: string; quote?: unknown };
}

async function findExistingByName(name: string, candidateMints: PublicKey[]): Promise<string | null> {
  const { reserves } = await discoverAllReserves(connection, programId, candidateMints);
  for (const r of reserves) {
    const meta = parseReserveMetadataUri(r.metadataUri);
    if (meta?.name === name) return r.reserve;
  }
  return null;
}

async function reportView(label: string, reserveAddress: PublicKey, candidateMints: PublicKey[]) {
  const { reserves } = await discoverAllReserves(connection, programId, candidateMints);
  const found = reserves.find((r) => r.reserve === reserveAddress.toBase58());
  if (!found) {
    console.log(`    [${label}] NOT FOUND in fresh discovery`);
    return null;
  }
  const elig = evaluateReserveEligibility({
    reserve: found.reserve,
    assetCount: found.assetCount,
    resolvedAssetCount: found.resolvedAssetCount,
    assetMints: found.assets.map((a) => a.assetMint),
    status: found.status,
    reserveTokenSupplyRaw: found.reserveTokenSupplyRaw,
  });
  const dtr = buildDtrFromDiscoveredReserve(found, [], null);
  console.log(
    `    [${label}] status=${found.status} assetCount=${found.assetCount} resolved=${found.resolvedAssetCount} eligible=${elig.eligible} supplyRaw=${found.reserveTokenSupplyRaw} AUM=$${dtr.aum.toFixed(6)} NAV=$${dtr.nav.toFixed(6)}`,
  );
  console.log(`    [${label}] vaults: ${found.assets.map((a) => `${a.assetMint.slice(0, 6)}=${a.vaultBalanceRaw}(dec${a.decimals})`).join(", ")}`);
  return { found, dtr, elig };
}

async function createCanonicalReserve(spec: CanonicalReserveSpec, deployer: Keypair, manager: Keypair): Promise<PublicKey> {
  console.log(`\n=== CREATE: ${spec.name} (${spec.ticker}) ===`);
  const candidateMints = spec.assets.map((a) => a.mint);
  const existing = await findExistingByName(spec.name, candidateMints);
  if (existing) {
    console.log(`  Already exists on-chain at ${existing} -- skipping creation (idempotent).`);
    return new PublicKey(existing);
  }

  // Mint each asset's seed amount into the deployer's own ATA (manager
  // keypair is the real mint authority for mockX/Y/Z, same as every other
  // seed-funding path in this repo).
  for (const a of spec.assets) {
    const ata = getAssociatedTokenAddressSync(a.mint, deployer.publicKey);
    const rawAmount = BigInt(a.seedAmountUnits) * 10n ** BigInt(a.decimals);
    console.log(`  Minting ${a.seedAmountUnits} of ${a.mint.toBase58().slice(0, 6)}... to deployer`);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(manager.publicKey, ata, deployer.publicKey, a.mint),
        createMintToInstruction(a.mint, ata, manager.publicKey, rawAmount),
      ),
      [manager],
    );
  }

  const program = buildReadOnlyProgram(connection) as any;
  const addresses = await deriveNewReserveAddresses(program, programId);
  console.log(`  New reserveId=${addresses.reserveId} address=${addresses.reserve.toBase58()}`);

  const metadataUri = `data:application/json,${encodeURIComponent(
    JSON.stringify(spec.category ? { name: spec.name, ticker: spec.ticker, description: spec.description, category: spec.category } : { name: spec.name, ticker: spec.ticker, description: spec.description }),
  )}`;
  const MAX_METADATA_URI_LEN = 200; // programs/ssr_protocol/src/constants.rs
  if (metadataUri.length > MAX_METADATA_URI_LEN) {
    throw new Error(`metadataUri for "${spec.name}" is ${metadataUri.length} bytes, exceeds the on-chain ${MAX_METADATA_URI_LEN}-byte cap -- shorten description/category.`);
  }
  const createIx = await buildCreateReserveInstruction(program, addresses, deployer.publicKey, {
    metadataUri,
    mintFeeBps: 50,
    redemptionFeeBps: 0,
    tvlFeeBps: 100,
    // 50/50 manager/protocol split -- matches createReserveClient.ts's
    // corrected default (was 8000/2000); see docs/project/DECISION_LOG.md's
    // entry for this pass. Only affects Reserves created by a future run of
    // this script -- the canonical Reserves already created (28/29/30, see
    // DEC-0081) keep their original 80/20 split, immutable on-chain.
    managerFeeShareBps: 5000,
    protocolFeeShareBps: 5000,
    feeDestination: deployer.publicKey,
  });
  const assetAddrs = spec.assets.map((a) => deriveReserveAssetAddresses(addresses.reserve, a.mint, programId));
  const registerIxs = await Promise.all(assetAddrs.map((aa, i) => buildInitializeReserveAssetInstruction(program, addresses, aa, deployer.publicKey, spec.assets[i].weightBps)));
  const createSig = await sendAndConfirmTransaction(connection, new Transaction().add(createIx, ...registerIxs), [deployer]);
  console.log(`  CREATE+REGISTER tx: ${createSig}`);

  const seedAmountsRaw = spec.assets.map((a) => BigInt(a.seedAmountUnits) * 10n ** BigInt(a.decimals));
  const initialReserveTokens = 100_000000n; // 1 Reserve Token = $1 test-price convention at inception, matches every other fixture Reserve in this environment
  const seedIx = await buildSeedReserveInstruction(program, addresses, assetAddrs, deployer.publicKey, seedAmountsRaw, initialReserveTokens);
  const seedSig = await sendAndConfirmTransaction(connection, new Transaction().add(seedIx), [deployer]);
  console.log(`  SEED tx: ${seedSig}`);

  await reportView("after create+seed", addresses.reserve, candidateMints);
  return addresses.reserve;
}

async function verifyBuySell(label: string, reserveAddress: PublicKey, candidateMints: PublicKey[], manager: Keypair) {
  console.log(`\n=== VERIFY Buy/Sell: ${label} (${reserveAddress.toBase58()}) ===`);
  const user = Keypair.generate();
  console.log(`  throwaway buyer/seller: ${user.publicKey.toBase58()}`);
  await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: manager.publicKey, toPubkey: user.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [manager]);
  const userDevUsdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, user.publicKey);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(manager.publicKey, userDevUsdcAta, user.publicKey, DEVUSDC_MINT),
      createMintToInstruction(DEVUSDC_MINT, userDevUsdcAta, manager.publicKey, 50_000000n),
    ),
    [manager],
  );
  console.log("  Funded: 0.05 SOL + 50 devUSDC");

  const before = await reportView("before buy", reserveAddress, candidateMints);
  if (!before) throw new Error("Reserve not found before Buy -- aborting verification.");

  console.log("  -- BUY 10 devUSDC --");
  const buyResp = await callSwapSign({
    action: "buy-devusdc",
    reserve: reserveAddress.toBase58(),
    userPubkey: user.publicKey.toBase58(),
    assetMints: candidateMints.map((m) => m.toBase58()),
    devUsdcAmountRaw: "10000000",
  });
  if (!buyResp.transactionBase64) throw new Error("BUY BUILD FAILED: " + buyResp.error);
  const buyTx = Transaction.from(Buffer.from(buyResp.transactionBase64, "base64"));
  console.log("  required signers:", buyTx.signatures.map((s) => s.publicKey.toBase58()));
  buyTx.partialSign(user);
  const buySig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(buySig, "confirmed");
  console.log(`  BUY signature: ${buySig}`);

  const afterBuy = await reportView("after buy", reserveAddress, candidateMints);
  if (!afterBuy) throw new Error("Reserve not found after Buy.");
  const rtMint = (await fetchReserveOnChain(connection, programId, reserveAddress, candidateMints))!.reserveTokenMint;
  const userRtAta = getAssociatedTokenAddressSync(new PublicKey(rtMint), user.publicKey);
  const rtBalAfterBuy = await getAccount(connection, userRtAta);
  console.log(`  buyer Reserve Token balance after buy: ${rtBalAfterBuy.amount.toString()}`);
  if (rtBalAfterBuy.amount <= 0n) throw new Error("Buy did not mint any Reserve Tokens to the buyer -- FAILED.");
  if (BigInt(afterBuy.found.reserveTokenSupplyRaw) <= BigInt(before.found.reserveTokenSupplyRaw)) {
    throw new Error("Reserve Token supply did not increase after Buy -- FAILED.");
  }

  console.log("  -- SELL half --");
  const toRedeem = rtBalAfterBuy.amount / 2n;
  const sellResp = await callSwapSign({
    action: "sell",
    reserve: reserveAddress.toBase58(),
    userPubkey: user.publicKey.toBase58(),
    assetMints: candidateMints.map((m) => m.toBase58()),
    reserveTokensToRedeem: toRedeem.toString(),
  });
  if (!sellResp.transactionBase64) throw new Error("SELL BUILD FAILED: " + sellResp.error);
  const sellTx = Transaction.from(Buffer.from(sellResp.transactionBase64, "base64"));
  console.log("  required signers:", sellTx.signatures.map((s) => s.publicKey.toBase58()));
  sellTx.partialSign(user);
  const sellSig = await connection.sendRawTransaction(sellTx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sellSig, "confirmed");
  console.log(`  SELL signature: ${sellSig}  quote: ${JSON.stringify(sellResp.quote)}`);

  const afterSell = await reportView("after sell", reserveAddress, candidateMints);
  if (!afterSell) throw new Error("Reserve not found after Sell.");
  const devUsdcAfterSell = await getAccount(connection, userDevUsdcAta);
  console.log(`  buyer devUSDC balance after sell: ${devUsdcAfterSell.amount.toString()}`);
  if (devUsdcAfterSell.amount <= 0n) throw new Error("Sell did not return any devUSDC to the seller -- FAILED.");
  if (BigInt(afterSell.found.reserveTokenSupplyRaw) >= BigInt(afterBuy.found.reserveTokenSupplyRaw)) {
    throw new Error("Reserve Token supply did not decrease after Sell -- FAILED.");
  }

  // Fresh re-read (a THIRD independent discovery pass, not reusing any
  // above-cached value) to confirm the on-chain state genuinely persists,
  // not just that this process's own in-memory view looked right.
  const freshReread = await reportView("fresh re-read (persistence check)", reserveAddress, candidateMints);
  if (!freshReread || !freshReread.elig.eligible) {
    throw new Error("Fresh re-read after Buy/Sell reports the Reserve as INELIGIBLE -- FAILED.");
  }
  if (freshReread.found.resolvedAssetCount !== freshReread.found.assetCount) {
    throw new Error(`Fresh re-read shows registered(${freshReread.found.assetCount}) != resolved(${freshReread.found.resolvedAssetCount}) -- FAILED.`);
  }

  console.log(`  Explorer: Buy=https://explorer.solana.com/tx/${buySig}?cluster=devnet  Sell=https://explorer.solana.com/tx/${sellSig}?cluster=devnet`);
  return { buySig, sellSig };
}

async function main() {
  const manager = loadKeypair(path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"));
  const deployerPath = process.env.DEVNET_DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config", "solana", "devnet-deployer.json");
  const deployer = loadKeypair(deployerPath);
  console.log("deployer/manager wallet:", deployer.publicKey.toBase58());
  console.log("swap authority / mint authority wallet:", manager.publicKey.toBase58());

  const results: Record<string, { reserve: PublicKey; buySig?: string; sellSig?: string }> = {};

  // 1. Single-Asset Reserve -- create, then fully validate end-to-end BEFORE
  // creating anything else (explicit ordering requirement).
  const singleSpec = SPECS[0];
  const singleReserve = await createCanonicalReserve(singleSpec, deployer, manager);
  const singleVerify = await verifyBuySell(singleSpec.name, singleReserve, singleSpec.assets.map((a) => a.mint), manager);
  results[singleSpec.name] = { reserve: singleReserve, ...singleVerify };
  console.log(`\n*** ${singleSpec.name} fully verified end-to-end. Proceeding to the remaining canonical Reserves. ***`);

  // 2. Balanced + Diversified, same full verification battery each.
  for (const spec of SPECS.slice(1)) {
    const reserve = await createCanonicalReserve(spec, deployer, manager);
    const verify = await verifyBuySell(spec.name, reserve, spec.assets.map((a) => a.mint), manager);
    results[spec.name] = { reserve, ...verify };
  }

  console.log("\n=== SUMMARY ===");
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name}: reserve=${r.reserve.toBase58()} buy=${r.buySig} sell=${r.sellSig}`);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("create_canonical_reserves FAILED:", e);
  process.exit(1);
});
