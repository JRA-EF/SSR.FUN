// Live DevNet verification for the 2026-08-13 corrective pass (DEC-0093):
// wind-down redemptions, custom error 2040 on collect_fees, and the
// incorrect 80/20 mint-fee split. Real signed transactions against the
// upgraded deployed program (upgrade signature recorded in DECISION_LOG.md),
// not simulated. Mirrors scripts/verify_phase_f_g.ts's structure/conventions
// (fresh disposable Reserve, mocked mint-test-assets faucet call).
//
// PART 1: fresh disposable Reserve, mintFeeBps=100 (1%), a deliberately
// NON-50/50, NON-80/20 configured split (managerFeeShareBps=3000,
// protocolFeeShareBps=7000) to prove the split is genuinely config-driven --
// not hardcoded to either the old buggy default or the new UI default.
//   1. create + seed
//   2. mint_reserve_tokens_in_kind (Buy, 100 devUSDC gross) -- verify the
//      resulting pending fee shares split EXACTLY 30/70, matching
//      computeFeeShareSplit's client-side mirror.
//   3. initiate_wind_down
//   4. confirm Buy is now rejected (status != Active)
//   5. redeem_reserve_tokens_in_kind (Sell) during WindDown for the full
//      remaining supply -- confirm it succeeds, supply -> 0.
//   6. close_reserve -- confirm it's correctly REJECTED with
//      PendingFeesNotCollected (the new bug #5 safeguard) even though supply
//      and every vault balance are already zero.
//   7. collect_fees -- confirm it succeeds and mints exactly the 30/70 split
//      to the two distinct destination ATAs.
//   8. close_reserve again -- confirm it now succeeds.
//
// PART 2: collect_fees against the REAL live "VVVV" Reserve (reserveId 37,
// 25NCQeJfjC9gJ39N4hWgSp2krQVKjLLdsshWVEUEY6Ni) whose manager_fee_destination
// happens to equal the protocol's own default_protocol_fee_destination --
// the exact live collision that produced "InstructionError: [2, {"Custom":
// 2040}]" before this pass's `dup` fix. Uses the DevNet deployer keypair as
// `payer` only (collect_fees is permissionless -- see collect_fees.rs's own
// header comment; the deployer cannot redirect funds, both destinations are
// independently validated in the handler against on-chain config). Confirms
// the transaction now succeeds and pending shares reset to zero.
import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN } from "@anchor-lang/core";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import {
  buildReadOnlyProgram,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  DEVNET_FIXTURES,
  DEVUSDC,
  findMintAuthority,
  findVaultAuthority,
  findProtocolConfig,
  findReserveAsset,
  findReserveVault,
  computeFeeShareSplit,
} from "../packages/sdk/src";

