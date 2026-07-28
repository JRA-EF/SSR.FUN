// End-to-end DevNet verification of the corrective pass (see DEC-0032):
// creates a genuinely fresh Reserve through the EXACT SAME client code the
// browser uses (src/merge/lib/createReserveClient.ts, src/merge/lib/zapClient.ts),
// with one asset being the DevNet fixture mint mockX and the other being
// wrapped SOL (so both the faucet-funded path and the creator-self-wraps
// path get exercised), then Buys, then Sells part of the resulting balance --
// all with real signatures, submitted and confirmed on-chain. No hardcoded
// Reserve registration is used anywhere in this script; every address is
// either freshly derived or returned by the real flow.
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
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import swapSignHandler from "../api/devnet/swap-sign";
import { createReserveOnChain, estimateCreateReserveCost } from "../src/merge/lib/createReserveClient";
import { executeBuyZap, executeSellZap } from "../src/merge/lib/zapClient";
import { DEVNET_FIXTURES, WRAPPED_SOL_MINT, fetchReserveOnChain } from "../packages/sdk/src";

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

// Route the client code's relative-path fetch() calls to the real API
// handlers in-process (same handlers Vercel would run), so this script
// exercises the identical logic a browser session would.
const realFetch = global.fetch;
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const req = { method: "POST", headers: {}, body };
  if (url.includes("mint-test-assets")) {
    const res = mockRes();
    await mintTestAssetsHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode, json: async () => res._state.body } as Response;
  }
  if (url.includes("swap-sign")) {
    const res = mockRes();
    await swapSignHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode, json: async () => res._state.body } as Response;
  }
  return realFetch(url as any, init);
}) as typeof fetch;

function loadKeypair(name: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", `${name}-keypair.json`), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function fakeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  } as any;
}

