// Minimal Mainnet smoke test (Phase 6). Creates one small USDC-only test
// Reserve and exercises the core lifecycle plus the authority model, using
// only trivial real amounts. Run ONCE, by Creator, after initialize_protocol
// and IDL publication are both verified.
//
// Never touches private key material -- the signer keypair is loaded purely
// from the file path in ANCHOR_WALLET.
//
// Usage (from repo root):
//   export ANCHOR_WALLET="<path to the CgHFxD4X... keypair file>"
//   export TS_NODE_PROJECT="scripts/tsconfig.json"
//   export TS_NODE_TRANSPILE_ONLY=true
//   npx ts-node --require ts-node/register scripts/mainnet_smoke_test.ts

import * as anchor from "@anchor-lang/core";
import { Program, Wallet, BN } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  findReserve,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
  findReserveTokenMint,
  findMintAuthority,
  resolveProtocolFeeDestinationTokenAccount,
} from "../packages/sdk/src/pda";

const EXPECTED_AUTHORITY = new PublicKey("CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8");
const TREASURY_VAULT = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config");

function loadMainnetRpcUrl(): string {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  const match = content.match(/^HELIUS_MAINNET_RPC_URL="([^"]+)"/m);
  if (!match) throw new Error("HELIUS_MAINNET_RPC_URL not found in .env.local");
  return match[1];
}

