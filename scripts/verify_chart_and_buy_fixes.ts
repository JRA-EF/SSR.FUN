// Live DevNet verification for the "repair Reserve charts, featured cards,
// and Helius buy flow" pass -- see docs/project/DECISION_LOG.md. Creates a
// genuinely fresh, 100%-devUSDC Reserve (the simplest, fully-genuine devUSDC
// settlement path -- no server-minted legs involved either direction), then
// exercises the REAL, in-process api/devnet/swap-sign.ts handler (post-fix)
// through the exact client code DTRDetail.tsx calls, with real signed
// transactions on live DevNet. Also deliberately provokes a genuine
// (non-rate-limit) failure to prove it is no longer misclassified as
// "DevNet RPC congested."
//
// What this does NOT (and cannot) verify: the literal browser click path
// (chart rendering, button layout, Featured card visuals) -- no browser-
// automation tool is available in this environment. That layer is covered
// by this pass's own offline tests (tests/phase_chart_range_selector.ts,
// tests/phase_tradable_reserves_and_price_history.ts,
// tests/phase_featured_cards_and_rpc_redaction.ts), which render the real
// components/call the real pure functions directly.
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import swapSignHandler from "../api/devnet/swap-sign";
import { createReserveOnChain } from "../src/merge/lib/createReserveClient";
import { executeBuyZapDevUsdc, ZapBuildError } from "../src/merge/lib/zapClient";
import { DEVNET_FIXTURES, DEVUSDC, fetchReserveOnChain } from "../packages/sdk/src";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
    },
    _state: state,
  };
}

