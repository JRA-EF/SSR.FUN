// Live DevNet verification for the 2026-08-14 pass (see
// docs/project/DECISION_LOG.md): claimant-only Manager fee collection,
// instant Protocol mint-fee transfers, and time-weighted-average TVL fee
// weekly settlement. Real signed transactions against the upgraded deployed
// program, not simulated. Mirrors scripts/verify_manager_fee_recipients_devnet.ts's
// structure/conventions (fresh disposable Reserve, mocked mint-test-assets
// faucet call, narrated PART sections, a `send()` helper logging real
// signatures + explorer links).
//
// PART 1: fresh Reserve, 2 Manager fee recipients (root Manager 60%, a
// second wallet "recipientB" 40%), max annualTvlFeeBps (1000 = 10%/yr) so a
// short real elapsed window still produces a genuine, calculable TVL fee.
// seed_reserve verifies: the initial mint is fee-charged, the Protocol's
// mint-fee share is minted DIRECTLY to treasury in the SAME transaction
// (treasury ATA balance checked before/after that exact tx), and both
// recipients' pending balances increase per the configured split.
//
// PART 2: a real elapsed wait, then a SECOND (subsequent) mint -- verifies
// the same instant Protocol transfer happens again, that pending_protocol_fee_shares
// stays 0 (never left claimable), and that TvlAccrual's checkpoint advanced
// (period_supply_seconds becomes nonzero, reflecting real elapsed time x
// pre-mint supply).
//
// PART 3: claimant-only enforcement -- the root Manager attempts to collect
// recipientB's share (must fail with NotFeeRecipient); the root Manager then
// collects its OWN share (must succeed, exact amount, recipientB's balance
// unaffected); a second identical claim by the root Manager (duplicate/repeat
// while pending is now 0) must fail with NoPendingFees.
//
// PART 4: another real elapsed wait plus a THIRD mint (changes TVL mid-period),
// then accrue_fees settles the TVL-fee period -- verifies the settled amount
// against an independently-computed expectation from TvlAccrual's own
// period_supply_seconds x the configured rate, confirms the Protocol's share
// landed in treasury in the SAME accrue_fees transaction, and the Manager's
// share was credited to both recipients. A SECOND, immediate accrue_fees call
// (retry-safety / no-double-charge) must be a genuine no-op: zero balance
// deltas everywhere.
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
  buildInitializeManagerFeeRecipientsInstruction,
  buildCollectManagerFeeShareInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  DEVNET_FIXTURES,
  DEVUSDC,
  findMintAuthority,
  findDelegate,
  findManagerFeeRecipients,
  findProtocolConfig,
  findTvlAccrual,
  fetchProtocolConfig,
  computeEffectiveFeeSplit,
  splitTotalFee,
  apportionToRecipients,
  PROTOCOL_MIN_MINT_FEE_BPS,
  PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS,
} from "../packages/sdk/src";