function loadWalletKeypair(): Keypair {
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error("ANCHOR_WALLET env var required.");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
  return Keypair.fromSecretKey(secretKey);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const rpcUrl = loadMainnetRpcUrl();
  const keypair = loadWalletKeypair();
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const signer = provider.wallet.publicKey;
  if (!signer.equals(EXPECTED_AUTHORITY)) {
    throw new Error(`STOP: signer ${signer.toBase58()} does not match ${EXPECTED_AUTHORITY.toBase58()}.`);
  }

  const idlPath = path.resolve(__dirname, "..", "packages", "sdk", "idl", "ssr_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl as anchor.Idl, provider) as Program<anchor.Idl>;
  const programId = program.programId;
  console.log("Program:", programId.toBase58());

  const [protocolConfig] = PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], programId);
  const configBefore = await (program.account as any).protocolConfig.fetch(protocolConfig);
  console.log("\n=== 1. Program/IDL/ProtocolConfig load ===");
  console.log("  authority:", configBefore.authority.toBase58());
  console.log("  admin2:   ", configBefore.admin2.toBase58());
  console.log("  paused:   ", configBefore.paused);
  console.log("  defaultProtocolFeeDestination:", configBefore.defaultProtocolFeeDestination.toBase58());

  // === 2. Unauthorized wallet rejected ===
  console.log("\n=== 2. Unauthorized wallet rejected ===");
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: signer, toPubkey: stranger.publicKey, lamports: 2_000_000 }),
    ),
    [keypair],
  );
  let strangerRejected = false;
  try {
    await program.methods
      .setProtocolPaused(true)
      .accounts({ protocolConfig, authority: stranger.publicKey })
      .signers([stranger])
      .rpc();
  } catch (e: any) {
    strangerRejected = true;
    console.log("  Rejected as expected:", (e.message ?? String(e)).slice(0, 120));
  }
  if (!strangerRejected) throw new Error("STOP: unauthorized wallet was NOT rejected!");

  // === 3. Pause/unpause (Creator, reversible) ===
  console.log("\n=== 3. Pause/unpause by Creator (reversible) ===");
  const pauseSig = await program.methods
    .setProtocolPaused(true)
    .accounts({ protocolConfig, authority: signer })
    .rpc();
  console.log("  Paused. Signature:", pauseSig);
  let cfg = await (program.account as any).protocolConfig.fetch(protocolConfig);
  console.log("  paused =", cfg.paused);
  const unpauseSig = await program.methods
    .setProtocolPaused(false)
    .accounts({ protocolConfig, authority: signer })
    .rpc();
  console.log("  Unpaused. Signature:", unpauseSig);
  cfg = await (program.account as any).protocolConfig.fetch(protocolConfig);
  console.log("  paused =", cfg.paused);

  // === 4. Treasury vault can receive SOL ===
  console.log("\n=== 4. Treasury vault SOL receipt ===");
  const treasuryBalBefore = await connection.getBalance(TREASURY_VAULT);
  const solSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: signer, toPubkey: TREASURY_VAULT, lamports: 100_000 }),
    ),
    [keypair],
  );
  const treasuryBalAfter = await connection.getBalance(TREASURY_VAULT);
  console.log("  Signature:", solSig);
  console.log(`  Treasury vault SOL balance: ${treasuryBalBefore} -> ${treasuryBalAfter}`);
  if (treasuryBalAfter !== treasuryBalBefore + 100_000) throw new Error("STOP: Treasury vault SOL receipt mismatch!");

  // === 5. Create a minimal USDC-only test Reserve ===
  console.log("\n=== 5. Create Reserve (USDC-only) ===");
  const reserveId = BigInt(configBefore.reserveCount.toString());
  const [reserve] = findReserve(reserveId, programId);
  const [reserveTokenMint] = findReserveTokenMint(reserve, programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  const [reserveAsset] = findReserveAsset(reserve, USDC_MINT, programId);
  const [vault] = findReserveVault(reserve, USDC_MINT, programId);

  const createSig = await program.methods
    .createReserve(
      "https://strategic-super-reserve.fun/reserves/mainnet-smoke-test.json",
      50, // mint_fee_bps (0.5%) -- nonzero so fee routing can be genuinely exercised
      0, // redemption_fee_bps
      0, // annual_tvl_fee_bps -- off, avoids time-based complexity for this test
      signer, // fee_destination (Manager fee destination -- Creator itself, test only)
    )
    .accounts({
      protocolConfig,
      reserve,
      mintAuthority,
      reserveTokenMint,
      manager: signer,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  Reserve:", reserve.toBase58(), "reserveId:", reserveId.toString());
  console.log("  Signature:", createSig);

  console.log("\n=== 6. Register USDC as the sole Reserve Asset (100%) ===");
  const initAssetSig = await program.methods
    .initializeReserveAsset(10000)
    .accounts({
      protocolConfig,
      reserve,
      reserveAsset,
      assetMint: USDC_MINT,
      vault,
      vaultAuthority,
      manager: signer,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  Signature:", initAssetSig);

  // === 7. Seed the Reserve with 1 USDC ===
  console.log("\n=== 7. Seed Reserve with 1 USDC ===");
  const managerUsdcAta = await getOrCreateAssociatedTokenAccount(connection, keypair, USDC_MINT, signer);
  const managerReserveTokenAccount = await getOrCreateAssociatedTokenAccount(connection, keypair, reserveTokenMint, signer);
  const protocolFeeDestTokenAccountSeed = resolveProtocolFeeDestinationTokenAccount(
    TREASURY_VAULT,
    signer,
    reserveTokenMint,
    programId,
  );

  const seedAmount = new BN(1_000_000); // 1 USDC (6 decimals)
  const seedSig = await program.methods
    .seedReserve([seedAmount], new BN(1_000_000))
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      managerReserveTokenAccount: managerReserveTokenAccount.address,
      manager: signer,
      protocolFeeDestinationTokenAccount: protocolFeeDestTokenAccountSeed,
      protocolFeeDestination: TREASURY_VAULT,
      tvlAccrual: PublicKey.findProgramAddressSync([Buffer.from("tvl_accrual"), reserve.toBuffer()], programId)[0],
      managerFeeRecipients: programId, // sentinel: no multi-recipient routing for this test
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: reserveAsset, isWritable: false, isSigner: false },
      { pubkey: vault, isWritable: true, isSigner: false },
      { pubkey: managerUsdcAta.address, isWritable: true, isSigner: false },
      { pubkey: USDC_MINT, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .rpc();
  console.log("  Signature:", seedSig);
  const vaultAfterSeed = await getAccount(connection, vault);
  const rtAfterSeed = await getAccount(connection, managerReserveTokenAccount.address);
  console.log("  USDC vault balance:", vaultAfterSeed.amount.toString());
  console.log("  Manager Reserve Token balance:", rtAfterSeed.amount.toString());

  // === 8. Mint a bit more (proves lifecycle continues past seed) ===
  console.log("\n=== 8. Mint additional Reserve Tokens ===");
  const protocolFeeDestTokenAccountMint = resolveProtocolFeeDestinationTokenAccount(
    TREASURY_VAULT,
    signer,
    reserveTokenMint,
    programId,
  );
  const mintSig = await program.methods
    .mintReserveTokensInKind(new BN(200_000), new BN(1), [new BN(500_000)])
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      depositorReserveTokenAccount: managerReserveTokenAccount.address,
      depositor: signer,
      protocolFeeDestinationTokenAccount: protocolFeeDestTokenAccountMint,
      protocolFeeDestination: TREASURY_VAULT,
      tvlAccrual: PublicKey.findProgramAddressSync([Buffer.from("tvl_accrual"), reserve.toBuffer()], programId)[0],
      managerFeeRecipients: programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: reserveAsset, isWritable: false, isSigner: false },
      { pubkey: vault, isWritable: true, isSigner: false },
      { pubkey: managerUsdcAta.address, isWritable: true, isSigner: false },
      { pubkey: USDC_MINT, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .rpc();
  console.log("  Signature:", mintSig);
  const rtAfterMint = await getAccount(connection, managerReserveTokenAccount.address);
  console.log("  Manager Reserve Token balance now:", rtAfterMint.amount.toString());

  const treasuryRtAta = await getOrCreateAssociatedTokenAccount(connection, keypair, reserveTokenMint, TREASURY_VAULT, true);
  console.log("  Treasury Reserve Token balance (instant protocol mint-fee share):", (await getAccount(connection, treasuryRtAta.address)).amount.toString());

  // === 9. Redeem some Reserve Tokens back for USDC ===
  console.log("\n=== 9. Redeem Reserve Tokens for USDC ===");
  const rtBalanceBefore = (await getAccount(connection, managerReserveTokenAccount.address)).amount;
  const redeemAmount = new BN(rtBalanceBefore.toString()).div(new BN(4));
  const usdcBefore = (await getAccount(connection, managerUsdcAta.address)).amount;
  const redeemSig = await program.methods
    .redeemReserveTokensInKind(redeemAmount, [new BN(0)])
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority,
      redeemerReserveTokenAccount: managerReserveTokenAccount.address,
      redeemer: signer,
      // managerFeeRecipients/tvlAccrual: redeem_reserve_tokens_in_kind.rs
      // requires both even though the test-suite pattern this was originally
      // copied from omitted them -- caught live via AccountNotInitialized
      // (error 3012) during this pass's smoke test.
      managerFeeRecipients: programId,
      tvlAccrual: PublicKey.findProgramAddressSync([Buffer.from("tvl_accrual"), reserve.toBuffer()], programId)[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: reserveAsset, isWritable: false, isSigner: false },
      { pubkey: vault, isWritable: true, isSigner: false },
      { pubkey: managerUsdcAta.address, isWritable: true, isSigner: false },
      { pubkey: USDC_MINT, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .rpc();
  console.log("  Signature:", redeemSig);
  // A read immediately after confirmation can hit a stale RPC replica behind
  // the node that confirmed the tx (observed live via Helius during this
  // pass) -- a short delay avoids a false-negative here.
  await sleep(3000);
  const usdcAfter = (await getAccount(connection, managerUsdcAta.address)).amount;
  console.log(`  USDC balance: ${usdcBefore.toString()} -> ${usdcAfter.toString()}`);
  if (usdcAfter <= usdcBefore) throw new Error("STOP: redeem did not increase USDC balance!");

  // === 10. Collect the protocol's pending fee share (fee routing to Treasury) ===
  console.log("\n=== 10. Collect protocol fee share (routes to Treasury vault) ===");
  const reserveAfterMint = await (program.account as any).reserve.fetch(reserve);
  const pending = reserveAfterMint.feeConfig.pendingProtocolFeeShares?.toString?.() ?? "0";
  console.log("  pendingProtocolFeeShares:", pending);
  if (pending !== "0") {
    const treasuryRtBefore = (await getAccount(connection, treasuryRtAta.address)).amount;
    const collectSig = await program.methods
      .collectProtocolFee()
      .accounts({
        protocolConfig,
        reserve,
        reserveTokenMint,
        mintAuthority,
        protocolFeeDestinationTokenAccount: treasuryRtAta.address,
        protocolFeeDestination: TREASURY_VAULT,
        payer: signer,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const treasuryRtAfter = (await getAccount(connection, treasuryRtAta.address)).amount;
    console.log("  Signature:", collectSig);
    console.log(`  Treasury Reserve Token balance: ${treasuryRtBefore.toString()} -> ${treasuryRtAfter.toString()}`);
  } else {
    console.log("  Nothing pending (protocol fee share was already instant-minted at mint time) -- skipping, no separate collect needed.");
  }

  // === 11. Reserve Assets remain in program-controlled PDA (structural check) ===
  console.log("\n=== 11. Reserve Asset custody check ===");
  const vaultInfo = await connection.getAccountInfo(vault);
  console.log("  Vault owner (should be Token Program):", vaultInfo?.owner.toBase58());
  const finalVault = await getAccount(connection, vault);
  console.log("  Vault token-account authority (should be vaultAuthority PDA):", finalVault.owner.toBase58(), "==", vaultAuthority.toBase58());
  if (finalVault.owner.toBase58() !== vaultAuthority.toBase58()) throw new Error("STOP: vault authority mismatch!");

  console.log("\n=== SMOKE TEST COMPLETE ===");
  console.log("Reserve:", reserve.toBase58());
  console.log("Reserve Token Mint:", reserveTokenMint.toBase58());
}

main().catch((e) => {
  console.error("\nFAILED:", e.message ?? e);
  process.exit(1);
});
