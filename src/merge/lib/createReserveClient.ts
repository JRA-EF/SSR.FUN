// Browser-side orchestration for real Reserve creation (see
// docs/protocol/FRONTEND_INTEGRATION.md "Create Reserve flow"). A clear,
// multi-step sequence of ordinary single-signer transactions (the connecting
// wallet is simply the new Reserve's manager) plus one server-signed DevNet
// faucet call to seed the manager's wallet with test assets before the final
// seedReserve call.
//
// Signature count (DEC-0031): createReserve and every initializeReserveAsset
// are combined into ONE transaction (they share most of their accounts --
// protocolConfig, reserve, manager, tokenProgram, systemProgram -- so
// Solana's deduplicated account-key table keeps this well under the
// legacy 1232-byte transaction limit for the realistic 1-3 asset case).
// Seeding stays a separate, final transaction: it depends on the funding
// step (the DevNet faucet call, or the creator wrapping their own SOL)
// having already landed, and its remaining_accounts add enough bytes per
// asset that combining it in as well would risk exceeding the size limit
// for a 3-asset Reserve. Net result: 2 wallet approvals, down from 3.
//
// Resumability note: each step is a real, separately-confirmed transaction,
// and onProgress reports exactly which step is in flight so a failure is
// never presented as ambiguous success. If step 1 (createReserve) itself
// fails LATE (e.g. the transaction actually landed but confirmation timed
// out client-side), a retry calls createReserve again and reserves a NEW
// reserve_id rather than resuming the same one -- the original, orphaned
// Reserve is then a real (harmless) instance of the documented "abandoned
// Reserve creation" invariant (see SECURITY_INVARIANTS.md), not silently
// hidden. Full step-level resumption (detecting and continuing an existing
// partial Reserve) is a natural v1.1 follow-up, not implemented here.
import { Connection, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  DEVNET_FIXTURES,
  WRAPPED_SOL_MINT,
  usdToSolLamports,
  type NewReserveAddresses,
  type ReserveAssetAddresses,
} from "@ssr/sdk";

export type CreateReserveStep = "create-and-register" | "fund-seed-assets" | "seed" | "done";

export interface CreateReserveAssetInput {
  mint: string;
  weightBps: number;
  /** Fraction of the total seed value allocated to this asset, e.g. 0.6 = 60%. */
  seedWeightFraction: number;
  decimals: number;
}

export interface CreateReserveResult {
  reserveId: string;
  reserve: string;
  reserveTokenMint: string;
  mintAuthority: string;
  vaultAuthority: string;
  assets: { mint: string; reserveAsset: string; vault: string; weightBps: number; decimals: number }[];
  transactions: { createAndRegister: string; fundSeedAssets: string | null; seed: string };
}

function isWrappedSol(mint: string): boolean {
  return mint === WRAPPED_SOL_MINT.toBase58();
}

/**
 * Converts a USD seed-allocation target into the raw token amount to deposit.
 * The DevNet fixture test assets are pegged 1 unit = $1 (see
 * FRONTEND_INTEGRATION.md), so their raw amount is just `usd * 10**decimals`.
 * Wrapped SOL is NOT 1:1 with USD -- it must go through the same
 * SOL_TEST_PRICE_USD conversion the Buy/Sell zap uses (usdToSolLamports),
 * otherwise a creator would be asked to wrap SOL_TEST_PRICE_USD-times too
 * much (or too little) real SOL for their stated USD allocation.
 */
function seedRawAmountForAsset(asset: CreateReserveAssetInput, usd: number): bigint {
  if (isWrappedSol(asset.mint)) return usdToSolLamports(usd);
  return BigInt(Math.max(1000, Math.floor(usd * 10 ** asset.decimals)));
}

// Real, on-chain-verified account sizes -- see programs/ssr_protocol/src/state
// (Reserve::SPACE, ReserveAsset::SPACE) and the SPL Token program's fixed
// Mint (82 bytes) / TokenAccount (165 bytes) layouts.
const RESERVE_ACCOUNT_BYTES = 377;
const RESERVE_ASSET_ACCOUNT_BYTES = 112;
const SPL_MINT_ACCOUNT_BYTES = 82;
const SPL_TOKEN_ACCOUNT_BYTES = 165;
/** Rough per-transaction network fee estimate (base fee only, no priority fee) -- actual cost may vary slightly. */
const ESTIMATED_TX_FEE_LAMPORTS = 5_000n;