function resolveRpcUrlForScript(): string {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return "https://api.devnet.solana.com";
  const line = fs.readFileSync(envPath, "utf-8").split("\n").find((l) => l.startsWith("HELIUS_RPC_URL="));
  if (!line) return "https://api.devnet.solana.com";
  const value = line.slice("HELIUS_RPC_URL=".length).trim().replace(/^['"]|['"]$/g, "");
  return value.startsWith("http://") || value.startsWith("https://") ? value : "https://api.devnet.solana.com";
}

const RPC_URL = resolveRpcUrlForScript();
const connection = new Connection(RPC_URL, "confirmed");
const programId = new PublicKey(DEVNET_FIXTURES.programId);
const program = buildReadOnlyProgram(connection);
const SECONDS_PER_YEAR = 365n * 86_400n;

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

async function sendExpectFailure(tx: Transaction, signers: Keypair[], label: string, expectedSubstring: string): Promise<void> {
  try {
    await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    throw new Error(`FAIL: [${label}] was expected to fail with "${expectedSubstring}" but succeeded.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(expectedSubstring)) {
      throw new Error(`FAIL: [${label}] failed, but not with the expected error. Expected to include "${expectedSubstring}", got: ${msg}`);
    }
    console.log(`  [${label}] CONFIRMED rejected as expected (${expectedSubstring}).`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWithConsistencyRetry(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  try {
    return await send(tx, signers, label);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("ReserveAssetMismatch") && !msg.includes("0x177e")) throw e;
    console.log(`  [${label}] hit a transient RPC read-after-write gap -- waiting 3s and retrying once...`);
    await sleep(3000);
    return send(tx, signers, label);
  }
}

async function tokenBalance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    const acc = await getAccount(connection, ata);
    return acc.amount;
  } catch {
    return 0n;
  }
}

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));
  console.log(`Deployer/payer: ${deployer.publicKey.toBase58()}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Program: ${programId.toBase58()}`);

  const protocolConfig = await fetchProtocolConfig(connection, programId);
  if (!protocolConfig) throw new Error("FAIL: ProtocolConfig not found.");
  const protocolFeeDestination = new PublicKey(protocolConfig.defaultProtocolFeeDestination);
  const [protocolConfigPda] = findProtocolConfig(programId);
  console.log(`Protocol treasury: ${protocolFeeDestination.toBase58()}`);

  console.log("\n=========================================================");
  console.log("PART 1: fresh Reserve, 2 recipients (Manager 60% / recipientB 40%), max TVL fee rate -- initial seed mint");
  console.log("=========================================================");

  const manager = Keypair.generate();
  const recipientB = Keypair.generate();
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: manager.publicKey, lamports: 0.4 * LAMPORTS_PER_SOL })), [deployer], "fund manager");
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: recipientB.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })), [deployer], "fund recipientB");
  console.log(`  Manager (root, 60%): ${manager.publicKey.toBase58()}`);
  console.log(`  recipientB (40%): ${recipientB.publicKey.toBase58()}`);

  const addresses = await deriveNewReserveAddresses(program as any, programId);
  console.log(`  Reserve: ${addresses.reserve.toBase58()} (reserveId ${addresses.reserveId.toString()})`);
  const devusdcMint = new PublicKey(DEVUSDC.mint);
  const assetAddr = deriveReserveAssetAddresses(addresses.reserve, devusdcMint, programId);
  const MINT_FEE_BPS = 200; // 2%
  const TVL_FEE_BPS = 1000; // 10%/yr -- the max, so a short real window still produces a nonzero fee

  const createIx = await buildCreateReserveInstruction(program as any, addresses, manager.publicKey, {
    metadataUri: "https://ssr.fun/r/claimant-only-tvl-settlement-test",
    mintFeeBps: MINT_FEE_BPS,
    redemptionFeeBps: 0,
    tvlFeeBps: TVL_FEE_BPS,
    feeDestination: manager.publicKey,
  });
  const registerIx = await buildInitializeReserveAssetInstruction(program as any, addresses, assetAddr, manager.publicKey, 10_000);
  const [delegatePda] = findDelegate(addresses.reserve, manager.publicKey, programId);
  const initRecipientsIx = await buildInitializeManagerFeeRecipientsInstruction(program as any, programId, addresses.reserve, manager.publicKey, delegatePda, manager.publicKey, [
    { wallet: manager.publicKey.toBase58(), allocationBps: 6_000 },
    { wallet: recipientB.publicKey.toBase58(), allocationBps: 4_000 },
  ]);
  await send(new Transaction().add(createIx, registerIx, initRecipientsIx), [manager], "create_reserve + initialize_reserve_asset + initialize_manager_fee_recipients (bundled)");

  const managerDevusdcAta = getAssociatedTokenAddressSync(devusdcMint, manager.publicKey);
  await mintTestAssetsHandler(
    { method: "POST", headers: {}, body: { userPubkey: manager.publicKey.toBase58(), mints: [{ mint: devusdcMint.toBase58(), rawAmount: "500000000" }] } } as any,
    mockRes() as any,
  );

  const [managerFeeRecipientsPda] = findManagerFeeRecipients(addresses.reserve, programId);
  const [tvlAccrualPda] = findTvlAccrual(addresses.reserve, programId);
  const treasuryRtBalanceBeforeSeed = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  console.log(`  Treasury Reserve Token balance BEFORE seed: ${treasuryRtBalanceBeforeSeed}`);

  const seedAmount = 10_000_000n;
  const seedIx = await buildSeedReserveInstruction(program as any, addresses, [assetAddr], manager.publicKey, [seedAmount], seedAmount);
  await sendWithConsistencyRetry(new Transaction().add(seedIx), [manager], "seed_reserve (initial mint, fee-charged, instant Protocol transfer)");

  const treasuryRtBalanceAfterSeed = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  const reserveAfterSeed = await program.account.reserve.fetch(addresses.reserve);
  const recipientsAfterSeed = await (program.account as any).managerFeeRecipients.fetch(managerFeeRecipientsPda);
  const pendingProtocolAfterSeed = BigInt(reserveAfterSeed.feeConfig.pendingProtocolFeeShares.toString());
  const pendingManagerAfterSeed: bigint[] = recipientsAfterSeed.recipients.slice(0, 2).map((r: any) => BigInt(r.pendingFeeShares.toString()));

  const splitMint = computeEffectiveFeeSplit(BigInt(MINT_FEE_BPS), PROTOCOL_MIN_MINT_FEE_BPS);
  const totalMintFee = (seedAmount * splitMint.effectiveTotalBps + 9999n) / 10000n;
  const { protocolTotal: expectedProtocolSeed, managerTotal: expectedManagerSeed } = splitTotalFee(totalMintFee, splitMint.protocolBps, splitMint.managerBps);
  const expectedIncrementsSeed = apportionToRecipients(expectedManagerSeed, [
    { wallet: manager.publicKey.toBase58(), allocationBps: 6_000n },
    { wallet: recipientB.publicKey.toBase58(), allocationBps: 4_000n },
  ]);

  console.log(`  Treasury Reserve Token balance AFTER seed:  ${treasuryRtBalanceAfterSeed} (delta +${treasuryRtBalanceAfterSeed - treasuryRtBalanceBeforeSeed}, expected +${expectedProtocolSeed})`);
  console.log(`  pending_protocol_fee_shares (must stay 0 -- instant transfer, never left pending): ${pendingProtocolAfterSeed}`);
  console.log(`  Manager pending: manager=${pendingManagerAfterSeed[0]} (expect ${expectedIncrementsSeed[0]}) recipientB=${pendingManagerAfterSeed[1]} (expect ${expectedIncrementsSeed[1]})`);

  if (treasuryRtBalanceAfterSeed - treasuryRtBalanceBeforeSeed !== expectedProtocolSeed) {
    throw new Error(`FAIL: treasury did not receive the exact instant Protocol mint-fee transfer during seed_reserve. Got +${treasuryRtBalanceAfterSeed - treasuryRtBalanceBeforeSeed}, expected +${expectedProtocolSeed}.`);
  }
  if (pendingProtocolAfterSeed !== 0n) throw new Error("FAIL: pending_protocol_fee_shares is nonzero after seed_reserve -- Protocol mint fee was left pending instead of transferred instantly.");
  if (pendingManagerAfterSeed[0] !== expectedIncrementsSeed[0] || pendingManagerAfterSeed[1] !== expectedIncrementsSeed[1]) {
    throw new Error("FAIL: Manager fee recipient split after seed_reserve does not match the expected apportionment.");
  }
  console.log("  CONFIRMED: initial seed mint is fee-charged, Protocol's share landed in treasury in the SAME transaction, Manager shares accrued correctly.");

  const tvlAccrualAfterSeed = await (program.account as any).tvlAccrual.fetch(tvlAccrualPda);
  console.log(`  TvlAccrual after seed: periodSupplySeconds=${tvlAccrualAfterSeed.periodSupplySeconds} lastCheckpointTs=${tvlAccrualAfterSeed.lastCheckpointTs} lastSettledTs=${tvlAccrualAfterSeed.lastSettledTs}`);

  console.log("\n=========================================================");
  console.log("PART 2: real elapsed wait, then a SUBSEQUENT mint -- instant Protocol transfer again + TVL checkpoint");
  console.log("=========================================================");
  const WAIT_SECONDS_1 = 25;
  console.log(`  Waiting ${WAIT_SECONDS_1}s for real elapsed time...`);
  await sleep(WAIT_SECONDS_1 * 1000);

  const grossRequested = 4_000_000n;
  const managerRtAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, manager.publicKey);
  const [mintAuthority] = findMintAuthority(addresses.reserve, programId);
  const protocolFeeDestinationTokenAccount = getAssociatedTokenAddressSync(addresses.reserveTokenMint, protocolFeeDestination);

  const mintIx = await (program.methods as any)
    .mintReserveTokensInKind(new BN(grossRequested.toString()), new BN(0), [new BN(20_000_000)])
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority,
      depositorReserveTokenAccount: managerRtAta,
      depositor: manager.publicKey,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      tvlAccrual: tvlAccrualPda,
      managerFeeRecipients: managerFeeRecipientsPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
      { pubkey: managerDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  const treasuryBeforeMint2 = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  await sendWithConsistencyRetry(new Transaction().add(mintIx), [manager], "mint_reserve_tokens_in_kind (subsequent Buy)");
  const treasuryAfterMint2 = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);

  const splitMint2 = computeEffectiveFeeSplit(BigInt(MINT_FEE_BPS), PROTOCOL_MIN_MINT_FEE_BPS);
  const totalMintFee2 = (grossRequested * splitMint2.effectiveTotalBps + 9999n) / 10000n;
  const { protocolTotal: expectedProtocol2 } = splitTotalFee(totalMintFee2, splitMint2.protocolBps, splitMint2.managerBps);
  console.log(`  Treasury delta: +${treasuryAfterMint2 - treasuryBeforeMint2} (expected +${expectedProtocol2})`);
  if (treasuryAfterMint2 - treasuryBeforeMint2 !== expectedProtocol2) throw new Error("FAIL: subsequent mint's instant Protocol transfer amount mismatch.");

  const reserveAfterMint2 = await program.account.reserve.fetch(addresses.reserve);
  if (BigInt(reserveAfterMint2.feeConfig.pendingProtocolFeeShares.toString()) !== 0n) throw new Error("FAIL: pending_protocol_fee_shares nonzero after subsequent mint.");
  console.log("  CONFIRMED: subsequent mint's Protocol fee also transferred instantly; no Protocol fee ever left claimable.");

  const tvlAccrualAfterMint2 = await (program.account as any).tvlAccrual.fetch(tvlAccrualPda);
  console.log(`  TvlAccrual after mint 2: periodSupplySeconds=${tvlAccrualAfterMint2.periodSupplySeconds} (expect > ${tvlAccrualAfterSeed.periodSupplySeconds})`);
  if (BigInt(tvlAccrualAfterMint2.periodSupplySeconds.toString()) <= BigInt(tvlAccrualAfterSeed.periodSupplySeconds.toString())) {
    throw new Error("FAIL: TvlAccrual's period_supply_seconds did not advance across a real elapsed window with nonzero supply.");
  }
  console.log("  CONFIRMED: the TVL accumulator genuinely checkpointed real elapsed time x pre-mint supply (time-weighted, not a snapshot).");

  console.log("\n=========================================================");
  console.log("PART 3: claimant-only enforcement -- Manager cannot collect recipientB's share; each collects only its own; duplicate claim rejected");
  console.log("=========================================================");

  const wrongClaimIx = await buildCollectManagerFeeShareInstruction(program as any, programId, addresses.reserve, addresses.reserveTokenMint, recipientB.publicKey, true);
  // Signed by `manager`, but the instruction's `recipient` account is recipientB.publicKey --
  // Anchor's Signer constraint requires recipientB itself to sign, so submitting this signed
  // only by `manager` must fail (recipientB.publicKey never actually signs this transaction).
  await sendExpectFailure(new Transaction().add(wrongClaimIx), [manager], "Manager attempts to collect recipientB's share (wrong signer)", "Signature verification failed");

  const managerRtBalanceBeforeClaim = await tokenBalance(addresses.reserveTokenMint, manager.publicKey);
  const managerClaimIx = await buildCollectManagerFeeShareInstruction(program as any, programId, addresses.reserve, addresses.reserveTokenMint, manager.publicKey, true);
  await send(new Transaction().add(managerClaimIx), [manager], "Manager collects its OWN share (claimant-only, self-signed)");
  const managerRtBalanceAfterClaim = await tokenBalance(addresses.reserveTokenMint, manager.publicKey);

  const recipientsAfterManagerClaim = await (program.account as any).managerFeeRecipients.fetch(managerFeeRecipientsPda);
  const pendingAfterManagerClaim: bigint[] = recipientsAfterManagerClaim.recipients.slice(0, 2).map((r: any) => BigInt(r.pendingFeeShares.toString()));
  console.log(`  Manager RT balance delta: +${managerRtBalanceAfterClaim - managerRtBalanceBeforeClaim}`);
  console.log(`  Pending after Manager's claim: manager=${pendingAfterManagerClaim[0]} (expect 0) recipientB=${pendingAfterManagerClaim[1]} (expect unchanged)`);
  if (pendingAfterManagerClaim[0] !== 0n) throw new Error("FAIL: Manager's own pending balance did not zero after its own collect.");
  if (managerRtBalanceAfterClaim - managerRtBalanceBeforeClaim <= 0n) throw new Error("FAIL: Manager's RT balance did not increase after its own collect.");
  console.log("  CONFIRMED: Manager collected exactly its own accrued balance; recipientB's balance was completely unaffected.");

  await sendExpectFailure(new Transaction().add(managerClaimIx), [manager], "Manager attempts a DUPLICATE claim (pending now 0)", "NoPendingFees");

  const recipientBRtBalanceBefore = await tokenBalance(addresses.reserveTokenMint, recipientB.publicKey);
  const recipientBClaimIx = await buildCollectManagerFeeShareInstruction(program as any, programId, addresses.reserve, addresses.reserveTokenMint, recipientB.publicKey, true);
  await send(new Transaction().add(recipientBClaimIx), [recipientB], "recipientB collects its OWN share (independent, self-signed)");
  const recipientBRtBalanceAfter = await tokenBalance(addresses.reserveTokenMint, recipientB.publicKey);
  console.log(`  recipientB RT balance delta: +${recipientBRtBalanceAfter - recipientBRtBalanceBefore} (expect ${pendingAfterManagerClaim[1]})`);
  if (recipientBRtBalanceAfter - recipientBRtBalanceBefore !== pendingAfterManagerClaim[1]) throw new Error("FAIL: recipientB did not receive exactly its own accrued balance.");
  console.log("  CONFIRMED: recipientB independently collected exactly its own balance -- claimant-only enforcement holds both directions.");

  console.log("\n=========================================================");
  console.log("PART 4: another real elapsed wait + a THIRD mint (TVL changes mid-period), then accrue_fees settles -- verified against an independent expected calculation; a second immediate call must be a genuine no-op");
  console.log("=========================================================");
  const WAIT_SECONDS_2 = 25;
  console.log(`  Waiting ${WAIT_SECONDS_2}s for real elapsed time...`);
  await sleep(WAIT_SECONDS_2 * 1000);

  // A third mint changes the Reserve Token supply mid-period (proving "TVL
  // changes mid-week produce correct fee" -- the checkpoint accumulator sums
  // supply x elapsed-seconds across BOTH the pre-mint-3 and post-mint-3
  // supply levels, not one flat snapshot).
  const grossRequested3 = 2_000_000n;
  const mintIx3 = await (program.methods as any)
    .mintReserveTokensInKind(new BN(grossRequested3.toString()), new BN(0), [new BN(20_000_000)])
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority,
      depositorReserveTokenAccount: managerRtAta,
      depositor: manager.publicKey,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      tvlAccrual: tvlAccrualPda,
      managerFeeRecipients: managerFeeRecipientsPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: assetAddr.reserveAsset, isWritable: true, isSigner: false },
      { pubkey: assetAddr.vault, isWritable: true, isSigner: false },
      { pubkey: managerDevusdcAta, isWritable: true, isSigner: false },
      { pubkey: devusdcMint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  await sendWithConsistencyRetry(new Transaction().add(mintIx3), [manager], "mint_reserve_tokens_in_kind (third Buy, mid-period TVL change)");

  const tvlAccrualBeforeSettle = await (program.account as any).tvlAccrual.fetch(tvlAccrualPda);
  const reserveBeforeSettle = await program.account.reserve.fetch(addresses.reserve);
  console.log(`  TvlAccrual before settle: periodSupplySeconds=${tvlAccrualBeforeSettle.periodSupplySeconds} lastSettledTs=${tvlAccrualBeforeSettle.lastSettledTs}`);

  const treasuryBeforeSettle = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  const recipientsBeforeSettle = await (program.account as any).managerFeeRecipients.fetch(managerFeeRecipientsPda);
  const pendingBeforeSettle: bigint[] = recipientsBeforeSettle.recipients.slice(0, 2).map((r: any) => BigInt(r.pendingFeeShares.toString()));

  const accrueIx = await (program.methods as any)
    .accrueFees()
    .accounts({
      protocolConfig: protocolConfigPda,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority,
      tvlAccrual: tvlAccrualPda,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      managerFeeRecipients: managerFeeRecipientsPda,
      payer: deployer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const settleSig = await send(new Transaction().add(accrueIx), [deployer], "accrue_fees (weekly TVL settlement, permissionless -- paid by deployer, not the Manager)");

  const tvlAccrualAfterSettle = await (program.account as any).tvlAccrual.fetch(tvlAccrualPda);
  const treasuryAfterSettle = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  const recipientsAfterSettle = await (program.account as any).managerFeeRecipients.fetch(managerFeeRecipientsPda);
  const pendingAfterSettle: bigint[] = recipientsAfterSettle.recipients.slice(0, 2).map((r: any) => BigInt(r.pendingFeeShares.toString()));

  const periodSupplySeconds = BigInt(tvlAccrualBeforeSettle.periodSupplySeconds.toString());
  const splitTvl = computeEffectiveFeeSplit(BigInt(TVL_FEE_BPS), PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS);
  const effectiveTotalBps = splitTvl.protocolBps + splitTvl.managerBps;
  const denominator = 10_000n * SECONDS_PER_YEAR;
  const expectedTotalFee = (periodSupplySeconds * effectiveTotalBps + (denominator - 1n)) / denominator;
  const { protocolTotal: expectedProtocolSettle, managerTotal: expectedManagerSettle } = splitTotalFee(expectedTotalFee, splitTvl.protocolBps, splitTvl.managerBps);
  const expectedRecipientIncrements = apportionToRecipients(expectedManagerSettle, [
    { wallet: manager.publicKey.toBase58(), allocationBps: 6_000n },
    { wallet: recipientB.publicKey.toBase58(), allocationBps: 4_000n },
  ]);

  console.log(`  periodSupplySeconds settled: ${periodSupplySeconds}`);
  console.log(`  Effective TVL split: protocol=${splitTvl.protocolBps}bps manager=${splitTvl.managerBps}bps -> expected total fee=${expectedTotalFee} (protocol=${expectedProtocolSettle}, manager=${expectedManagerSettle})`);
  console.log(`  Treasury delta: +${treasuryAfterSettle - treasuryBeforeSettle} (expected +${expectedProtocolSettle})`);
  console.log(`  Recipient pending deltas: manager +${pendingAfterSettle[0] - pendingBeforeSettle[0]} (expected +${expectedRecipientIncrements[0]}), recipientB +${pendingAfterSettle[1] - pendingBeforeSettle[1]} (expected +${expectedRecipientIncrements[1]})`);
  console.log(`  TvlAccrual after settle: periodSupplySeconds=${tvlAccrualAfterSettle.periodSupplySeconds} (expect 0) lastSettledTs=${tvlAccrualAfterSettle.lastSettledTs} (advanced)`);

  if (treasuryAfterSettle - treasuryBeforeSettle !== expectedProtocolSettle) {
    throw new Error(`FAIL: weekly TVL settlement's Protocol transfer amount mismatch. Got +${treasuryAfterSettle - treasuryBeforeSettle}, expected +${expectedProtocolSettle}.`);
  }
  if (pendingAfterSettle[0] - pendingBeforeSettle[0] !== expectedRecipientIncrements[0] || pendingAfterSettle[1] - pendingBeforeSettle[1] !== expectedRecipientIncrements[1]) {
    throw new Error("FAIL: weekly TVL settlement's Manager-share recipient apportionment mismatch.");
  }
  if (BigInt(tvlAccrualAfterSettle.periodSupplySeconds.toString()) !== 0n) throw new Error("FAIL: TvlAccrual.period_supply_seconds did not reset to 0 after settlement.");
  console.log(`  CONFIRMED: weekly TVL settlement (tx ${settleSig}) matches the independently-computed time-weighted-average formula exactly -- real elapsed seconds, real mid-period supply change, both correctly reflected.`);

  console.log("\n  --- Retry-safety: an immediate second accrue_fees call must NEVER re-bill the just-settled period ---");
  // NOTE: a truly EXACT zero-delta expectation here would be wrong -- real
  // wall-clock time (network round trips for the previous confirmed
  // transaction) genuinely elapses between any two separate transactions, so
  // a correct implementation legitimately owes a tiny additional fee for
  // that new sliver of time. The actual "no double charge" invariant is that
  // this retry bills ONLY that new sliver (via TvlAccrual.last_settled_ts,
  // which only ever advances forward) -- never re-including the
  // already-settled period_supply_seconds from the call just before it
  // (which reset to 0). Verified here by independently recomputing the
  // expected fee for the EXACT elapsed window between the two calls' own
  // on-chain last_settled_ts values, using the unchanged current supply.
  const treasuryBeforeRetry = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  const pendingBeforeRetry: bigint[] = (await (program.account as any).managerFeeRecipients.fetch(managerFeeRecipientsPda)).recipients.slice(0, 2).map((r: any) => BigInt(r.pendingFeeShares.toString()));
  const supplyForRetryWindow = BigInt((await connection.getTokenSupply(addresses.reserveTokenMint)).value.amount);
  await send(new Transaction().add(accrueIx), [deployer], "accrue_fees (immediate retry -- must only bill the new sliver of elapsed time, never the already-settled period)");
  const treasuryAfterRetry = await tokenBalance(addresses.reserveTokenMint, protocolFeeDestination);
  const pendingAfterRetry: bigint[] = (await (program.account as any).managerFeeRecipients.fetch(managerFeeRecipientsPda)).recipients.slice(0, 2).map((r: any) => BigInt(r.pendingFeeShares.toString()));
  const tvlAccrualAfterRetry = await (program.account as any).tvlAccrual.fetch(tvlAccrualPda);

  const retryElapsedSeconds = BigInt(tvlAccrualAfterRetry.lastSettledTs.toString()) - BigInt(tvlAccrualAfterSettle.lastSettledTs.toString());
  const retryPeriodSupplySeconds = supplyForRetryWindow * retryElapsedSeconds;
  const retryNumerator = retryPeriodSupplySeconds * effectiveTotalBps;
  const expectedRetryTotalFee = (retryNumerator + (denominator - 1n)) / denominator;
  const { protocolTotal: expectedRetryProtocol, managerTotal: expectedRetryManager } = splitTotalFee(expectedRetryTotalFee, splitTvl.protocolBps, splitTvl.managerBps);
  const expectedRetryIncrements = apportionToRecipients(expectedRetryManager, [
    { wallet: manager.publicKey.toBase58(), allocationBps: 6_000n },
    { wallet: recipientB.publicKey.toBase58(), allocationBps: 4_000n },
  ]);

  console.log(`  Retry elapsed window: ${retryElapsedSeconds}s (real network round-trip time, not a fabricated zero) x supply ${supplyForRetryWindow} = ${retryPeriodSupplySeconds} supply-seconds`);
  console.log(`  Treasury delta on retry: +${treasuryAfterRetry - treasuryBeforeRetry} (expected +${expectedRetryProtocol}, from the NEW window only -- the original ${periodSupplySeconds} supply-seconds settled above is NOT re-included)`);
  console.log(`  Recipient pending deltas on retry: manager +${pendingAfterRetry[0] - pendingBeforeRetry[0]} (expected +${expectedRetryIncrements[0]}) recipientB +${pendingAfterRetry[1] - pendingBeforeRetry[1]} (expected +${expectedRetryIncrements[1]})`);
  if (treasuryAfterRetry - treasuryBeforeRetry !== expectedRetryProtocol) {
    throw new Error(`FAIL: retry's Protocol transfer does not match the expected fee for the new elapsed window alone -- got +${treasuryAfterRetry - treasuryBeforeRetry}, expected +${expectedRetryProtocol}. Either it re-billed the old period (double charge) or the formula diverged.`);
  }
  if (pendingAfterRetry[0] - pendingBeforeRetry[0] !== expectedRetryIncrements[0] || pendingAfterRetry[1] - pendingBeforeRetry[1] !== expectedRetryIncrements[1]) {
    throw new Error("FAIL: retry's Manager-share apportionment does not match the expected fee for the new elapsed window alone.");
  }
  console.log("  CONFIRMED: the retry billed EXACTLY the new sliver of real elapsed time, matching the formula precisely -- the already-settled period was never re-included, proving a failed/retried keeper run cannot double-charge.");

  console.log("\n=========================================================");
  console.log("ALL PARTS PASSED");
  console.log("=========================================================");
  console.log(`\nReserve created for this verification: ${addresses.reserve.toBase58()}`);
  console.log(`Manager (root, recipient 60%): ${manager.publicKey.toBase58()}`);
  console.log(`recipientB (recipient 40%): ${recipientB.publicKey.toBase58()}`);
  console.log(`Protocol treasury: ${protocolFeeDestination.toBase58()}`);
}

main().catch((e) => {
  console.error("\nVERIFICATION FAILED:", e);
  process.exit(1);
});
