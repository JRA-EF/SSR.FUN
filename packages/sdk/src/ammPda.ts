// PDA derivation for ssr_devnet_amm. Must mirror
// programs/ssr_devnet_amm/src/constants.rs exactly. See DEC-0051.
import { PublicKey } from "@solana/web3.js";

export const SSR_DEVNET_AMM_PROGRAM_ID = new PublicKey("AJbXGWSU1x9LtJW7uRKJCwS3JZYqXwqHXpX6erY7dS6c");

export const AMM_CONFIG_SEED = Buffer.from("amm_config");
export const AMM_POOL_SEED = Buffer.from("amm_pool");
export const AMM_VAULT_AUTHORITY_SEED = Buffer.from("amm_vault_authority");
export const AMM_VAULT_SEED = Buffer.from("amm_vault");

export function findAmmConfig(programId: PublicKey = SSR_DEVNET_AMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AMM_CONFIG_SEED], programId);
}

export function findAmmPool(mintA: PublicKey, mintB: PublicKey, programId: PublicKey = SSR_DEVNET_AMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AMM_POOL_SEED, mintA.toBuffer(), mintB.toBuffer()], programId);
}

export function findAmmVaultAuthority(pool: PublicKey, programId: PublicKey = SSR_DEVNET_AMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AMM_VAULT_AUTHORITY_SEED, pool.toBuffer()], programId);
}

export function findAmmVault(pool: PublicKey, mint: PublicKey, programId: PublicKey = SSR_DEVNET_AMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AMM_VAULT_SEED, pool.toBuffer(), mint.toBuffer()], programId);
}