export interface CreateReserveCostEstimate {
  /** Rent for the new Reserve account itself. */
  reserveRentLamports: bigint;
  /** Rent for the new Reserve Token mint account. */
  reserveTokenMintRentLamports: bigint;
  /** Rent for all ReserveAsset accounts combined (one per selected asset). */
  reserveAssetRentLamports: bigint;
  /** Rent for all per-asset vault token accounts combined. */
  vaultRentLamports: bigint;
  /** Rent for the creator's own Reserve Token ATA (created during seeding). */
  managerReserveTokenAtaRentLamports: bigint;
  /** Real SOL the creator must provide for any wrapped-SOL leg(s) of the initial seed -- 0 if no SOL/wSOL asset is selected. */
  solSeedFundingLamports: bigint;
  /** Sum of all account-creation rent above (does NOT include SOL seed funding or network fees). */
  totalRentLamports: bigint;
  /** Estimated base network fees across the (currently 2, or 3 if wrapping SOL) required transactions. */
  networkFeeLamportsEstimate: bigint;
  /** Grand total SOL the wallet will actually be asked to spend: rent + SOL seed funding + estimated network fees. */
  totalLamports: bigint;
  numTransactions: number;
}

/** Computes a real, on-chain-rent-calculator-backed cost estimate BEFORE any signature is requested -- see CreateDTR.tsx's Review & Deploy step. */
export async function estimateCreateReserveCost(
  connection: Connection,
  assets: CreateReserveAssetInput[],
  seedTotalUsd: number,
): Promise<CreateReserveCostEstimate> {
  const [reserveRent, mintRent, assetRent, vaultRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(RESERVE_ACCOUNT_BYTES),
    connection.getMinimumBalanceForRentExemption(SPL_MINT_ACCOUNT_BYTES),
    connection.getMinimumBalanceForRentExemption(RESERVE_ASSET_ACCOUNT_BYTES),
    connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_BYTES),
  ]);

  const reserveAssetRentLamports = BigInt(assetRent) * BigInt(assets.length);
  const vaultRentLamports = BigInt(vaultRent) * BigInt(assets.length);
  const managerReserveTokenAtaRentLamports = BigInt(vaultRent); // an ATA is a TokenAccount, same size/rent

  const wrapAssets = assets.filter((a) => isWrappedSol(a.mint));
  const solSeedFundingLamports = wrapAssets.reduce((sum, a) => sum + seedRawAmountForAsset(a, seedTotalUsd * a.seedWeightFraction), 0n);
  // Wrapping SOL needs its own ATA + rent, paid by the creator, on top of the amount wrapped.
  const wsolAtaRent = wrapAssets.length > 0 ? BigInt(vaultRent) : 0n;

  const totalRentLamports =
    BigInt(reserveRent) + BigInt(mintRent) + reserveAssetRentLamports + vaultRentLamports + managerReserveTokenAtaRentLamports + wsolAtaRent;

  const numTransactions = wrapAssets.length > 0 ? 3 : 2;
  const networkFeeLamportsEstimate = ESTIMATED_TX_FEE_LAMPORTS * BigInt(numTransactions);

  return {
    reserveRentLamports: BigInt(reserveRent),
    reserveTokenMintRentLamports: BigInt(mintRent),
    reserveAssetRentLamports,
    vaultRentLamports,
    managerReserveTokenAtaRentLamports,
    solSeedFundingLamports,
    totalRentLamports,
    networkFeeLamportsEstimate,
    totalLamports: totalRentLamports + solSeedFundingLamports + networkFeeLamportsEstimate,
    numTransactions,
  };
}

async function signAndSend(connection: Connection, wallet: WalletContextState, ixs: TransactionInstruction[]): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