async function solBalance(pubkey: PublicKey): Promise<number> {
  return (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
}

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync("C:\\Users\\JRA DEVNET\\.config\\solana\\devnet-deployer.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  const creator = Keypair.generate();
  console.log("=== Fresh creator wallet (stands in for a newly connected Phantom wallet) ===");
  console.log("creator pubkey:", creator.publicKey.toBase58());

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Funded creator with 0.15 SOL from deployer for rent + fees + SOL-seed leg.");

  const mockX = DEVNET_FIXTURES.mints.mintX;
  const assets = [
    { mint: mockX.address, weightBps: 7000, seedWeightFraction: 0.7, decimals: mockX.decimals },
    { mint: WRAPPED_SOL_MINT.toBase58(), weightBps: 3000, seedWeightFraction: 0.3, decimals: 9 },
  ];
  const seedTotalUsd = 2;

  console.log("\n=== Cost estimate (same function CreateDTR.tsx's Review & Deploy step calls) ===");
  const estimate = await estimateCreateReserveCost(connection, assets, seedTotalUsd);
  console.log({
    ...estimate,
    totalRentLamports: estimate.totalRentLamports.toString(),
    solSeedFundingLamports: estimate.solSeedFundingLamports.toString(),
    networkFeeLamportsEstimate: estimate.networkFeeLamportsEstimate.toString(),
    totalLamports: estimate.totalLamports.toString(),
  });

  console.log("\n=== createReserveOnChain (real client code, 2 signatures: create+register, seed; SOL-wrap makes it 3) ===");
  const result = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creator),
    metadataUri: "https://example.invalid/ssr/e2e-corrective-pass-reserve.json",
    mintFeeBps: 50,
    tvlFeeBps: 100,
    feeDestination: creator.publicKey,
    assets,
    seedTotalUsd,
    onProgress: (step) => console.log("  step:", step),
  });
  console.log("Reserve:", result.reserve);
  console.log("Reserve Token mint:", result.reserveTokenMint);
  console.log("transactions:", result.transactions);

  const reserveTokenMint = new PublicKey(result.reserveTokenMint);
  const assetMints = result.assets.map((a) => a.mint);

  const onChainAfterSeed = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  console.log("\nVaults after seed:", onChainAfterSeed?.assets.map((a) => `${a.assetMint}: ${a.vaultBalanceRaw}`));
  console.log("Supply after seed:", onChainAfterSeed?.reserveTokenSupplyRaw);
  const creatorRtAta = getAssociatedTokenAddressSync(reserveTokenMint, creator.publicKey);
  const creatorRtAfterSeed = await getAccount(connection, creatorRtAta);
  console.log("Creator Reserve Token balance after seed:", creatorRtAfterSeed.amount.toString());
  console.log("Creator SOL after create+seed:", await solBalance(creator.publicKey));

  console.log("\n=== BUY: 0.01 SOL in -> Reserve Tokens out (real executeBuyZap, same code DTRDetail.tsx calls) ===");
  const buyRes = await executeBuyZap({
    connection,
    wallet: fakeWallet(creator),
    reserveAddress: result.reserve,
    assetMints,
    userPubkey: creator.publicKey,
    solLamports: BigInt(0.01 * LAMPORTS_PER_SOL),
  });
  console.log("Buy signature:", buyRes.signature, "quote:", buyRes.quote);

  const onChainAfterBuy = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  const creatorRtAfterBuy = await getAccount(connection, creatorRtAta);
  console.log("Vaults after Buy:", onChainAfterBuy?.assets.map((a) => `${a.assetMint}: ${a.vaultBalanceRaw}`));
  console.log("Supply after Buy:", onChainAfterBuy?.reserveTokenSupplyRaw);
  console.log("Creator Reserve Token balance after Buy:", creatorRtAfterBuy.amount.toString());

  console.log("\n=== SELL: half the Reserve Token balance -> SOL out (real executeSellZap) ===");
  const sellAmount = creatorRtAfterBuy.amount / 2n;
  const solBefore = await solBalance(creator.publicKey);
  const sellRes = await executeSellZap({
    connection,
    wallet: fakeWallet(creator),
    reserveAddress: result.reserve,
    assetMints,
    userPubkey: creator.publicKey,
    reserveTokensToRedeem: sellAmount,
  });
  console.log("Sell signature:", sellRes.signature, "quote:", sellRes.quote);
  const solAfter = await solBalance(creator.publicKey);

  const onChainAfterSell = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  const creatorRtAfterSell = await getAccount(connection, creatorRtAta);
  console.log("Vaults after Sell:", onChainAfterSell?.assets.map((a) => `${a.assetMint}: ${a.vaultBalanceRaw}`));
  console.log("Supply after Sell:", onChainAfterSell?.reserveTokenSupplyRaw);
  console.log("Creator Reserve Token balance after Sell:", creatorRtAfterSell.amount.toString());
  console.log("Creator SOL before/after Sell:", solBefore, "->", solAfter);

  console.log("\n=== EXPLORER LINKS ===");
  console.log("Reserve:", `https://explorer.solana.com/address/${result.reserve}?cluster=devnet`);
  console.log("createAndRegister tx:", `https://explorer.solana.com/tx/${result.transactions.createAndRegister}?cluster=devnet`);
  console.log("fundSeedAssets tx:", `https://explorer.solana.com/tx/${result.transactions.fundSeedAssets}?cluster=devnet`);
  console.log("seed tx:", `https://explorer.solana.com/tx/${result.transactions.seed}?cluster=devnet`);
  console.log("Buy tx:", `https://explorer.solana.com/tx/${buyRes.signature}?cluster=devnet`);
  console.log("Sell tx:", `https://explorer.solana.com/tx/${sellRes.signature}?cluster=devnet`);

  console.log("\n=== REFRESH-PERSISTENCE CHECK (re-fetch, simulating a page refresh) ===");
  const refetched = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  console.log("Re-fetched Reserve state after 'refresh':", JSON.stringify(refetched, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
