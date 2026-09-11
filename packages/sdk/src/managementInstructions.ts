// Builds instructions for Phase F (composition management) and Phase G
// (wind-down) -- see docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md
// "Phase F/G" and DEC-0046. Also builds update_targets (a pre-existing
// instruction that had never actually been wired to a real signed
// transaction from the browser before this pass -- ManageDTR's Rebalance
// tab only ever simulated it locally for on-chain Reserves).
//
// Every function here returns an unsigned TransactionInstruction (built
// against the read-only program instance, same pattern as
// zapInstructions.ts) -- the caller assembles a Transaction, gets it signed
// by the connected wallet, and submits it. No server-side signer is
// involved in any of these: every action here is either root-manager-only
// or manager-or-permitted-delegate, never something a DevNet swap-authority
// key could or should co-sign.
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findDelegate, findProtocolConfig, findReserveAsset, findReserveVault, findVaultAuthority, findMintAuthority, findReserveTokenMint, findManagerFeeRecipients } from "./pda";
import type { RecipientInput } from "./feeMath";

/**
 * Points `reserve.metadata_uri` at a new off-chain metadata URL (this app's
 * own content-addressed reserve-metadata store -- see
 * src/merge/lib/createReserveClient.ts's uploadReserveMetadata). Gated
 * on-chain by require_reserve_permission(UPDATE_METADATA): the Reserve's
 * root manager, or a delegate holding that permission (see
 * update_metadata.rs). `delegate` is the signer's OWN Delegate PDA (via
 * findDelegate) -- only deserialized on-chain when signer != manager, same
 * contract as every other builder here. The caller MUST have already run
 * metadataUri.ts's validateMetadataUri on `newMetadataUri`.
 */
export async function buildUpdateMetadataInstruction(
  program: Program<anchor.Idl>,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  newMetadataUri: string,
): Promise<TransactionInstruction> {
  return program.methods
    .updateMetadata(newMetadataUri)
    .accounts({ reserve, delegate, signer })
    .instruction();
}

/**
 * The Metaplex Token Metadata program and the Metadata PDA for a mint
 * (DEC-0200). Wallets and explorers derive exactly this address to find a
 * token's name/symbol/image, which is why publishing to it is what makes a
 * Reserve Token stop rendering as a raw address.
 */
export const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export function findTokenMetadata(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  );
}

/**
 * Publishes Metaplex metadata for a Reserve Token mint (DEC-0200). The
 * program signs the Metaplex CPI with the mint-authority PDA, so this is the
 * ONLY way such a mint can ever get metadata -- no off-chain tool can do it.
 *
 * Idempotent on-chain: a mint that already has a metadata account is left
 * untouched, so this doubles as the repair path for Reserves created before
 * the instruction existed.
 *
 * `uri` must be the Reserve's public metadata URL (the same one stored in
 * Reserve.metadata_uri), and `name`/`symbol` are capped on-chain at 32 and 10
 * bytes -- callers should pass the Reserve's name and ticker, truncated by
 * the caller if genuinely longer.
 */
export async function buildCreateTokenMetadataInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  payer: PublicKey,
  delegate: PublicKey,
  name: string,
  symbol: string,
  uri: string,
): Promise<TransactionInstruction> {
  const [reserveTokenMint] = findReserveTokenMint(reserve, programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const [metadata] = findTokenMetadata(reserveTokenMint);
  return program.methods
    .createTokenMetadata(name, symbol, uri)
    .accounts({
      reserve,
      reserveTokenMint,
      mintAuthority,
      metadata,
      delegate,
      payer,
      metadataProgram: METAPLEX_TOKEN_METADATA_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

/** reserve.asset_count ReserveAsset PDAs, in order_index order -- see common.rs::load_reserve_asset_configs. */
export async function buildUpdateTargetsInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  assetMintsInOrder: PublicKey[],
  newTargetWeightsBps: number[],
): Promise<TransactionInstruction> {
  const remainingAccounts = assetMintsInOrder.map((mint) => ({
    pubkey: findReserveAsset(reserve, mint, programId)[0],
    isWritable: true,
    isSigner: false,
  }));
  return program.methods
    .updateTargets(newTargetWeightsBps)
    .accounts({ reserve, delegate, signer })
    .remainingAccounts(remainingAccounts)
    .instruction();
}

export async function buildAddReserveAssetActiveInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  assetMint: PublicKey,
  targetWeightBps: number,
): Promise<TransactionInstruction> {
  const [protocolConfig] = findProtocolConfig(programId);
  const [reserveAsset] = findReserveAsset(reserve, assetMint, programId);
  const [vault] = findReserveVault(reserve, assetMint, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  return program.methods
    .addReserveAssetActive(targetWeightBps)
    .accounts({
      protocolConfig,
      reserve,
      reserveAsset,
      assetMint,
      vault,
      vaultAuthority,
      delegate,
      signer,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function buildFundNewReserveAssetInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  manager: PublicKey,
  assetMint: PublicKey,
  amountRaw: bigint,
): Promise<TransactionInstruction> {
  const [reserveAsset] = findReserveAsset(reserve, assetMint, programId);
  const [vault] = findReserveVault(reserve, assetMint, programId);
  const managerTokenAccount = getAssociatedTokenAddressSync(assetMint, manager);
  return program.methods
    .fundNewReserveAsset(new BN(amountRaw.toString()))
    .accounts({
      reserve,
      reserveAsset,
      assetMint,
      vault,
      managerTokenAccount,
      manager,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function buildRemoveReserveAssetInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveManager: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  assetMint: PublicKey,
): Promise<TransactionInstruction> {
  const [reserveAsset] = findReserveAsset(reserve, assetMint, programId);
  const [vault] = findReserveVault(reserve, assetMint, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  return program.methods
    .removeReserveAsset()
    .accounts({
      reserve,
      reserveAsset,
      assetMint,
      vault,
      vaultAuthority,
      manager: reserveManager,
      delegate,
      signer,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Grants a new delegate (or re-adds a removed one). Restricted grants are gated by the acting signer's own ADD_RESTRICTED_DELEGATE permission (require_reserve_permission); an unrestricted grant is root-manager-only regardless of `actingDelegate`'s contents -- see add_delegate.rs. */
export async function buildAddDelegateInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  actingDelegate: PublicKey,
  delegateWallet: PublicKey,
  permissions: number,
  restricted: boolean,
): Promise<TransactionInstruction> {
  const [delegateAccount] = findDelegate(reserve, delegateWallet, programId);
  return program.methods
    .addDelegate(delegateWallet, permissions, restricted)
    .accounts({
      reserve,
      delegateAccount,
      actingDelegate,
      signer,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Rewrites an existing delegate's permission bitmask. Gated the same way as buildAddDelegateInstruction -- see update_delegate_permissions.rs. */
export async function buildUpdateDelegatePermissionsInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  actingDelegate: PublicKey,
  delegateWallet: PublicKey,
  newPermissions: number,
): Promise<TransactionInstruction> {
  const [delegateAccount] = findDelegate(reserve, delegateWallet, programId);
  return program.methods
    .updateDelegatePermissions(newPermissions)
    .accounts({ reserve, delegateAccount, actingDelegate, signer })
    .instruction();
}

/** Revokes a delegate, closing its PDA and reclaiming rent to `signer`. Gated the same way as buildAddDelegateInstruction -- see remove_delegate.rs. */
export async function buildRemoveDelegateInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  actingDelegate: PublicKey,
  delegateWallet: PublicKey,
): Promise<TransactionInstruction> {
  const [delegateAccount] = findDelegate(reserve, delegateWallet, programId);
  return program.methods
    .removeDelegate()
    .accounts({ reserve, delegateAccount, actingDelegate, signer })
    .instruction();
}

export async function buildInitiateWindDownInstruction(
  program: Program<anchor.Idl>,
  reserve: PublicKey,
  manager: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods.initiateWindDown().accounts({ reserve, manager }).instruction();
}

/**
 * Permissionless -- see collect_fees.rs's header comment: this only mints
 * already-accounted pending shares to fixed, Reserve/ProtocolConfig-
 * configured destinations; the caller cannot redirect funds anywhere, so
 * ANY wallet may call this (and cover the one-time destination-ATA rent as
 * `payer` if either destination doesn't have a Reserve Token account yet).
 * `managerFeeDestination`/`protocolFeeDestination` must be read live from
 * chain immediately before calling (Reserve.feeConfig.feeDestination /
 * ProtocolConfig.defaultProtocolFeeDestination) -- neither is a derivable
 * PDA, and the program itself validates both against those exact fields.
 */
export async function buildCollectFeesInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveTokenMint: PublicKey,
  managerFeeDestination: PublicKey,
  protocolFeeDestination: PublicKey,
  payer: PublicKey,
): Promise<TransactionInstruction> {
  const [protocolConfig] = findProtocolConfig(programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const managerFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, managerFeeDestination);
  const protocolFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
  return program.methods
    .collectFees()
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      managerFeeDestinationTokenAccount,
      managerFeeDestination,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      payer,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * Collects ONLY the Protocol's pending fee share -- see
 * collect_protocol_fee.rs's header. Permissionless, same rationale as
 * buildCollectFeesInstruction above: funds can only ever go to the fixed
 * ProtocolConfig.defaultProtocolFeeDestination, never wherever the caller
 * chooses, so any wallet may call this (and front the destination-ATA rent
 * as `payer`). This is what api/devnet/accrue-fees-cron.ts's weekly keeper
 * calls for every Reserve with a nonzero pending Protocol balance -- the
 * mechanism behind "the Protocol never has to manually claim its fees."
 * `protocolFeeDestination` must be read live from chain immediately before
 * calling (ProtocolConfig.defaultProtocolFeeDestination) -- not a derivable
 * PDA, and the program itself validates it against that exact field.
 */
export async function buildCollectProtocolFeeInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveTokenMint: PublicKey,
  protocolFeeDestination: PublicKey,
  payer: PublicKey,
): Promise<TransactionInstruction> {
  const [protocolConfig] = findProtocolConfig(programId);
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const protocolFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
  return program.methods
    .collectProtocolFee()
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      payer,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** remaining_accounts: reserve.asset_count pairs of [reserveAsset, vault], in order_index order -- see close_reserve.rs. */
export async function buildCloseReserveInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveTokenMint: PublicKey,
  manager: PublicKey,
  assetMintsInOrder: PublicKey[],
  /** Whether this Reserve's ManagerFeeRecipients PDA exists (multi-recipient routing opted in). When false the program-ID "None" sentinel is passed -- the account is `Option` on-chain and passing the uninitialized PDA fails with 3012 AccountNotInitialized (live 2026-09-08, Reserve #21). */
  managerFeeRecipientsInitialized = true,
): Promise<TransactionInstruction> {
  const [vaultAuthority] = findVaultAuthority(reserve, programId);
  const remainingAccounts = assetMintsInOrder.flatMap((mint) => [
    { pubkey: findReserveAsset(reserve, mint, programId)[0], isWritable: true, isSigner: false },
    { pubkey: findReserveVault(reserve, mint, programId)[0], isWritable: true, isSigner: false },
  ]);
  const [managerFeeRecipients] = findManagerFeeRecipients(reserve, programId);
  return program.methods
    .closeReserve()
    .accounts({ reserve, reserveTokenMint, vaultAuthority, managerFeeRecipients: managerFeeRecipientsInitialized ? managerFeeRecipients : programId, manager, tokenProgram: TOKEN_PROGRAM_ID } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
}

// --- DEC-0094: multi-recipient Manager fees ---

/**
 * Replaces an already-migrated Reserve's Manager fee routing atomically.
 * Blocked on-chain while any CURRENT recipient still has an uncollected
 * pending balance -- callers should bundle a `collect_manager_fee_share`
 * call per current recipient with a nonzero pending balance into the SAME
 * transaction ahead of this one when needed (see
 * src/merge/lib/managementClient.ts's executeUpdateFeeRecipients).
 */
export async function buildUpdateFeeRecipientsInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  recipients: RecipientInput[],
): Promise<TransactionInstruction> {
  const [managerFeeRecipients] = findManagerFeeRecipients(reserve, programId);
  return program.methods
    .updateFeeRecipients(recipients.map((r) => ({ wallet: new PublicKey(r.wallet), allocationBps: r.allocationBps })))
    .accounts({ reserve, managerFeeRecipients, delegate, signer } as any)
    .instruction();
}

/**
 * Permissionless (mirrors collect_fees.rs's "any wallet may trigger the
 * payout" design) -- pays out ONE named recipient's own accrued balance to
 * their own ATA. Falls back to the legacy `feeDestination`/
 * `pendingManagerFeeShares` path when the Reserve hasn't opted into
 * multi-recipient routing yet (pass `managerFeeRecipientsExists = false` in
 * that case so the optional account is omitted -- the client library
 * substitutes the program ID sentinel automatically).
 */
/**
 * CLAIMANT-ONLY (see collect_manager_fee_share.rs's header): `recipient`
 * must be the wallet actually signing this transaction -- the on-chain
 * `Signer` constraint makes it structurally impossible for any other
 * wallet, including the root Manager, to collect on this recipient's
 * behalf. `recipient` also pays its own ATA rent now (no separate `payer`).
 */
export async function buildCollectManagerFeeShareInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  reserveTokenMint: PublicKey,
  recipient: PublicKey,
  managerFeeRecipientsExists: boolean,
): Promise<TransactionInstruction> {
  const [mintAuthority] = findMintAuthority(reserve, programId);
  const [managerFeeRecipients] = findManagerFeeRecipients(reserve, programId);
  const recipientTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, recipient);
  return program.methods
    .collectManagerFeeShare()
    .accounts({
      reserve,
      reserveTokenMint,
      mintAuthority,
      managerFeeRecipients: managerFeeRecipientsExists ? managerFeeRecipients : null,
      recipient,
      recipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
}