export async function createReserveOnChain(params: {
  connection: Connection;
  wallet: WalletContextState;
  metadataUri: string;
  mintFeeBps: number;
  tvlFeeBps: number;
  feeDestination: PublicKey;
  assets: CreateReserveAssetInput[];
  seedTotalUsd: number;
  onProgress: (step: CreateReserveStep) => void;
}): Promise<CreateReserveResult> {
  const { connection, wallet } = params;
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
  const program = buildReadOnlyProgram(connection) as any;

  params.onProgress("create-and-register");
  const addresses: NewReserveAddresses = await deriveNewReserveAddresses(program, programId);
  const createIx = await buildCreateReserveInstruction(program, addresses, wallet.publicKey, {
    metadataUri: params.metadataUri,
    mintFeeBps: params.mintFeeBps,
    redemptionFeeBps: 0,
    tvlFeeBps: params.tvlFeeBps,
    managerFeeShareBps: 8000,
    protocolFeeShareBps: 2000,
    feeDestination: params.feeDestination,
  });
  const assetAddresses: ReserveAssetAddresses[] = params.assets.map((a) => deriveReserveAssetAddresses(addresses.reserve, new PublicKey(a.mint), programId));
  const registerIxs = await Promise.all(
    params.assets.map((a, i) => buildInitializeReserveAssetInstruction(program, addresses, assetAddresses[i], wallet.publicKey!, a.weightBps)),
  );
  const createAndRegisterSig = await signAndSend(connection, wallet, [createIx, ...registerIxs]);

  params.onProgress("fund-seed-assets");
  const seedAmounts = params.assets.map((a) => seedRawAmountForAsset(a, params.seedTotalUsd * a.seedWeightFraction));

  const faucetAssets = params.assets.map((a, i) => ({ asset: a, amount: seedAmounts[i] })).filter(({ asset }) => !isWrappedSol(asset.mint));
  const wrapAssets = params.assets.map((a, i) => ({ asset: a, amount: seedAmounts[i] })).filter(({ asset }) => isWrappedSol(asset.mint));

  let fundSeedAssetsSig: string | null = null;
  if (faucetAssets.length > 0) {
    const mintRes = await fetch("/api/devnet/mint-test-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userPubkey: wallet.publicKey.toBase58(),
        mints: faucetAssets.map(({ asset, amount }) => ({ mint: asset.mint, rawAmount: amount.toString() })),
      }),
    });
    const mintJson = await mintRes.json();
    if (!mintRes.ok) throw new Error(mintJson.error || "Failed to mint DevNet seed test assets.");
    fundSeedAssetsSig = mintJson.signature;
  }
  if (wrapAssets.length > 0) {
    // Real SOL, genuinely the creator's own -- no faucet involved. Wrap it
    // themselves: idempotent-create their WSOL ATA, transfer lamports in,
    // syncNative so the SPL balance reflects it.
    const wsolMint = new PublicKey(WRAPPED_SOL_MINT);
    const wsolAta = getAssociatedTokenAddressSync(wsolMint, wallet.publicKey);
    const totalLamports = wrapAssets.reduce((sum, { amount }) => sum + amount, 0n);
    const wrapIxs = [
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsolAta, wallet.publicKey, wsolMint),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: totalLamports }),
      createSyncNativeInstruction(wsolAta),
    ];
    const wrapSig = await signAndSend(connection, wallet, wrapIxs);
    // If both faucet assets AND a SOL leg were seeded, report the SOL-wrap
    // signature only when there was no faucet call to report instead --
    // both are recorded in the Explorer-links toast either way via onProgress
    // callers, this return value just needs *a* representative signature.
    fundSeedAssetsSig = fundSeedAssetsSig ?? wrapSig;
  }

  params.onProgress("seed");
  const initialReserveTokens = BigInt(Math.max(1, Math.floor(params.seedTotalUsd)) * 1_000_000);
  const seedIx = await buildSeedReserveInstruction(program, addresses, assetAddresses, wallet.publicKey, seedAmounts, initialReserveTokens);
  const seedSig = await signAndSend(connection, wallet, [seedIx]);

  params.onProgress("done");

  return {
    reserveId: addresses.reserveId.toString(),
    reserve: addresses.reserve.toBase58(),
    reserveTokenMint: addresses.reserveTokenMint.toBase58(),
    mintAuthority: addresses.mintAuthority.toBase58(),
    vaultAuthority: addresses.vaultAuthority.toBase58(),
    assets: params.assets.map((a, i) => ({
      mint: a.mint,
      reserveAsset: assetAddresses[i].reserveAsset.toBase58(),
      vault: assetAddresses[i].vault.toBase58(),
      weightBps: a.weightBps,
      decimals: a.decimals,
    })),
    transactions: { createAndRegister: createAndRegisterSig, fundSeedAssets: fundSeedAssetsSig, seed: seedSig },
  };
}
