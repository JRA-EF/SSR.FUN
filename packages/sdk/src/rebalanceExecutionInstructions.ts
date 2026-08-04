// Builds instructions for ssr_protocol's execute_rebalance_leg (see
// programs/ssr_protocol/src/instructions/execute_rebalance_leg.rs) and the
// pure client-side planning function that turns a set of target-weight
// edits into an ordered list of legs to execute. NOT YET BUILDABLE/DEPLOYABLE
// in this environment (no cargo/rustc/anchor/solana on PATH) -- see this
// pass's final report. Kept in its own file (rather than
// managementInstructions.ts) since it's the one place needing both
// ssr_protocol's own PDAs and ssr_devnet_amm's PDAs together.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findReserveAsset, findReserveVault, findVaultAuthority } from "./pda";
import { findAmmConfig, findAmmPool, findAmmVault, findAmmVaultAuthority, SSR_DEVNET_AMM_PROGRAM_ID } from "./ammPda";

export async function buildExecuteRebalanceLegInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  reserve: PublicKey,
  signer: PublicKey,
  delegate: PublicKey,
  mintSell: PublicKey,
  mintBuy: PublicKey,
  amountIn: bigint,
  minimumAmountOut: bigint,
  ammProgramId: PublicKey = SSR_DEVNET_AMM_PROGRAM_ID,
): Promise<TransactionInstruction> {
  const [reserveAssetSell] = findReserveAsset(reserve, mintSell, programId);
  const [reserveVaultSell] = findReserveVault(reserve, mintSell, programId);
  const [reserveAssetBuy] = findReserveAsset(reserve, mintBuy, programId);
  const [reserveVaultBuy] = findReserveVault(reserve, mintBuy, programId);
  const [vaultAuthority] = findVaultAuthority(reserve, programId);

  const [ammConfig] = findAmmConfig(ammProgramId);
  const [ammPool] = findAmmPool(mintSell, mintBuy, ammProgramId); // findAmmPool derives the same pool regardless of argument order -- see ammPda.ts.
  const [ammVaultA] = findAmmVault(ammPool, mintSell, ammProgramId);
  const [ammVaultB] = findAmmVault(ammPool, mintBuy, ammProgramId);
  const [ammVaultAuthority] = findAmmVaultAuthority(ammPool, ammProgramId);

  return program.methods
    .executeRebalanceLeg(new BN(amountIn.toString()), new BN(minimumAmountOut.toString()))
    .accounts({
      reserve,
      delegate,
      signer,
      reserveAssetSell,
      reserveVaultSell,
      mintSell,
      reserveAssetBuy,
      reserveVaultBuy,
      mintBuy,
      vaultAuthority,
      ammProgram: ammProgramId,
      ammConfig,
      ammPool,
      ammVaultA,
      ammVaultB,
      ammVaultAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export interface RebalancePlanLeg {
  mintSell: string;
  mintBuy: string;
  /** USD value of this leg, per the same TEST_ASSET_PRICES_USD convention used throughout this codebase (onChainReserve.ts, zapPricing.ts) -- the caller converts to a raw amountIn via the sell asset's live AMM pool reserves before submitting. */
  usdValue: number;
}

/**
 * Pure planning function: given a Reserve's current vault balances and its
 * (just-submitted) new target weights, computes an ordered list of
 * sell/buy legs that would move the Reserve toward those targets --
 * greedily pairs the most-overweight asset with the most-underweight one,
 * repeatedly, until every asset's deviation is smaller than `toleranceUsd`.
 * Does NOT touch the network or build any instruction -- see
 * buildExecuteRebalanceLegInstruction/managementClient.ts's
 * executeRebalancePlan for the orchestration that actually submits each
 * leg as its own transaction, quoting against live AMM pool reserves
 * immediately before building it (this function's `usdValue` is a
 * planning-time estimate only, not a final amount).
 */
export function computeRebalancePlan(
  assets: { mint: string; vaultBalanceRaw: string; decimals: number }[],
  targetWeightsBps: number[],
  testPricesUsd: Record<string, number>,
  toleranceUsd = 0.01,
): RebalancePlanLeg[] {
  if (assets.length !== targetWeightsBps.length) {
    throw new Error("computeRebalancePlan: assets and targetWeightsBps must be the same length.");
  }

  const currentUsd = assets.map((a) => {
    const price = testPricesUsd[a.mint];
    if (price === undefined) throw new Error(`computeRebalancePlan: no test price configured for mint ${a.mint}.`);
    return (Number(a.vaultBalanceRaw) / 10 ** a.decimals) * price;
  });
  const totalUsd = currentUsd.reduce((sum, v) => sum + v, 0);

  // Deviation = current USD value minus target USD value. Positive =
  // overweight (a sell candidate), negative = underweight (a buy candidate).
  const deviations = assets.map((_, i) => currentUsd[i] - (totalUsd * targetWeightsBps[i]) / 10_000);

  const legs: RebalancePlanLeg[] = [];
  // Work on a mutable copy so repeatedly picking the largest deviation
  // reflects legs already planned earlier in this same call.
  const working = [...deviations];

  for (;;) {
    let sellIdx = -1;
    let buyIdx = -1;
    for (let i = 0; i < working.length; i++) {
      if (sellIdx === -1 || working[i] > working[sellIdx]) sellIdx = i;
      if (buyIdx === -1 || working[i] < working[buyIdx]) buyIdx = i;
    }
    if (sellIdx === -1 || buyIdx === -1 || sellIdx === buyIdx) break;
    if (working[sellIdx] <= toleranceUsd || working[buyIdx] >= -toleranceUsd) break;

    const legUsd = Math.min(working[sellIdx], -working[buyIdx]);
    legs.push({ mintSell: assets[sellIdx].mint, mintBuy: assets[buyIdx].mint, usdValue: legUsd });
    working[sellIdx] -= legUsd;
    working[buyIdx] += legUsd;
  }

  return legs;
}
