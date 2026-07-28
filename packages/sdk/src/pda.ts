// Canonical PDA derivation for the SSR Protocol. Must mirror
// programs/ssr_protocol/src/constants.rs seed prefixes EXACTLY -- if a seed
// prefix changes on the Rust side, it must change here too.
import { PublicKey } from "@solana/web3.js";

export const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config");
export const RESERVE_SEED = Buffer.from("reserve");
export const RESERVE_ASSET_SEED = Buffer.from("reserve_asset");
export const RESERVE_VAULT_SEED = Buffer.from("reserve_vault");
export const VAULT_AUTHORITY_SEED = Buffer.from("vault_authority");
export const RESERVE_TOKEN_MINT_SEED = Buffer.from("reserve_token_mint");
export const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");
export const DELEGATE_SEED = Buffer.from("delegate");

export function findProtocolConfig(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], programId);
}

export function findReserve(reserveId: bigint, programId: PublicKey): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(reserveId);
  return PublicKey.findProgramAddressSync([RESERVE_SEED, buf], programId);
}

export function findReserveAsset(reserve: PublicKey, assetMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RESERVE_ASSET_SEED, reserve.toBuffer(), assetMint.toBuffer()], programId);
}

export function findReserveVault(reserve: PublicKey, assetMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RESERVE_VAULT_SEED, reserve.toBuffer(), assetMint.toBuffer()], programId);
}

export function findVaultAuthority(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_AUTHORITY_SEED, reserve.toBuffer()], programId);
}

export function findReserveTokenMint(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RESERVE_TOKEN_MINT_SEED, reserve.toBuffer()], programId);
}

export function findMintAuthority(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED, reserve.toBuffer()], programId);
}

export function findDelegate(reserve: PublicKey, wallet: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DELEGATE_SEED, reserve.toBuffer(), wallet.toBuffer()], programId);
}