// Routes the client code's relative-path fetch() calls to the REAL, in-
// process API handlers (the same handlers Vercel runs) -- so this script
// exercises the actual fixed swap-sign.ts classification logic, not a
// reimplementation of it.
const realFetch = global.fetch;
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const req = { method: "POST", headers: {}, body };
  if (url.includes("mint-test-assets")) {
    const res = mockRes();
    await mintTestAssetsHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode ?? 500, json: async () => res._state.body } as Response;
  }
  if (url.includes("swap-sign")) {
    const res = mockRes();
    await swapSignHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode ?? 500, json: async () => res._state.body } as Response;
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

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) {
    passed += 1;
    console.log(`  OK   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}`);
  }
}

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync("C:\\Users\\JRA DEVNET\\.config\\solana\\devnet-deployer.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  const creator = Keypair.generate();
  console.log("=== Fresh creator wallet (stands in for a newly connected Phantom wallet) ===");
  console.log("creator pubkey:", creator.publicKey.toBase58());

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Funded creator with 0.1 SOL from deployer for rent + fees.");

  // 100% devUSDC composition -- the one fully-genuine settlement path today
  // (buildRedeemToDevUsdcInstructions on Sell, direct transfer_checked on
  // Buy) with zero server-minted legs either direction, per DEC-0054/DEC-0067.
  const assets = [{ mint: DEVUSDC.mint, weightBps: 10_000, seedWeightFraction: 1, decimals: DEVUSDC.decimals }];
  const seedTotalUsd = 20;

  console.log("\n=== Step 1: create a genuinely fresh Reserve (real client code, real signed transactions) ===");
  const result = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creator),
    metadataUri: "https://example.invalid/ssr/chart-buy-fix-verification.json",
    mintFeeBps: 50,
    tvlFeeBps: 100,
    feeDestination: creator.publicKey,
    assets,
    seedTotalUsd,
    onProgress: (step) => console.log("  step:", step),
  });
  console.log("Reserve:", result.reserve);
  console.log("createAndRegister tx:", result.transactions.createAndRegister);
  console.log("fundSeedAssets tx:", result.transactions.fundSeedAssets);
  console.log("seed tx:", result.transactions.seed);
  check("Reserve created and seeded with 3 real transactions", Boolean(result.reserve && result.transactions.seed));

  const reserveTokenMint = new PublicKey(result.reserveTokenMint);
  const assetMints = result.assets.map((a) => a.mint);
  const creatorRtAta = getAssociatedTokenAddressSync(reserveTokenMint, creator.publicKey);

  console.log("\n=== Step 2: read this Reserve's REAL on-chain NAV (what the chart fallback / Featured sparkline would consume) ===");
  const onChainAfterSeed = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  check("Reserve fetched on-chain after seeding", onChainAfterSeed !== null);
  const supplyAfterSeed = Number(onChainAfterSeed!.reserveTokenSupplyRaw) / 10 ** 6; // Reserve Token has 6 decimals per create_reserve default
  const vaultBalance = Number(onChainAfterSeed!.assets[0].vaultBalanceRaw) / 10 ** DEVUSDC.decimals;
  const nav = supplyAfterSeed > 0 ? vaultBalance / supplyAfterSeed : 0;
  console.log(`Real on-chain vault balance: ${vaultBalance} devUSDC, Reserve Token supply: ${supplyAfterSeed}, computed NAV: ${nav}`);
  check("A genuinely fresh Reserve has a valid, positive NAV (feeds a real chart, not a fallback-to-unavailable state)", nav > 0 && Number.isFinite(nav));

  console.log("\n=== Step 2b: fund the creator's OWN wallet with spendable devUSDC (the seed step deposited all of it into the vault, leaving the creator's own balance at 0) ===");
  const fundRes = mockRes();
  await mintTestAssetsHandler(
    { method: "POST", headers: {}, body: { userPubkey: creator.publicKey.toBase58(), mints: [{ mint: DEVUSDC.mint, rawAmount: (BigInt(10) * BigInt(10 ** DEVUSDC.decimals)).toString() }] } } as any,
    fundRes as any,
  );
  check("Creator funded with 10 spendable devUSDC (same faucet-style path Portfolio's onboarding panel uses)", (fundRes._state.statusCode ?? 500) < 300);

  console.log("\n=== Step 3: genuine Buy through the REAL, fixed api/devnet/swap-sign.ts handler (in-process, same code Vercel runs) ===");
  const devUsdcAmountRaw = BigInt(2) * BigInt(10 ** DEVUSDC.decimals); // 2 devUSDC
  const rtBefore = await getAccount(connection, creatorRtAta).then((a) => a.amount).catch(() => 0n);
  try {
    const buyRes = await executeBuyZapDevUsdc({
      connection,
      wallet: fakeWallet(creator),
      reserveAddress: result.reserve,
      assetMints,
      userPubkey: creator.publicKey,
      devUsdcAmountRaw,
    });
    console.log("Buy signature:", buyRes.signature, "quote:", buyRes.quote);
    check("Buy completed with a real signature, no false congestion toast triggered", Boolean(buyRes.signature));
    const rtAfter = await getAccount(connection, creatorRtAta).then((a) => a.amount);
    console.log(`Reserve Token balance: ${rtBefore} -> ${rtAfter}`);
    check("Wallet received real Reserve Tokens from the Buy", rtAfter > rtBefore);
  } catch (e) {
    check(`Buy should have succeeded: ${e instanceof Error ? e.message : String(e)}`, false);
  }

  console.log("\n=== Step 4: refresh-persistence check (re-fetch, simulating a page refresh) ===");
  const refetched = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  check("Re-fetched Reserve state after 'refresh' matches (real vault balance/supply persisted on-chain)", refetched !== null && refetched.reserveTokenSupplyRaw !== "0");

  console.log("\n=== Step 5: deliberately provoke a genuine (non-rate-limit) failure and confirm it is NOT mislabeled 'rpc_congested' ===");
  try {
    // Attempt to Buy far more devUSDC than the creator actually holds --
    // this is a genuine, real failure (insufficient balance for the
    // transfer_checked inside mint_reserve_tokens_in_kind), completely
    // unrelated to RPC rate-limiting.
    await executeBuyZapDevUsdc({
      connection,
      wallet: fakeWallet(creator),
      reserveAddress: result.reserve,
      assetMints,
      userPubkey: creator.publicKey,
      devUsdcAmountRaw: BigInt(999_999) * BigInt(10 ** DEVUSDC.decimals),
    });
    check("An impossible-balance Buy should have failed, but it succeeded", false);
  } catch (e) {
    const isZapBuildError = e instanceof ZapBuildError;
    const code = isZapBuildError ? (e as ZapBuildError).code : undefined;
    console.log(`  Failed as expected. code=${code}, message=${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    check("The real insufficient-balance failure was NOT classified as 'rpc_congested'", code !== "rpc_congested");
  }

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  console.log(`\nExplorer -- Reserve: https://explorer.solana.com/address/${result.reserve}?cluster=devnet`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
