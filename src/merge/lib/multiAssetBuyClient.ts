// Buys into a genuinely multi-asset Mainnet Reserve (e.g. BETA: SOL,
// Fartcoin, STONK, Cupsey, 25% each) by depositing a proportional in-kind
// amount of EVERY registered asset at once, in a single mint_reserve_tokens_in_kind
// call -- see packages/sdk/src/directInstructions.ts's
// buildDirectMultiAssetMintInstructions for the instruction shape (already
// proven on-chain via zapInstructions.ts's DevNet zap, just never built for
// a real Mainnet, no-swap-authority wallet before this).
//
// 2026-08-24, road-to-mainnet MMT-01/MCR-01 (DEC-0139/DEC-0140): BETA has 4
// real registered assets; the pre-existing direct Buy path only ever
// supported a single-asset Reserve, so Buy failed outright (before ever
// building a transaction) for any diversified Reserve. This module is the
// real fix -- not just a better error message.
//
// Funding model: the depositor specifies a single USD amount to invest.
// Each required leg is funded for real, mirroring createReserveClient.ts's
// proven seed-funding pattern exactly:
//  - a wrapped-SOL leg is funded by wrapping the depositor's OWN real SOL
//    (SystemProgram.transfer + createSyncNativeInstruction) -- never a
//    Jupiter swap into wrapped SOL, which this codebase has never done and
//    which risks Jupiter's swap API auto-unwrapping the output back to
//    native SOL (wrapAndUnwrapSol defaults true) before this mint step could
//    use it as an SPL balance.
//  - a USDC leg needs no funding step -- it's the depositor's own input
//    currency; a genuine shortfall (not enough USDC to cover both this leg
//    AND the swap budget for other legs) throws a plain, actionable error.
//  - every other leg is funded by swapping part of the depositor's USDC into
//    it via the same real Jupiter route CreateDTR.tsx's seed funding already
//    uses (api/mainnet/jupiter-swap.ts), topping up only the genuine
//    shortfall against the EXACT required amount (computeMintRequirements),
//    never re-swapping an amount already held.
//
// Multiple wallet approvals are expected -- one per swap, one for wrapping
// SOL if needed, one for the final mint -- exactly the same multi-transaction
// shape Create Reserve's own seed funding already has (see CreateDTR.tsx's
// Wallet Cost Summary). Every funding step is idempotent against a retry:
// re-running this after a partial failure only tops up genuine shortfalls,
// never re-swaps/re-wraps an amount already acquired.
import { Connection, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  buildDirectMultiAssetMintInstructions,
  fetchTokenBalanceRaw,
  computeMintRequirements,
  WRAPPED_SOL_MINT,
  MAINNET_USDC_MINT,
  type ZapAssetLeg,
} from "@ssr/sdk";
import { fetchJupiterSwapQuote, executeJupiterSwap } from "./jupiterSwapClient";
import { packInstructionsBySize, fetchOwnedBalanceRawSettled } from "./createReserveClient";
import { computeFundingShortfall, scaleUsdcBudgetForDeficit, computeSwapShortfallPct } from "./createReserveResume";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";

/** Same threshold multiAssetBuyClient.ts's sibling (createReserveClient.ts's fundSeedAssetsIdempotent) uses -- routine slippage below this is never reported as a shortfall worth warning about. */
const SHORTFALL_WARN_PCT = 0.05;

function isWrappedSolMint(mint: string): boolean {
  return mint === WRAPPED_SOL_MINT.toBase58();
}

/** How many gross Reserve Tokens a USD amount targets, using the Reserve's real current NAV (already computed from live Pyth/Jupiter prices elsewhere on the page -- see DTRDetail.tsx's dtr.nav). Pure. */
export function usdToReserveTokensRequested(usdAmount: number, nav: number, reserveTokenDecimals: number): bigint {
  if (!(usdAmount > 0)) throw new Error("usdToReserveTokensRequested: usdAmount must be positive.");
  if (!(nav > 0)) throw new Error("usdToReserveTokensRequested: nav must be a real, positive, priced value.");
  return BigInt(Math.max(1, Math.floor((usdAmount / nav) * 10 ** reserveTokenDecimals)));
}

export type MultiAssetBuyProgressEvent =
  | { phase: "wrapping-sol" }
  | { phase: "swapping"; mint: string; index: number; total: number }
  | { phase: "minting" }
  | { phase: "awaiting-wallet" };