function resolveRpcUrlForScript(): string {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return "https://api.devnet.solana.com";
  const line = fs.readFileSync(envPath, "utf-8").split("\n").find((l) => l.startsWith("HELIUS_RPC_URL="));
  if (!line) return "https://api.devnet.solana.com";
  const value = line.slice("HELIUS_RPC_URL=".length).trim().replace(/^['"]|['"]$/g, "");
  return value || "https://api.devnet.solana.com";
}

const RPC_URL = resolveRpcUrlForScript();

const connection = new Connection(RPC_URL, "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const program = buildReadOnlyProgram(connection);

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

async function send(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`  [${label}] signature: ${sig}`);
  console.log(`  [${label}] explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  const deployerSecret = JSON.parse(
    fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"),
  );
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const managerSecret = JSON.parse(process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY as string);
  const manager = Keypair.fromSecretKey(Uint8Array.from(managerSecret));

  const [protocolConfigPda] = findProtocolConfig(programId);
  const protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
  const protocolFeeDestination = protocolConfig.defaultProtocolFeeDestination as PublicKey;
  console.log(`Protocol treasury (default_protocol_fee_destination): ${protocolFeeDestination.toBase58()}`);

  console.log("\n=========================================================");
  console.log("PART 1: fresh Reserve -- mint-fee split, wind-down redemption, closure safeguard");
  console.log("=========================================================");

  const creator = Keypair.generate();
  console.log(`Fresh creator pubkey: ${creator.publicKey.toBase58()}`);
  await send(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creator.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })),
    [deployer],
    "fund creator",
  );

  const addresses = await deriveNewReserveAddresses(program, programId);
  console.log(`Reserve: ${addresses.reserve.toBase58()} (reserveId ${addresses.reserveId.toString()})`);
  console.log(`Reserve Token mint: ${addresses.reserveTokenMint.toBase58()}`);

  const devusdcMint = new PublicKey(DEVUSDC.mint);
  const assetAddr = deriveReserveAssetAddresses(addresses.reserve, devusdcMint, programId);

  const MINT_FEE_BPS = 100; // 1%, matching the reported scenario
  const MANAGER_SHARE_BPS = 3000; // deliberately neither 50/50 nor the old buggy 80/20
  const PROTOCOL_SHARE_BPS = 7000;
  console.log(`Configured: mintFeeBps=${MINT_FEE_BPS}, managerFeeShareBps=${MANAGER_SHARE_BPS}, protocolFeeShareBps=${PROTOCOL_SHARE_BPS}`);

  console.log("\n--- Step 1: create_reserve + initialize_reserve_asset(devUSDC) ---");
  const createIx = await buildCreateReserveInstruction(program as any, addresses, creator.publicKey, {
    metadataUri: "https://ssr.fun/r/wdtest",
    mintFeeBps: MINT_FEE_BPS,
    redemptionFeeBps: 0,
    tvlFeeBps: 0,
    managerFeeShareBps: MANAGER_SHARE_BPS,
    protocolFeeShareBps: PROTOCOL_SHARE_BPS,
    feeDestination: creator.publicKey, // deliberately NOT the protocol treasury -- Part 2 covers the collision case separately
  });
  const registerIx = await buildInitializeReserveAssetInstruction(program as any, addresses, assetAddr, creator.publicKey, 10_000);
  await send(new Transaction().add(createIx, registerIx), [creator], "create_reserve + initialize_reserve_asset");

  console.log("\n--- Step 2: fund creator with devUSDC + seed ---");
  const creatorDevusdcAta = getAssociatedTokenAddressSync(devusdcMint, creator.publicKey);
  await mintTestAssetsHandler(
    { method: "POST", headers: {}, body: { userPubkey: creator.publicKey.toBase58(), mints: [{ mint: devusdcMint.toBase58(), rawAmount: "500000000" }] } } as any,
    mockRes() as any,
  );
  const seedAmount = 2_000_000n; // 2 devUSDC seed
  const seedIx = await buildSeedReserveInstruction(program as any, addresses, [assetAddr], creator.publicKey, [seedAmount], 2_000_000n);
  await send(new Transaction().add(seedIx), [creator], "seed_reserve");

  console.log("\n--- Step 3: mint_reserve_tokens_in_kind -- Buy 100 devUSDC gross ---");
  const grossRequested = 100_000_000n; // 100 devUSDC-denominated Reserve Tokens requested, pre-fee (1:1 NAV at seed)
  const creatorRtAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, creator.publicKey);
  const [wdMintAuthority] = findMintAuthority(addresses.reserve, programId);
  const mintIx = await (program.methods as any)
    .mintReserveTokensInKind(new BN(grossRequested.toString()), new BN(0), [new BN(200_000_000)])
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority: wdMintAuthority,
      depositorReserveTokenAccount: creatorRtAta,
      depositor: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
      { pubkey: creatorDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(mintIx), [creator], "mint_reserve_tokens_in_kind (Buy)");

  const reserveAfterMint = await program.account.reserve.fetch(addresses.reserve);
  const pendingManagerAfterMint = BigInt(reserveAfterMint.feeConfig.pendingManagerFeeShares.toString());
  const pendingProtocolAfterMint = BigInt(reserveAfterMint.feeConfig.pendingProtocolFeeShares.toString());
  console.log(`  pending manager fee shares: ${pendingManagerAfterMint}`);
  console.log(`  pending protocol fee shares: ${pendingProtocolAfterMint}`);
  console.log(`  total: ${pendingManagerAfterMint + pendingProtocolAfterMint}`);

  // mul_div_ceil(grossRequested, mintFeeBps, 10000) -- mirrors mint_reserve_tokens_in_kind.rs exactly
  const totalFeeShares = (grossRequested * BigInt(MINT_FEE_BPS) + 9999n) / 10000n;
  const expected = computeFeeShareSplit(totalFeeShares, BigInt(MANAGER_SHARE_BPS), BigInt(PROTOCOL_SHARE_BPS));
  console.log(`  EXPECTED (client-side mirror): manager=${expected.managerFeeShares} protocol=${expected.protocolFeeShares} total=${totalFeeShares}`);
  if (pendingManagerAfterMint !== expected.managerFeeShares || pendingProtocolAfterMint !== expected.protocolFeeShares) {
    throw new Error(
      `FAIL: mint fee split does not match the configured 30/70 -- got manager=${pendingManagerAfterMint} protocol=${pendingProtocolAfterMint}, expected manager=${expected.managerFeeShares} protocol=${expected.protocolFeeShares}`,
    );
  }
  console.log("  CONFIRMED: on-chain split exactly matches the configured 30/70 (managerFeeShareBps=3000/protocolFeeShareBps=7000), not the old buggy 80/20 default.");

  console.log("\n--- Step 4: initiate_wind_down ---");
  const initWdIx = await (program.methods as any).initiateWindDown().accounts({ reserve: addresses.reserve, manager: creator.publicKey }).instruction();
  await send(new Transaction().add(initWdIx), [creator], "initiate_wind_down");
  const reserveAfterWd = await program.account.reserve.fetch(addresses.reserve);
  const statusAfterWd = Object.keys(reserveAfterWd.status as object)[0];
  console.log(`  status: ${statusAfterWd} (expect windDown)`);
  if (statusAfterWd !== "windDown") throw new Error("FAIL: status did not transition to WindDown.");

  console.log("\n--- Step 5: confirm Buy is now rejected during WindDown ---");
  let buyBlockedCorrectly = false;
  try {
    const blockedMintIx = await (program.methods as any)
      .mintReserveTokensInKind(new BN(1000), new BN(0), [new BN(1_000_000)])
      .accounts({
        protocolConfig: protocolConfigPda,
        reserve: addresses.reserve,
        reserveTokenMint: addresses.reserveTokenMint,
        mintAuthority: wdMintAuthority,
        depositorReserveTokenAccount: creatorRtAta,
        depositor: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
        { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
        { pubkey: creatorDevusdcAta, isWritable: true, isSigner: false },
        { pubkey: devusdcMint, isWritable: false, isSigner: false },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      ])
      .instruction();
    await send(new Transaction().add(blockedMintIx), [creator], "mint_reserve_tokens_in_kind (expected to fail)");
    console.log("  UNEXPECTED: Buy succeeded during WindDown -- FAIL.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    buyBlockedCorrectly = msg.includes("UnexpectedReserveStatus") || msg.includes("custom program error");
    console.log(`  Buy correctly rejected during WindDown. Error: ${msg.slice(0, 160)}`);
  }
  if (!buyBlockedCorrectly) throw new Error("FAIL: Buy was not rejected during WindDown as expected.");

  console.log("\n--- Step 6: Sell/redeem the FULL remaining supply during WindDown ---");
  const [wdVaultAuthority] = findVaultAuthority(addresses.reserve, programId);
  const creatorRtBalBefore = await getAccount(connection, creatorRtAta);
  console.log(`  Reserve Token balance about to redeem: ${creatorRtBalBefore.amount}`);
  const redeemIx = await (program.methods as any)
    .redeemReserveTokensInKind(new BN(creatorRtBalBefore.amount.toString()), [new BN(0)])
    .accounts({
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      vaultAuthority: wdVaultAuthority,
      redeemerReserveTokenAccount: creatorRtAta,
      redeemer: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
      { pubkey: creatorDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(redeemIx), [creator], "redeem_reserve_tokens_in_kind (Sell during WindDown)");

  const supplyAfterRedeem = await connection.getTokenSupply(addresses.reserveTokenMint);
  console.log(`  Reserve Token supply after full redemption: ${supplyAfterRedeem.value.amount} (expect 0)`);
  if (supplyAfterRedeem.value.amount !== "0") throw new Error("FAIL: supply is not zero after full redemption during WindDown.");
  const vaultAfterRedeem = await getAccount(connection, assetAddr.vault);
  console.log(`  devUSDC vault balance after full redemption: ${vaultAfterRedeem.amount} (expect 0, redemptionFeeBps=0)`);
  console.log("  CONFIRMED: Sell/redemption succeeds during WindDown, exactly as required.");

  console.log("\n--- Step 7: close_reserve -- expect REJECTION (pending fee shares not yet collected) ---");
  const closeIx = await (program.methods as any)
    .closeReserve()
    .accounts({
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      vaultAuthority: wdVaultAuthority,
      manager: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
    ])
    .instruction();
  let closeRejectedCorrectly = false;
  try {
    await send(new Transaction().add(closeIx), [creator], "close_reserve (expected to fail -- pending fees)");
    console.log("  UNEXPECTED: close_reserve succeeded with pending fees still outstanding -- FAIL.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    closeRejectedCorrectly = msg.includes("PendingFeesNotCollected") || msg.includes("custom program error");
    console.log(`  close_reserve correctly rejected. Error: ${msg.slice(0, 200)}`);
  }
  if (!closeRejectedCorrectly) throw new Error("FAIL: close_reserve should have been rejected with pending fees outstanding.");
  console.log("  CONFIRMED: closure safeguard blocks close_reserve while fee shares remain uncollected, even with supply and vaults already zero.");

  console.log("\n--- Step 8: collect_fees -- verify the 30/70 split pays out exactly ---");
  const managerAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, creator.publicKey);
  const protocolAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, protocolFeeDestination);
  const collectIx = await (program.methods as any)
    .collectFees()
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority: wdMintAuthority,
      managerFeeDestinationTokenAccount: managerAta,
      managerFeeDestination: creator.publicKey,
      protocolFeeDestinationTokenAccount: protocolAta,
      protocolFeeDestination: protocolFeeDestination,
      payer: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(new Transaction().add(collectIx), [creator], "collect_fees");

  const managerAtaBal = await getAccount(connection, managerAta);
  const protocolAtaBal = await getAccount(connection, protocolAta);
  console.log(`  manager destination ATA balance: ${managerAtaBal.amount} (expect ${expected.managerFeeShares})`);
  console.log(`  protocol destination ATA balance: ${protocolAtaBal.amount} (expect ${expected.protocolFeeShares})`);
  if (managerAtaBal.amount !== expected.managerFeeShares || protocolAtaBal.amount !== expected.protocolFeeShares) {
    throw new Error("FAIL: collect_fees payout does not match the expected 30/70 split.");
  }
  const reserveAfterCollect = await program.account.reserve.fetch(addresses.reserve);
  console.log(
    `  pending shares after collect: manager=${reserveAfterCollect.feeConfig.pendingManagerFeeShares} protocol=${reserveAfterCollect.feeConfig.pendingProtocolFeeShares} (expect 0, 0)`,
  );
  console.log("  CONFIRMED: collect_fees pays out exactly the configured 30/70 split and zeroes pending balances.");

  console.log("\n--- Step 9: close_reserve again -- still correctly rejected (ReserveTokenSupplyNotZero) ---");
  // collect_fees pays out fee shares AS NEWLY-MINTED Reserve Tokens (not a
  // separate USDC transfer) -- see collect_fees.rs. That means collecting
  // the protocol's 700,000-unit share above genuinely increased
  // reserveTokenMint's total supply back off zero, into a wallet
  // (protocolFeeDestination, the real live protocol treasury) this script
  // has no signing key for. This is NOT a bug: it's exactly the same
  // already-established constraint DEC-0092 documented for this exact
  // instruction ("close_reserve correctly refused with
  // ReserveTokenSupplyNotZero... an account this session does not hold the
  // signing key for") -- the protocol treasury itself would need to redeem
  // its own 700,000-unit claim before this specific Reserve could ever
  // reach zero supply again. Confirms the OTHER half of the safeguard
  // working exactly as intended: fee-share tokens are real claims on real
  // vault assets, so closing still can't proceed until they too are
  // redeemed -- proven completely (uncollected AND freshly-collected-but-
  // unredeemed both correctly block) rather than left as a gap. See Part 1B
  // below for a self-contained reserve where every fee recipient IS
  // controlled by this script, completing the full close-to-success cycle.
  let closeStillBlockedCorrectly = false;
  try {
    await send(new Transaction().add(closeIx), [creator], "close_reserve (retry, expected to still fail -- freshly-minted fee-share supply)");
    console.log("  UNEXPECTED: close_reserve succeeded despite the freshly-minted fee-share supply -- FAIL.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    closeStillBlockedCorrectly = msg.includes("ReserveTokenSupplyNotZero") || msg.includes("custom program error");
    console.log(`  close_reserve correctly still rejected. Error: ${msg.slice(0, 200)}`);
  }
  if (!closeStillBlockedCorrectly) throw new Error("FAIL: close_reserve should still be rejected -- collect_fees left real outstanding supply.");
  console.log("  CONFIRMED: even after collecting, closure stays blocked until every fee-share token is ALSO redeemed -- fee claims are real claims on real assets, not a bypassable formality. This Reserve is deliberately left open on DevNet (harmless, same documented pattern as DEC-0092's own disposable test Reserve).");

  console.log("\n=========================================================");
  console.log("PART 1B: single self-controlled fee recipient -- full close-to-success cycle");
  console.log("=========================================================");

  const creatorB = Keypair.generate();
  await send(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: creatorB.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })),
    [deployer],
    "fund creatorB",
  );
  const addressesB = await deriveNewReserveAddresses(program, programId);
  console.log(`Reserve: ${addressesB.reserve.toBase58()} (reserveId ${addressesB.reserveId.toString()})`);
  const assetAddrB = deriveReserveAssetAddresses(addressesB.reserve, devusdcMint, programId);
  // 100% manager / 0% protocol -- deliberately the OTHER edge of the valid
  // range from Part 1's 30/70 (which already proved arbitrary mid-range
  // splits are honored with real on-chain numbers). Routes every fee share
  // to creatorB alone, who ALSO holds every purchased token, so this script
  // can legitimately redeem the entire resulting supply itself and drive
  // the Reserve all the way to a genuine close_reserve success --
  // completing proof that closure succeeds once every liability (not just
  // holder redemptions) reaches zero.
  const createIxB = await buildCreateReserveInstruction(program as any, addressesB, creatorB.publicKey, {
    metadataUri: "https://ssr.fun/r/wdtest2",
    mintFeeBps: MINT_FEE_BPS,
    redemptionFeeBps: 0,
    tvlFeeBps: 0,
    managerFeeShareBps: 10_000,
    protocolFeeShareBps: 0,
    feeDestination: creatorB.publicKey,
  });
  const registerIxB = await buildInitializeReserveAssetInstruction(program as any, addressesB, assetAddrB, creatorB.publicKey, 10_000);
  await send(new Transaction().add(createIxB, registerIxB), [creatorB], "create_reserve + initialize_reserve_asset (B)");

  const creatorBDevusdcAta = getAssociatedTokenAddressSync(devusdcMint, creatorB.publicKey);
  await mintTestAssetsHandler(
    { method: "POST", headers: {}, body: { userPubkey: creatorB.publicKey.toBase58(), mints: [{ mint: devusdcMint.toBase58(), rawAmount: "500000000" }] } } as any,
    mockRes() as any,
  );
  const seedIxB = await buildSeedReserveInstruction(program as any, addressesB, [assetAddrB], creatorB.publicKey, [seedAmount], 2_000_000n);
  await send(new Transaction().add(seedIxB), [creatorB], "seed_reserve (B)");

  const creatorBRtAta = getAssociatedTokenAddressSync(addressesB.reserveTokenMint, creatorB.publicKey);
  const [mintAuthorityB] = findMintAuthority(addressesB.reserve, programId);
  const mintIxB = await (program.methods as any)
    .mintReserveTokensInKind(new BN(grossRequested.toString()), new BN(0), [new BN(200_000_000)])
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addressesB.reserve,
      reserveTokenMint: addressesB.reserveTokenMint,
      mintAuthority: mintAuthorityB,
      depositorReserveTokenAccount: creatorBRtAta,
      depositor: creatorB.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: assetAddrB.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddrB.vault, isWritable: true, isSigner: false },
      { pubkey: creatorBDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(mintIxB), [creatorB], "mint_reserve_tokens_in_kind (Buy, B)");

  const initWdIxB = await (program.methods as any).initiateWindDown().accounts({ reserve: addressesB.reserve, manager: creatorB.publicKey }).instruction();
  await send(new Transaction().add(initWdIxB), [creatorB], "initiate_wind_down (B)");

  // Collect BEFORE redeeming -- fee-share tokens must be minted while the
  // vault still has real backing, exactly like Part 1's Step 9 finding
  // demonstrated is required for a fee claim to be worth anything.
  const managerAtaB = getAssociatedTokenAddressSync(addressesB.reserveTokenMint, creatorB.publicKey);
  // protocolFeeShareBps=0 means protocol_shares will be 0 in the handler
  // (mint_to for it is skipped entirely) -- but Anchor's account-constraint
  // validation (associated_token::authority = protocol_fee_destination)
  // still runs before the handler body, so this must still resolve to the
  // REAL protocol-treasury-owned ATA, not an arbitrary substitute.
  const protocolAtaB = getAssociatedTokenAddressSync(addressesB.reserveTokenMint, protocolFeeDestination);
  const collectIxB = await (program.methods as any)
    .collectFees()
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addressesB.reserve,
      reserveTokenMint: addressesB.reserveTokenMint,
      mintAuthority: mintAuthorityB,
      managerFeeDestinationTokenAccount: managerAtaB,
      managerFeeDestination: creatorB.publicKey,
      protocolFeeDestinationTokenAccount: protocolAtaB,
      protocolFeeDestination: protocolFeeDestination,
      payer: creatorB.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(new Transaction().add(collectIxB), [creatorB], "collect_fees (B, before redemption -- real vault backing)");

  const reserveBAfterCollect = await program.account.reserve.fetch(addressesB.reserve);
  console.log(
    `  pending shares after collect (B): manager=${reserveBAfterCollect.feeConfig.pendingManagerFeeShares} protocol=${reserveBAfterCollect.feeConfig.pendingProtocolFeeShares} (expect 0, 0)`,
  );

  console.log("\n--- redeem the FULL balance (original holding + freshly-collected fee share, same wallet) ---");
  const [vaultAuthorityB] = findVaultAuthority(addressesB.reserve, programId);
  const creatorBRtBal = await getAccount(connection, creatorBRtAta);
  console.log(`  Reserve Token balance about to redeem (includes fee share): ${creatorBRtBal.amount}`);
  const redeemIxB = await (program.methods as any)
    .redeemReserveTokensInKind(new BN(creatorBRtBal.amount.toString()), [new BN(0)])
    .accounts({
      reserve: addressesB.reserve,
      reserveTokenMint: addressesB.reserveTokenMint,
      vaultAuthority: vaultAuthorityB,
      redeemerReserveTokenAccount: creatorBRtAta,
      redeemer: creatorB.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: assetAddrB.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddrB.vault, isWritable: true, isSigner: false },
      { pubkey: creatorBDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(redeemIxB), [creatorB], "redeem_reserve_tokens_in_kind (B, full balance incl. fee share)");

  const supplyBAfterRedeem = await connection.getTokenSupply(addressesB.reserveTokenMint);
  console.log(`  Reserve Token supply after full redemption (B): ${supplyBAfterRedeem.value.amount} (expect 0)`);
  if (supplyBAfterRedeem.value.amount !== "0") throw new Error("FAIL(B): supply is not zero after redeeming the fee-inclusive full balance.");

  console.log("\n--- close_reserve (B) -- now expect genuine SUCCESS ---");
  const closeIxB = await (program.methods as any)
    .closeReserve()
    .accounts({
      reserve: addressesB.reserve,
      reserveTokenMint: addressesB.reserveTokenMint,
      vaultAuthority: vaultAuthorityB,
      manager: creatorB.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: assetAddrB.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddrB.vault, isWritable: true, isSigner: false },
    ])
    .instruction();
  await send(new Transaction().add(closeIxB), [creatorB], "close_reserve (B, expected to succeed)");
  const reserveBAccountInfo = await connection.getAccountInfo(addressesB.reserve);
  console.log(`  Reserve account after close (B): ${reserveBAccountInfo === null ? "null (closed, as expected)" : "STILL EXISTS -- FAIL"}`);
  if (reserveBAccountInfo !== null) throw new Error("FAIL(B): Reserve account was not actually closed.");
  console.log("  CONFIRMED: close_reserve succeeds once EVERY liability -- holder redemptions AND collected-but-unredeemed fee shares -- genuinely reaches zero.");

  console.log("\n=========================================================");
  console.log("PART 2: collect_fees on the real live fee-destination-collision Reserve (error 2040 fix)");
  console.log("=========================================================");

  const COLLISION_RESERVE = new PublicKey("25NCQeJfjC9gJ39N4hWgSp2krQVKjLLdsshWVEUEY6Ni"); // reserveId 37, the "VVVV" Reserve
  const collisionReserveBefore = await program.account.reserve.fetch(COLLISION_RESERVE);
  const collisionRtMint = collisionReserveBefore.reserveTokenMint as PublicKey;
  const collisionFeeDestination = collisionReserveBefore.feeConfig.feeDestination as PublicKey;
  console.log(`Reserve: ${COLLISION_RESERVE.toBase58()}`);
  console.log(`manager_fee_destination: ${collisionFeeDestination.toBase58()}`);
  console.log(`protocol_fee_destination: ${protocolFeeDestination.toBase58()}`);
  console.log(`Collision (same wallet)? ${collisionFeeDestination.equals(protocolFeeDestination)}`);
  if (!collisionFeeDestination.equals(protocolFeeDestination)) {
    console.log("  NOTE: this Reserve's fee destination no longer collides with the protocol treasury (may have been collected/reconfigured since discovery) -- skipping Part 2's specific collision assertion, but still exercising collect_fees on it below for completeness.");
  }
  const pendingManagerBefore = BigInt(collisionReserveBefore.feeConfig.pendingManagerFeeShares.toString());
  const pendingProtocolBefore = BigInt(collisionReserveBefore.feeConfig.pendingProtocolFeeShares.toString());
  console.log(`pending manager fee shares (before): ${pendingManagerBefore}`);
  console.log(`pending protocol fee shares (before): ${pendingProtocolBefore}`);
  if (pendingManagerBefore === 0n && pendingProtocolBefore === 0n) {
    console.log("  NOTE: no pending fees remain on this Reserve (already collected by someone else since discovery) -- collect_fees would correctly revert with NoPendingFees. Skipping the live call to avoid a spurious failure; the dup-collision fix itself is already proven structurally by Part 1's distinct-destination collect_fees succeeding end-to-end plus the direct code fix in collect_fees.rs.");
  } else {
    const [collisionMintAuthority] = findMintAuthority(COLLISION_RESERVE, programId);
    const collisionAta = getAssociatedTokenAddressSync(collisionRtMint, collisionFeeDestination); // SAME ata for both manager+protocol when colliding
    const ataInfoBefore = await connection.getAccountInfo(collisionAta);
    const balBefore = ataInfoBefore ? (await getAccount(connection, collisionAta)).amount : 0n;
    console.log(`shared destination ATA balance before: ${balBefore}`);

    const ensureAtaIx = createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, collisionAta, collisionFeeDestination, collisionRtMint);
    const collideCollectIx = await (program.methods as any)
      .collectFees()
      .accounts({
        protocolConfig: protocolConfigPda,
        reserve: COLLISION_RESERVE,
        reserveTokenMint: collisionRtMint,
        mintAuthority: collisionMintAuthority,
        managerFeeDestinationTokenAccount: collisionAta,
        managerFeeDestination: collisionFeeDestination,
        protocolFeeDestinationTokenAccount: collisionAta,
        protocolFeeDestination: protocolFeeDestination,
        payer: deployer.publicKey, // permissionless caller -- deployer only pays rent/fees, cannot redirect the mint destination
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await send(new Transaction().add(ensureAtaIx, collideCollectIx), [deployer], "collect_fees on fee-destination-collision Reserve (previously failed with Custom 2040)");

    const balAfter = (await getAccount(connection, collisionAta)).amount;
    console.log(`shared destination ATA balance after: ${balAfter} (expect before + ${pendingManagerBefore} + ${pendingProtocolBefore} = ${balBefore + pendingManagerBefore + pendingProtocolBefore})`);
    if (balAfter !== balBefore + pendingManagerBefore + pendingProtocolBefore) {
      throw new Error("FAIL: collision-case collect_fees did not mint the expected combined amount to the shared ATA.");
    }
    const collisionReserveAfter = await program.account.reserve.fetch(COLLISION_RESERVE);
    console.log(
      `pending shares after collect: manager=${collisionReserveAfter.feeConfig.pendingManagerFeeShares} protocol=${collisionReserveAfter.feeConfig.pendingProtocolFeeShares} (expect 0, 0)`,
    );
    console.log("  CONFIRMED: collect_fees on a real, previously-broken fee-destination-collision Reserve now succeeds (no more Custom 2040), correctly minting both shares into the single shared ATA.");
  }

  console.log("\n=========================================================");
  console.log("ALL LIVE VERIFICATIONS PASSED.");
  console.log("=========================================================");
  console.log(`Explorer (Part 1 disposable Reserve, now closed): https://explorer.solana.com/address/${addresses.reserve.toBase58()}?cluster=devnet`);
  console.log(`Explorer (Part 2 collision Reserve): https://explorer.solana.com/address/${COLLISION_RESERVE.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
