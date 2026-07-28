// Builds the instructions for real, on-chain Reserve creation (Gate 10 "Create
// Reserve flow" -- see docs/protocol/FRONTEND_INTEGRATION.md). Unlike the
// Buy/Sell zap, none of these need a second (swap-authority) signer -- the
// connecting wallet is simply the new Reserve's manager, signing its own
// createReserve/initializeReserveAsset/seedReserve calls directly. Seeding
// does need the manager to already hold the seed asset amounts in their own
// wallet first -- see api/devnet/mint-test-assets.ts, a separate DevNet-only
// faucet step (not bundled atomically, since there's no harm in a user
// holding minted test assets without immediately seeding a Reserve with them).
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findReserve, findReserveTokenMint, findMintAuthority, findVaultAuthority, findReserveAsset, findReserveVault, findProtocolConfig } from "./pda";

export interface NewReserveAddresses {
  reserveId: bigint;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  vaultAuthority: PublicKey;
  protocolConfig: PublicKey;
}

/** Reads the live reserve_count and derives every address the new Reserve will have -- call this immediately before building the createReserve instruction. */
export async function deriveNewReserveAddresses(program: Program<anchor.Idl>, programId: PublicKey): Promise<NewReserveAddresses> {
  const protocolConfig = findProtocolConfig(programId)[0];
  const config: any = await (program.account as any).protocolConfig.fetch(protocolConfig);
  const reserveId = BigInt(config.reserveCount.toString());
  const [reserve] = findReserve(reserveId, programId);
  const [reserveTokenMint] = findReserveTokenMint(reserve, programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  return { reserveId, reserve, reserveTokenMint, mintAuthority, vaultAuthority, protocolConfig };
}

export interface CreateReserveParams {
  metadataUri: string;
  mintFeeBps: number;
  redemptionFeeBps: number;
  tvlFeeBps: number;
  managerFeeShareBps: number;
  protocolFeeShareBps: number;
  feeDestination: PublicKey;
}

export async function buildCreateReserveInstruction(
  program: Program<anchor.Idl>,
  addresses: NewReserveAddresses,
  manager: PublicKey,
  params: CreateReserveParams,
): Promise<TransactionInstruction> {
  return program.methods
    .createReserve(params.metadataUri, params.mintFeeBps, params.redemptionFeeBps, params.tvlFeeBps, params.managerFeeShareBps, params.protocolFeeShareBps, params.feeDestination)
    .accounts({
      protocolConfig: addresses.protocolConfig,
      reserve: addresses.reserve,
      mintAuthority: addresses.mintAuthority,
      reserveTokenMint: addresses.reserveTokenMint,
      manager,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
}

export interface ReserveAssetAddresses {
  mint: PublicKey;
  reserveAsset: PublicKey;
  vault: PublicKey;
}

export function deriveReserveAssetAddresses(reserve: PublicKey, mint: PublicKey, programId: PublicKey): ReserveAssetAddresses {
  const [reserveAsset] = findReserveAsset(reserve, mint, programId);
  const [vault] = findReserveVault(reserve, mint, programId);
  return { mint, reserveAsset, vault };
}

export async function buildInitializeReserveAssetInstruction(
  program: Program<anchor.Idl>,
  addresses: NewReserveAddresses,
  asset: ReserveAssetAddresses,
  manager: PublicKey,
  weightBps: number,
): Promise<TransactionInstruction> {
  return program.methods
    .initializeReserveAsset(weightBps)
    .accounts({
      protocolConfig: addresses.protocolConfig,
      reserve: addresses.reserve,
      reserveAsset: asset.reserveAsset,
      assetMint: asset.mint,
      vault: asset.vault,
      vaultAuthority: addresses.vaultAuthority,
      manager,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
}

export async function buildSeedReserveInstruction(
  program: Program<anchor.Idl>,
  addresses: NewReserveAddresses,
  assets: ReserveAssetAddresses[],
  manager: PublicKey,
  seedAmounts: bigint[],
  initialReserveTokens: bigint,
): Promise<TransactionInstruction> {
  const managerReserveTokenAta = getAssociatedTokenAddressSync(addresses.reserveTokenMint, manager);
  const remainingAccounts = assets.flatMap((a) => {
    const managerAssetAta = getAssociatedTokenAddressSync(a.mint, manager);
    return [
      { pubkey: a.reserveAsset, isWritable: false, isSigner: false },
      { pubkey: a.vault, isWritable: true, isSigner: false },
      { pubkey: managerAssetAta, isWritable: true, isSigner: false },
      { pubkey: a.mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ];
  });

  return program.methods
    .seedReserve(
      seedAmounts.map((a) => new BN(a.toString())),
      new BN(initialReserveTokens.toString()),
    )
    .accounts({
      protocolConfig: addresses.protocolConfig,
      reserve: addresses.reserve,
      reserveTokenMint: addresses.reserveTokenMint,
      mintAuthority: addresses.mintAuthority,
      managerReserveTokenAccount: managerReserveTokenAta,
      manager,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
}
