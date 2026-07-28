// Verifies the Buy/Sell zap instruction builders (packages/sdk/src/zapInstructions.ts)
// actually work against live DevNet: builds the exact same atomic, dual-signer
// transactions the browser will build, but signs the "user" side with a
// throwaway funded keypair instead of Phantom (no browser automation
// available in this environment). Real evidence: vault balances, Reserve
// Token supply, and both parties' balances are checked before/after.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import * as path from "path";
import {
  DEVNET_FIXTURES,
  buildReadOnlyProgram,
  fetchReserveOnChain,
  buildBuyZapInstructions,
  buildSellZapInstructions,
} from "../packages/sdk/src";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const ASSET_TEST_PRICES_USD: Record<string, number> = {
  [DEVNET_FIXTURES.mints.mintX.address]: 1,
  [DEVNET_FIXTURES.mints.mintY.address]: 1,
  [DEVNET_FIXTURES.mints.mintZ.address]: 1,
};

function loadKeypair(name: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "devnet-fixtures", `${name}-keypair.json`), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const swapAuthority = loadKeypair("manager"); // reused: already the mint authority + a Reserve manager, see DEC-0026/DEVNET_FIXTURES.md
  const deployerSecret = JSON.parse(fs.readFileSync("C:\\Users\\JRA DEVNET\\.config\\solana\\devnet-deployer.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  const user = Keypair.generate();

  console.log("Funding throwaway user wallet:", user.publicKey.toBase58());
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: user.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
    ),
    [deployer],
  );

  const fixture = DEVNET_FIXTURES.reserveOne;
  const reserve = new PublicKey(fixture.reserve);
  const reserveTokenMint = new PublicKey(fixture.reserveTokenMint);
  const mintAuthority = new PublicKey(fixture.mintAuthority);
  const vaultAuthority = new PublicKey(fixture.vaultAuthority);
  const [protocolConfig] = PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], programId);

  const assetMints = fixture.assets.map((a) => new PublicKey(a.mint));

  console.log("\n=== BEFORE ===");
  const before = await fetchReserveOnChain(connection, programId, reserve, assetMints);
  console.log("supply:", before!.reserveTokenSupplyRaw, "vaults:", before!.assets.map((a) => `${a.assetMint.slice(0, 6)}=${a.vaultBalanceRaw}`));
  const swapAuthorityBalBefore = await connection.getBalance(swapAuthority.publicKey);
  const userSolBefore = await connection.getBalance(user.publicKey);

  const program = buildReadOnlyProgram(connection) as unknown as anchor.Program<anchor.Idl>;

  const zapAssets = before!.assets.map((a) => ({
    mint: a.assetMint,
    decimals: a.decimals,
    reserveAsset: a.reserveAsset,
    vault: a.vault,
    vaultBalanceRaw: a.vaultBalanceRaw,
  }));

  console.log("\n=== BUY: zapping 0.005 SOL in ===");
  const buySolLamports = BigInt(0.005 * LAMPORTS_PER_SOL);
  const buyResult = await buildBuyZapInstructions({
    program,
    protocolConfig,
    reserve,
    reserveTokenMint,
    mintAuthority,
    user: user.publicKey,
    swapAuthority: swapAuthority.publicKey,
    assets: zapAssets,
    reserveTokenSupplyRaw: before!.reserveTokenSupplyRaw,
    solLamports: buySolLamports,
    assetTestPricesUsd: ASSET_TEST_PRICES_USD,
  });
  console.log("reserveTokensRequested (raw):", buyResult.reserveTokensRequested?.toString());
  console.log("assetAmountsRaw:", buyResult.assetAmountsRaw.map((a) => a.toString()));

  const buyTx = new Transaction().add(...buyResult.instructions);
  buyTx.feePayer = user.publicKey;
  const buySig = await sendAndConfirmTransaction(connection, buyTx, [user, swapAuthority]);
  console.log("BUY tx signature:", buySig);

  const userReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user.publicKey);
  const userRtBalanceAfterBuy = await getAccount(connection, userReserveTokenAta);
  console.log("user Reserve Token balance after buy:", userRtBalanceAfterBuy.amount.toString());

  const afterBuy = await fetchReserveOnChain(connection, programId, reserve, assetMints);
  console.log("supply after buy:", afterBuy!.reserveTokenSupplyRaw, "vaults:", afterBuy!.assets.map((a) => `${a.assetMint.slice(0, 6)}=${a.vaultBalanceRaw}`));

  console.log("\n=== SELL: redeeming half the user's new Reserve Tokens ===");
  const reserveTokensToRedeem = userRtBalanceAfterBuy.amount / 2n;
  const sellResult = await buildSellZapInstructions({
    program,
    reserve,
    reserveTokenMint,
    vaultAuthority,
    user: user.publicKey,
    swapAuthority: swapAuthority.publicKey,
    assets: afterBuy!.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw })),
    reserveTokenSupplyRaw: afterBuy!.reserveTokenSupplyRaw,
    redemptionFeeBps: 0n,
    reserveTokensToRedeem,
    assetTestPricesUsd: ASSET_TEST_PRICES_USD,
  });
  console.log("assetAmountsRaw (entitlements):", sellResult.assetAmountsRaw.map((a) => a.toString()));
  console.log("solLamportsOut:", sellResult.solLamportsOut.toString());

  const sellTx = new Transaction().add(...sellResult.instructions);
  sellTx.feePayer = user.publicKey;
  const sellSig = await sendAndConfirmTransaction(connection, sellTx, [user, swapAuthority]);
  console.log("SELL tx signature:", sellSig);

  const userRtBalanceAfterSell = await getAccount(connection, userReserveTokenAta);
  const userSolAfter = await connection.getBalance(user.publicKey);
  const swapAuthorityBalAfter = await connection.getBalance(swapAuthority.publicKey);
  const afterSell = await fetchReserveOnChain(connection, programId, reserve, assetMints);

  console.log("\n=== AFTER SELL ===");
  console.log("user Reserve Token balance after sell:", userRtBalanceAfterSell.amount.toString());
  console.log("supply after sell:", afterSell!.reserveTokenSupplyRaw, "vaults:", afterSell!.assets.map((a) => `${a.assetMint.slice(0, 6)}=${a.vaultBalanceRaw}`));
  console.log("user SOL: before=", userSolBefore, "after=", userSolAfter, "delta=", userSolAfter - userSolBefore);
  console.log("swapAuthority SOL: before=", swapAuthorityBalBefore, "after=", swapAuthorityBalAfter, "delta=", swapAuthorityBalAfter - swapAuthorityBalBefore);

  console.log("\n=== EXPLORER LINKS ===");
  console.log("Buy tx:", `https://explorer.solana.com/tx/${buySig}?cluster=devnet`);
  console.log("Sell tx:", `https://explorer.solana.com/tx/${sellSig}?cluster=devnet`);
  console.log("User wallet:", `https://explorer.solana.com/address/${user.publicKey.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
