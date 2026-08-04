// Builds instructions for ssr_devnet_amm. See DEC-0051 for the full
// architecture/security model. Every builder returns an unsigned
// TransactionInstruction (same pattern as zapInstructions.ts/
// managementInstructions.ts) -- callers must call assertDevnetCluster
// (./network.ts) before ever sending a transaction built from these.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findAmmConfig, findAmmPool, findAmmVault, findAmmVaultAuthority } from "./ammPda";

/** `hubMint` is the AMM's hub asset (devUSDC on this deployment) -- every pool's mint_a must equal it (see create_pool.rs). Set once here, immutable afterward. */
export async function buildInitializeAmmConfigInstruction(
  program: Program<anchor.Idl>,
  authority: PublicKey,
  hubMint: PublicKey,
  defaultFeeBps: number,
): Promise<TransactionInstruction> {
  const [ammConfig] = findAmmConfig();
  return program.methods
    .initializeAmmConfig(hubMint, defaultFeeBps)
    .accounts({ ammConfig, authority, systemProgram: anchor.web3.SystemProgram.programId })
    .instruction();
}

export async function buildCreatePoolInstruction(
  program: Program<anchor.Idl>,
  authority: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  feeBps: number,
): Promise<TransactionInstruction> {
  const [ammConfig] = findAmmConfig();
  const [pool] = findAmmPool(mintA, mintB);
  const [vaultA] = findAmmVault(pool, mintA);
  const [vaultB] = findAmmVault(pool, mintB);
  const [vaultAuthority] = findAmmVaultAuthority(pool);
  return program.methods
    .createPool(feeBps)
    .accounts({
      ammConfig,
      pool,
      mintA,
      mintB,
      vaultA,
      vaultB,
      vaultAuthority,
      authority,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();
}

export async function buildAddLiquidityInstruction(
  program: Program<anchor.Idl>,
  authority: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  amountA: bigint,
  amountB: bigint,
): Promise<TransactionInstruction> {
  const [ammConfig] = findAmmConfig();
  const [pool] = findAmmPool(mintA, mintB);
  const [vaultA] = findAmmVault(pool, mintA);
  const [vaultB] = findAmmVault(pool, mintB);
  return program.methods
    .addLiquidity(new BN(amountA.toString()), new BN(amountB.toString()))
    .accounts({
      ammConfig,
      pool,
      mintA,
      mintB,
      vaultA,
      vaultB,
      authorityTokenA: getAssociatedTokenAddressSync(mintA, authority),
      authorityTokenB: getAssociatedTokenAddressSync(mintB, authority),
      authority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function buildRemoveLiquidityInstruction(
  program: Program<anchor.Idl>,
  authority: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  amountA: bigint,
  amountB: bigint,
): Promise<TransactionInstruction> {
  const [ammConfig] = findAmmConfig();
  const [pool] = findAmmPool(mintA, mintB);
  const [vaultA] = findAmmVault(pool, mintA);
  const [vaultB] = findAmmVault(pool, mintB);
  const [vaultAuthority] = findAmmVaultAuthority(pool);
  return program.methods
    .removeLiquidity(new BN(amountA.toString()), new BN(amountB.toString()))
    .accounts({
      ammConfig,
      pool,
      mintA,
      mintB,
      vaultA,
      vaultB,
      vaultAuthority,
      authorityTokenA: getAssociatedTokenAddressSync(mintA, authority),
      authorityTokenB: getAssociatedTokenAddressSync(mintB, authority),
      authority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export interface BuildSwapParams {
  program: Program<anchor.Idl>;
  trader: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
  aToB: boolean;
  /** Override the trader's token_a/token_b accounts (e.g. a different mint's ATA if mint_a/mint_b were swapped for the call) -- defaults to the trader's own ATAs. */
  traderTokenA?: PublicKey;
  traderTokenB?: PublicKey;
}

export async function buildSwapInstruction(params: BuildSwapParams): Promise<TransactionInstruction> {
  const { program, trader, mintA, mintB, amountIn, minimumAmountOut, aToB } = params;
  const [ammConfig] = findAmmConfig();
  const [pool] = findAmmPool(mintA, mintB);
  const [vaultA] = findAmmVault(pool, mintA);
  const [vaultB] = findAmmVault(pool, mintB);
  const [vaultAuthority] = findAmmVaultAuthority(pool);
  return program.methods
    .swap(new BN(amountIn.toString()), new BN(minimumAmountOut.toString()), aToB)
    .accounts({
      ammConfig,
      pool,
      mintA,
      mintB,
      vaultA,
      vaultB,
      vaultAuthority,
      traderTokenA: params.traderTokenA ?? getAssociatedTokenAddressSync(mintA, trader),
      traderTokenB: params.traderTokenB ?? getAssociatedTokenAddressSync(mintB, trader),
      trader,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function buildPauseAmmInstruction(program: Program<anchor.Idl>, authority: PublicKey): Promise<TransactionInstruction> {
  const [ammConfig] = findAmmConfig();
  return program.methods.pauseAmm().accounts({ ammConfig, authority }).instruction();
}

export async function buildUnpauseAmmInstruction(program: Program<anchor.Idl>, authority: PublicKey): Promise<TransactionInstruction> {
  const [ammConfig] = findAmmConfig();
  return program.methods.unpauseAmm().accounts({ ammConfig, authority }).instruction();
}
