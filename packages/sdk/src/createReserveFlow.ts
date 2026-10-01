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
import { assetAta, resolveLegTokenProgram, TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID } from "./tokenPrograms";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findReserve, findReserveTokenMint, findMintAuthority, findVaultAuthority, findReserveAsset, findReserveVault, findProtocolConfig, findManagerFeeRecipients, findTvlAccrual, findFeeSettlement, findFeeVaultAuthority, findFeeVaultAta } from "./pda";
import type { RecipientInput } from "./feeMath";

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

/**
 * DEC-0094: `managerFeeShareBps`/`protocolFeeShareBps` are no longer
 * caller-supplied -- the Protocol/Manager split is always derived on-chain,
 * fresh at every mint/accrual, from `mintFeeBps`/`tvlFeeBps` alone via the
 * SSR.fun fee formula (see packages/sdk/src/feeMath.ts). `feeDestination`
 * is the "Primary Fee Destination": the sole implicit Manager fee recipient
 * (100% of the Manager's share) unless the creator ALSO bundles
 * `buildInitializeManagerFeeRecipientsInstruction` into the same
 * transaction for >1 recipient.
 */
export interface CreateReserveParams {
  metadataUri: string;
  mintFeeBps: number;
  redemptionFeeBps: number;
  tvlFeeBps: number;
  feeDestination: PublicKey;
}

export async function buildCreateReserveInstruction(
  program: Program<anchor.Idl>,
  addresses: NewReserveAddresses,
  manager: PublicKey,
  params: CreateReserveParams,
): Promise<TransactionInstruction> {
  return program.methods
    .createReserve(params.metadataUri, params.mintFeeBps, params.redemptionFeeBps, params.tvlFeeBps, params.feeDestination)
    .accounts({
      protocolConfig: addresses.protocolConfig,
      reserve: addresses.reserve,
      mintAuthority: addresses.mintAuthority,
      reserveTokenMint: addresses.reserveTokenMint,
      manager,
      // The RESERVE TOKEN mint itself is always classic SPL Token -- it is
      // created by this program, not chosen by anyone (DEC-0201 changes only
      // the ASSET side, see buildInitializeReserveAssetInstruction below).
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
}

/**
 * DEC-0094: opts a freshly-created (or already-existing) Reserve into
 * multi-recipient Manager fee routing for the first time. When creating a
 * Reserve with >1 recipient, bundle this in the SAME transaction as
 * `buildCreateReserveInstruction` (the `reserve` PDA it seeds/derives from
 * was just created earlier in that same transaction -- Solana executes
 * instructions sequentially against shared account state, the same pattern
 * `executeSubmitRebalance` already relies on in managementClient.ts).
 * `payer` covers this new account's one-time rent.
 */
export async function buildInitializeManagerFeeRecipientsInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  payer: PublicKey,
  recipients: RecipientInput[],
): Promise<TransactionInstruction> {
  const [managerFeeRecipients] = findManagerFeeRecipients(reserve, programId);
  return program.methods
    .initializeManagerFeeRecipients(recipients.map((r) => ({ wallet: new PublicKey(r.wallet), allocationBps: r.allocationBps })))
    .accounts({
      reserve,
      managerFeeRecipients,
      delegate,
      signer,
      payer,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
}

export interface ReserveAssetAddresses {
  mint: PublicKey;
  reserveAsset: PublicKey;
  vault: PublicKey;
  /**
   * The token program that owns this mint (DEC-0201). Optional: absent means
   * classic SPL Token, which every asset selectable before Token-2022 support
   * was. The VAULT is created under this program by initialize_reserve_asset,
   * and the on-chain ReserveAsset records it, so getting it wrong here makes
   * the asset permanently unusable -- callers read it from the mint account's
   * owner (or the asset catalogue), never guess.
   */
  tokenProgram?: PublicKey;
}

export function deriveReserveAssetAddresses(
  reserve: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
  tokenProgram?: PublicKey,
): ReserveAssetAddresses {
  const [reserveAsset] = findReserveAsset(reserve, mint, programId);
  const [vault] = findReserveVault(reserve, mint, programId);
  return { mint, reserveAsset, vault, ...(tokenProgram ? { tokenProgram } : {}) };
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
      // DEC-0201: the asset's OWN program -- this is what the instruction
      // records on ReserveAsset and creates the vault under.
      tokenProgram: resolveLegTokenProgram({ tokenProgram: asset.tokenProgram ?? null }),
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
  // DEC-0173: the initial seed mint is fee-charged like any other mint, and
  // -- exactly like mint_reserve_tokens_in_kind since Tier B (DEC-0184) --
  // BOTH the Protocol and Manager shares of that fee now crystallize into
  // the Reserve's shared fee vault (settled to USDC later by the keeper,
  // see api/mainnet/fee-settlement-cron.ts). The old instant-mint-to-
  // treasury (`protocol_fee_destination` + its token account, with the
  // 2026-08-17 duplicate-ATA "None" sentinel dance) and the Manager pending
  // counter (`manager_fee_recipients` sentinel) are gone from seed_reserve's
  // account struct entirely, replaced by the same 3-for-3 swap the mint
  // builder in directInstructions.ts already made: {feeSettlement, feeVault,
  // feeVaultAuthority}, all pure PDA/ATA derivations -- no account fetch
  // needed here anymore. The manager fronts the one-time rent for
  // FeeSettlement + the fee-vault ATA (init_if_needed, payer = manager) on
  // this Reserve's very first crystallization -- which the seed always is.
  const [feeSettlement] = findFeeSettlement(addresses.reserve, program.programId);
  const [feeVaultAuthority] = findFeeVaultAuthority(addresses.reserve, program.programId);
  const feeVault = findFeeVaultAta(addresses.reserve, addresses.reserveTokenMint, program.programId);

  // Time-weighted average TVL accumulator (see docs/project/DECISION_LOG.md):
  // the initial seed mint checkpoints it too, same as every other mint.
  const [tvlAccrual] = findTvlAccrual(addresses.reserve, program.programId);

  const remainingAccounts = assets.flatMap((a) => {
    // DEC-0201: per-asset program, and an ATA derived under it.
    const legTokenProgram = resolveLegTokenProgram({ tokenProgram: a.tokenProgram ?? null });
    const managerAssetAta = assetAta(a.mint, manager, legTokenProgram);
    return [
      { pubkey: a.reserveAsset, isWritable: false, isSigner: false },
      { pubkey: a.vault, isWritable: true, isSigner: false },
      { pubkey: managerAssetAta, isWritable: true, isSigner: false },
      { pubkey: a.mint, isWritable: false, isSigner: false },
      { pubkey: legTokenProgram, isWritable: false, isSigner: false },
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
      feeSettlement,
      feeVault,
      feeVaultAuthority,
      tvlAccrual,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
}