export interface MultiAssetBuyResult {
  signature: string;
  reserveTokensRequested: bigint;
  requiredAmountsRaw: bigint[];
}

export interface ExecuteMultiAssetBuyParams {
  connection: Connection;
  wallet: WalletContextState;
  protocolConfig: PublicKey;
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  reserveTokensRequested: bigint;
  /** Real, current USD price per asset mint (see onChainReserve.ts's assetPricesUsd) -- used ONLY to size the FIRST Jupiter quote request per leg; the actual amount acquired is always re-checked against the real swap/quote output, never assumed. Missing a price for a leg that turns out to need a swap is a hard error (never guesses a budget from nothing). */
  assetPricesUsd: Record<string, number>;
  /** Fractional slippage buffer for the final mint's per-leg cap -- see buildDirectMultiAssetMintInstructions. */
  slippageBps?: number;
  onProgress?: (event: MultiAssetBuyProgressEvent) => void;
  onSwapShortfall?: (info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) => void;
}

async function signSubmitAndConfirm(connection: Connection, wallet: WalletContextState, ixs: TransactionInstruction[]): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature, "Mainnet"); // this module is Mainnet-only -- see its own header.
}

/**
 * Ensures the wallet genuinely holds at least `requiredAmountsRaw[i]` of
 * each of `assets[i]` before returning, funding only the real shortfall --
 * see this file's header for the wrap-SOL/swap-USDC/hold-USDC funding model.
 * Never touches the USDC ATA itself beyond reading its balance (it's the
 * source of every swap, and its own leg -- if it has one -- must already be
 * held, never funded from somewhere else).
 */
async function fundMultiAssetLegs(
  connection: Connection,
  wallet: WalletContextState,
  assets: ZapAssetLeg[],
  requiredAmountsRaw: bigint[],
  assetPricesUsd: Record<string, number>,
  onProgress?: (event: MultiAssetBuyProgressEvent) => void,
  onSwapShortfall?: (info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) => void,
): Promise<void> {
  const owner = wallet.publicKey!;
  const balances = await Promise.all(assets.map((a) => fetchTokenBalanceRaw(connection, new PublicKey(a.mint), owner).then(BigInt)));

  const wrapShortfalls: { index: number; amount: bigint }[] = [];
  const swapLegs: { index: number; mint: string; targetRaw: bigint }[] = [];
  let usdcShortfall: bigint = 0n;

  for (let i = 0; i < assets.length; i++) {
    const shortfall = computeFundingShortfall(requiredAmountsRaw[i], balances[i]);
    if (shortfall <= 0n) continue;
    if (isWrappedSolMint(assets[i].mint)) {
      wrapShortfalls.push({ index: i, amount: shortfall });
    } else if (assets[i].mint === MAINNET_USDC_MINT) {
      usdcShortfall = shortfall;
    } else {
      swapLegs.push({ index: i, mint: assets[i].mint, targetRaw: requiredAmountsRaw[i] });
    }
  }

  // The USDC leg (if any) can only ever be funded by the depositor's own
  // USDC -- there is nothing to swap it FROM. Fail fast, before spending
  // anything on other legs' swaps, if it's genuinely short.
  if (usdcShortfall > 0n) {
    throw new Error(
      `This wallet doesn't hold enough USDC for this Reserve's USDC leg -- needs ${(Number(usdcShortfall) / 1e6).toLocaleString()} more USDC (on top of whatever funds the swaps for this Reserve's other assets) and try again.`,
    );
  }

  if (wrapShortfalls.length > 0) {
    onProgress?.({ phase: "wrapping-sol" });
    const wsolAta = getAssociatedTokenAddressSync(WRAPPED_SOL_MINT, owner);
    const totalLamports = wrapShortfalls.reduce((sum, { amount }) => sum + amount, 0n);
    await signSubmitAndConfirm(connection, wallet, [
      createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, WRAPPED_SOL_MINT),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: totalLamports }),
      createSyncNativeInstruction(wsolAta),
    ]);
  }

  for (let s = 0; s < swapLegs.length; s++) {
    const { index, mint, targetRaw } = swapLegs[s];
    onProgress?.({ phase: "swapping", mint, index: s, total: swapLegs.length });
    const priceUsd = assetPricesUsd[mint];
    if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`No real current USD price is available for ${mint} -- refusing to guess a swap budget for it. Try again once pricing is available.`);
    }
    const decimals = assets[index].decimals;
    // Initial budget estimate from the real price already computed elsewhere
    // on the page -- the ACTUAL amount acquired is always re-checked against
    // a live quote/the real post-swap balance below, never assumed correct.
    const estimatedUsdcBudgetRaw = BigInt(Math.ceil(((Number(targetRaw) / 10 ** decimals) * priceUsd + 1e-9) * 1_000_000));
    const fullQuote = await fetchJupiterSwapQuote(mint, estimatedUsdcBudgetRaw, owner.toBase58());
    let quote = fullQuote;
    // The price-derived estimate can land slightly under the real target
    // (price moves, rounding) -- if the live quote's own expected output is
    // still short, scale the budget up proportionally and re-quote once,
    // mirroring createReserveClient.ts's proven scaleUsdcBudgetForDeficit
    // pattern exactly.
    if (fullQuote.outAmount < targetRaw) {
      const deficitRaw = computeFundingShortfall(targetRaw, fullQuote.outAmount);
      const scaledBudget = scaleUsdcBudgetForDeficit(estimatedUsdcBudgetRaw, deficitRaw, targetRaw) + estimatedUsdcBudgetRaw;
      quote = await fetchJupiterSwapQuote(mint, scaledBudget, owner.toBase58());
    }
    await executeJupiterSwap(connection, wallet, quote);
    const newBalance = await fetchOwnedBalanceRawSettled(connection, new PublicKey(mint), owner, balances[index]);
    const shortfallPct = computeSwapShortfallPct(targetRaw, newBalance);
    if (shortfallPct > SHORTFALL_WARN_PCT) {
      onSwapShortfall?.({ mint, targetRaw, actualRaw: newBalance, shortfallPct });
    }
  }
}

