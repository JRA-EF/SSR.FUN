// Browser-side orchestration for real Reserve creation (see
// docs/protocol/FRONTEND_INTEGRATION.md "Create Reserve flow"). A clear,
// multi-step sequence of ordinary single-signer transactions (the connecting
// wallet is simply the new Reserve's manager) plus one server-signed DevNet
// faucet call to seed the manager's wallet with test assets before the final
// seedReserve call.
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
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  DEVNET_FIXTURES,
  type NewReserveAddresses,
  type ReserveAssetAddresses,
} from "@ssr/sdk";

export type CreateReserveStep = "create" | "register-assets" | "mint-seed-assets" | "seed" | "done";

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
  transactions: { create: string; registerAssets: string; mintSeed: string; seed: string };
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

  params.onProgress("create");
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
  const createSig = await signAndSend(connection, wallet, [createIx]);

  params.onProgress("register-assets");
  const assetAddresses: ReserveAssetAddresses[] = params.assets.map((a) => deriveReserveAssetAddresses(addresses.reserve, new PublicKey(a.mint), programId));
  const registerIxs = await Promise.all(
    params.assets.map((a, i) => buildInitializeReserveAssetInstruction(program, addresses, assetAddresses[i], wallet.publicKey!, a.weightBps)),
  );
  const registerSig = await signAndSend(connection, wallet, registerIxs);

  params.onProgress("mint-seed-assets");
  const seedAmounts = params.assets.map((a) => {
    const usd = params.seedTotalUsd * a.seedWeightFraction;
    return BigInt(Math.max(1000, Math.floor(usd * 10 ** a.decimals)));
  });
  const mintRes = await fetch("/api/devnet/mint-test-assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPubkey: wallet.publicKey.toBase58(),
      mints: params.assets.map((a, i) => ({ mint: a.mint, rawAmount: seedAmounts[i].toString() })),
    }),
  });
  const mintJson = await mintRes.json();
  if (!mintRes.ok) throw new Error(mintJson.error || "Failed to mint DevNet seed test assets.");

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
    transactions: { create: createSig, registerAssets: registerSig, mintSeed: mintJson.signature, seed: seedSig },
  };
}
