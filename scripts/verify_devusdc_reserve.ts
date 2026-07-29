// Phase C live verification: creates a genuinely fresh Reserve backed by
// devUSDC (the real Phase B settlement token) plus mintX, through the EXACT
// SAME client code the browser uses (createReserveClient.ts, zapClient.ts),
// then Buys and Sells against it. Proves devUSDC works as a real Reserve
// asset using EXISTING deployed program instructions -- no protocol change
// was needed for Phase C. Mirrors scripts/verify_e2e_fresh_reserve.ts.
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
import { createReserveOnChain, estimateCreateReserveCost } from "../src/merge/lib/createReserveClient";
import { executeBuyZap, executeSellZap } from "../src/merge/lib/zapClient";
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
  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  const creator = Keypair.generate();
  console.log("=== Fresh creator wallet ===");
  console.log("creator pubkey:", creator.publicKey.toBase58());

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })),
    [deployer],
  );
  console.log("Funded creator with 0.1 SOL from deployer for rent + fees.");

  const mockX = DEVNET_FIXTURES.mints.mintX;
  const assets = [
    { mint: DEVUSDC.mint, weightBps: 7000, seedWeightFraction: 0.7, decimals: DEVUSDC.decimals },
    { mint: mockX.address, weightBps: 3000, seedWeightFraction: 0.3, decimals: mockX.decimals },
  ];
  const seedTotalUsd = 5;

  console.log("\n=== Cost estimate ===");
  const estimate = await estimateCreateReserveCost(connection, assets, seedTotalUsd);
  console.log({ ...estimate, totalLamports: estimate.totalLamports.toString() });

  console.log("\n=== createReserveOnChain: devUSDC (70%) + mockX (30%) ===");
  const result = await createReserveOnChain({
    connection,
    wallet: fakeWallet(creator),
    metadataUri: `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Phase C devUSDC Reserve", ticker: "PHCUSD", description: "Phase C live check", category: "DevNet" }))}`,
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
  console.log("\nVaults after seed (devUSDC vault should be ~3,500,000 raw = 3.5 devUSDC):", onChainAfterSeed?.assets.map((a) => `${a.assetMint}: ${a.vaultBalanceRaw}`));
  console.log("Supply after seed:", onChainAfterSeed?.reserveTokenSupplyRaw);
  const creatorRtAta = getAssociatedTokenAddressSync(reserveTokenMint, creator.publicKey);
  const creatorRtAfterSeed = await getAccount(connection, creatorRtAta);
  console.log("Creator Reserve Token balance after seed:", creatorRtAfterSeed.amount.toString());

  console.log("\n=== BUY: 0.01 SOL in -> Reserve Tokens out (mints real devUSDC + mockX into the vaults) ===");
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
  console.log("Vaults after Buy:", onChainAfterBuy?.assets.map((a) => `${a.assetMint}: ${a.vaultBalanceRaw}`));

  console.log("\n=== SELL: half the Reserve Token balance -> proportional devUSDC + mockX redeemed, then zapped to SOL ===");
  const creatorRtAfterBuy = await getAccount(connection, creatorRtAta);
  const sellAmount = creatorRtAfterBuy.amount / 2n;
  const sellRes = await executeSellZap({
    connection,
    wallet: fakeWallet(creator),
    reserveAddress: result.reserve,
    assetMints,
    userPubkey: creator.publicKey,
    reserveTokensToRedeem: sellAmount,
  });
  console.log("Sell signature:", sellRes.signature, "quote:", sellRes.quote);
  const onChainAfterSell = await fetchReserveOnChain(connection, programId, new PublicKey(result.reserve), assetMints.map((m) => new PublicKey(m)));
  console.log("Vaults after Sell:", onChainAfterSell?.assets.map((a) => `${a.assetMint}: ${a.vaultBalanceRaw}`));
  console.log("Supply after Sell:", onChainAfterSell?.reserveTokenSupplyRaw);

  console.log("\n=== EXPLORER LINKS ===");
  console.log("Reserve:", `https://explorer.solana.com/address/${result.reserve}?cluster=devnet`);
  console.log("createAndRegister tx:", `https://explorer.solana.com/tx/${result.transactions.createAndRegister}?cluster=devnet`);
  console.log("fundSeedAssets tx:", `https://explorer.solana.com/tx/${result.transactions.fundSeedAssets}?cluster=devnet`);
  console.log("seed tx:", `https://explorer.solana.com/tx/${result.transactions.seed}?cluster=devnet`);
  console.log("Buy tx:", `https://explorer.solana.com/tx/${buyRes.signature}?cluster=devnet`);
  console.log("Sell tx:", `https://explorer.solana.com/tx/${sellRes.signature}?cluster=devnet`);

  console.log("\nCONFIRMED: devUSDC works as a real Reserve asset via existing deployed instructions -- create_reserve, initialize_reserve_asset, seed_reserve, mint_reserve_tokens_in_kind, redeem_reserve_tokens_in_kind. No protocol/program change was required for Phase C.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