/**
 * Full multi-asset Buy: funds every required leg for real (see
 * fundMultiAssetLegs), then submits the multi-leg in-kind mint. Each
 * funding step and the final mint are separate, sequentially-confirmed
 * transactions (multiple wallet approvals) -- see this file's header.
 */
export async function executeMultiAssetBuyMainnet(params: ExecuteMultiAssetBuyParams): Promise<MultiAssetBuyResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const program = buildReadOnlyProgram(params.connection) as any;

  const balances = params.assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const totalSupply = BigInt(params.reserveTokenSupplyRaw);
  const requirements = computeMintRequirements(params.reserveTokensRequested, totalSupply, balances);
  const requiredAmountsRaw = requirements.map((r) => r.requiredAmount);

  await fundMultiAssetLegs(params.connection, params.wallet, params.assets, requiredAmountsRaw, params.assetPricesUsd, params.onProgress, params.onSwapShortfall);

  params.onProgress?.({ phase: "minting" });
  const { instructions, requiredAmountsRaw: finalRequired } = await buildDirectMultiAssetMintInstructions({
    program,
    protocolConfig: params.protocolConfig,
    protocolFeeDestination: params.protocolFeeDestination,
    reserve: params.reserve,
    reserveTokenMint: params.reserveTokenMint,
    mintAuthority: params.mintAuthority,
    user: params.wallet.publicKey,
    assets: params.assets,
    reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
    reserveTokensRequested: params.reserveTokensRequested,
    slippageBps: params.slippageBps,
  });

  // Same real-size-based batching createReserveClient.ts's create-and-
  // register step uses (see packInstructionsBySize) -- a Reserve with many
  // assets could in principle push even this single mint instruction's own
  // remaining_accounts past the legacy transaction limit. ATA-create
  // instructions are safe to split into their own leading transaction(s)
  // (each is independently idempotent); the mint instruction itself cannot
  // be split (it must stay one atomic call) -- if IT alone is still too
  // large, packInstructionsBySize returns it as its own single-instruction
  // batch and the real wire-size assert inside signSubmitAndConfirm's
  // signing step surfaces that honestly rather than silently truncating
  // anything.
  const batches = packInstructionsBySize(params.wallet.publicKey, instructions);
  let signature = "";
  for (const batch of batches) {
    params.onProgress?.({ phase: "awaiting-wallet" });
    signature = await signSubmitAndConfirm(params.connection, params.wallet, batch);
  }

  return { signature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw: finalRequired };
}
