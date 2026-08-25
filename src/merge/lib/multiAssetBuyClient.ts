// USDC-denominated Buy for a Mainnet Reserve (every Reserve that isn't
// purely USDC routes through here since DEC-0151) -- deposits a proportional
// in-kind amount of EVERY registered Reserve asset at once, in a single
// mint_reserve_tokens_in_kind call, funding each leg's genuine shortfall
// from the buyer's USDC first (see multiAssetBuyPlan.ts's planBuyFunding,
// the pure planning brain this module executes).
//
// FUNDING INVARIANT (DEC-0151/DEC-0154): the buyer supplies ONLY USDC (plus
// SOL for network fees/rent). Every leg the wallet doesn't already
// sufficiently hold -- INCLUDING a wrapped-SOL leg -- is acquired by a real
// Jupiter swap from USDC (a wrapped-SOL leg's swap is built with
// receiveWrappedSol so the output stays SPL wrapped SOL). An earlier version
// funded a wrapped-SOL leg by silently wrapping the buyer's own native SOL:
// observed live 2026-08-25, a "$10 USDC" CHARLI purchase's first wallet
// transaction moved ~$5 of native SOL into wrapped SOL while the UI named
// USDC as the deposit asset. Already-held balances always count first --
// a retry only ever funds the genuine remaining deficit.
//
// SAFETY MODEL (DEC-0154, after the live 2026-08-25 failed CHARLI buy):
//  - Whole-purchase feasibility gate (assessBuyFeasibility) BEFORE any
//    transaction is constructed: real USDC balance vs. the full plan's
//    cost, real SOL balance vs. fees/rent -- shown as current-vs-required,
//    never discovered mid-flight as an on-chain InsufficientFunds.
//  - Per-leg persistent state (launchFunding.ts's PersistedAssetFunding
//    machine, stored under ssr_pending_buy_v1 keyed by wallet+reserve):
//    survives refresh/reconnect; a previously-submitted swap signature is
//    reconciled against real on-chain status before any new swap.
//  - Double-mint guard (shouldSubmitMint): before the final mint is ever
//    submitted, the buyer's REAL Reserve Token balance is re-read; if it
//    already grew by the expected output since this purchase began, a prior
//    attempt's mint landed and nothing is re-submitted.
//  - Honest failure state (buildBuyStateReport): on any failure, every
//    leg's REAL held balance and the REAL Reserve Token balance are re-read
//    and reported -- what succeeded, what failed, what is held and where,
//    whether the Reserve Token was minted, and exactly what retry will do.
//    Never claimed from client-side state alone.
//  - Never custodies funds: every transaction is signed by the buyer's own
//    wallet; acquired assets live in the buyer's own ATAs until the mint
//    deposits them.
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  buildDirectMultiAssetMintInstructions,
  fetchTokenBalanceRaw,
  computeMintRequirements,
  computeNetMintOutput,
  describeOnChainError,
  MAINNET_USDC_MINT,
  type ZapAssetLeg,
} from "@ssr/sdk";
import { fetchJupiterSwapQuote, executeJupiterSwap } from "./jupiterSwapClient";
import { packInstructionsBySize, fetchOwnedBalanceRawSettled } from "./createReserveClient";
import { computeSwapShortfallPct } from "./createReserveResume";
import { advanceAssetFunding, type AssetFundingStatus, type PersistedAssetFunding } from "./launchFunding";
import { planBuyFunding, assessBuyFeasibility, shouldSubmitMint, buildBuyStateReport, type BuyLegInput, type BuyStateReport } from "./multiAssetBuyPlan";
import { AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";
import { withRateLimitRetry } from "./rpcResilience";

/** Same threshold createReserveClient.ts's seed funding uses -- routine slippage below this is never reported as a shortfall worth warning about. */
const SHORTFALL_WARN_PCT = 0.05;

const log = (msg: string, extra?: Record<string, unknown>) => {
  // Deliberate, targeted diagnostics (DEC-0154): deposit asset, quotes,
  // signatures, per-leg state, balance reads, and retry decisions were all
  // invisible during the live failed-buy investigation.
  console.info(`[multi-asset-buy] ${msg}`, extra ?? "");
};

/** How many gross Reserve Tokens a USD amount targets, using the Reserve's real current NAV (already computed from live Pyth/Jupiter prices elsewhere on the page -- see DTRDetail.tsx's dtr.nav). Pure. */
export function usdToReserveTokensRequested(usdAmount: number, nav: number, reserveTokenDecimals: number): bigint {
  if (!(usdAmount > 0)) throw new Error("usdToReserveTokensRequested: usdAmount must be positive.");
  if (!(nav > 0)) throw new Error("usdToReserveTokensRequested: nav must be a real, positive, priced value.");
  return BigInt(Math.max(1, Math.floor((usdAmount / nav) * 10 ** reserveTokenDecimals)));
}

export type MultiAssetBuyProgressEvent =
  | { phase: "swapping"; mint: string; index: number; total: number }
  | { phase: "minting" }
  | { phase: "awaiting-wallet" };

export interface MultiAssetBuyResult {
  signature: string;
  reserveTokensRequested: bigint;
  requiredAmountsRaw: bigint[];
  /** True when the mint was found to have ALREADY landed from a prior attempt (double-mint guard) -- nothing was re-submitted. */
  alreadyMinted: boolean;
}

/** Thrown on any buy failure, carrying the on-chain-verified state report the UI must show -- see multiAssetBuyPlan.ts's buildBuyStateReport. */
export class MultiAssetBuyError extends Error {
  readonly report: BuyStateReport | null;
  constructor(message: string, report: BuyStateReport | null, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "MultiAssetBuyError";
    this.report = report;
  }
}

// --- Per-purchase persistence (survives refresh/reconnect) ------------------
const PENDING_BUY_KEY = "ssr_pending_buy_v1";

export interface PendingBuyState {
  wallet: string;
  reserve: string;
  startedAt: number;
  legFunding: Record<string, PersistedAssetFunding>;
  /** The buyer's Reserve Token ATA balance read BEFORE this purchase's first attempt -- the baseline shouldSubmitMint compares against. */
  preMintReserveTokenRaw: string;
  expectedNetReserveTokensRaw: string;
  lastMintSignature?: string;
}

export function readPendingBuy(wallet: string, reserve: string): PendingBuyState | null {
  try {
    const raw = localStorage.getItem(PENDING_BUY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBuyState;
    if (parsed.wallet !== wallet || parsed.reserve !== reserve) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePendingBuy(state: PendingBuyState): void {
  try {
    localStorage.setItem(PENDING_BUY_KEY, JSON.stringify(state));
  } catch {
    // Best-effort -- persistence never blocks the purchase itself.
  }
}

export function clearPendingBuy(wallet: string, reserve: string): void {
  try {
    const existing = readPendingBuy(wallet, reserve);
    if (existing) localStorage.removeItem(PENDING_BUY_KEY);
  } catch {
    // Best-effort.
  }
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
  /** The Reserve's effective total mint-fee bps -- sizes the expected net output the double-mint guard verifies against. */
  effectiveMintFeeTotalBps: bigint;
  /** Real, current USD price per asset mint (see onChainReserve.ts's assetPricesUsd) -- used ONLY to size each Jupiter swap's USDC budget; the acquired amount is always re-verified against the real post-swap balance. */
  assetPricesUsd: Record<string, number>;
  /** Fractional slippage buffer for the final mint's per-leg cap -- see buildDirectMultiAssetMintInstructions. */
  slippageBps?: number;
  onProgress?: (event: MultiAssetBuyProgressEvent) => void;
  onSwapShortfall?: (info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) => void;
}

/**
 * Full USDC-denominated buy. Sequential phases, each verified before the
 * next: feasibility gate -> per-leg funding (Jupiter swaps from USDC, one
 * per genuinely-deficient leg, freshly quoted immediately before each) ->
 * double-mint guard -> final in-kind mint -> post-mint delivery
 * verification (the buyer's real Reserve Token balance must show the mint).
 */
export async function executeMultiAssetBuyMainnet(params: ExecuteMultiAssetBuyParams): Promise<MultiAssetBuyResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = params.wallet.publicKey;
  const ownerBase58 = owner.toBase58();
  const reserveBase58 = params.reserve.toBase58();
  const program = buildReadOnlyProgram(params.connection) as any;

  log("buy start", {
    reserve: reserveBase58,
    depositAsset: "USDC (" + MAINNET_USDC_MINT + ")",
    reserveTokensRequested: params.reserveTokensRequested.toString(),
    legs: params.assets.map((a) => a.mint),
  });

  // Exact per-leg deposit requirements from live vault balances/supply --
  // the same integer math the on-chain program enforces.
  const balancesInVaults = params.assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const totalSupply = BigInt(params.reserveTokenSupplyRaw);
  const requirements = computeMintRequirements(params.reserveTokensRequested, totalSupply, balancesInVaults);
  const requiredAmountsRaw = requirements.map((r) => r.requiredAmount);
  const { netOut: expectedNetRaw } = computeNetMintOutput(params.reserveTokensRequested, params.effectiveMintFeeTotalBps);
  log("mint requirements (vault balances before)", {
    supply: totalSupply.toString(),
    perLeg: params.assets.map((a, i) => ({ mint: a.mint, vaultBefore: a.vaultBalanceRaw, requiredRaw: requiredAmountsRaw[i].toString() })),
    expectedNetReserveTokensRaw: expectedNetRaw.toString(),
  });

  // Fresh wallet balances for every leg + USDC + SOL -- the inputs to both
  // the funding plan and the feasibility gate.
  const readLegBalances = async () =>
    Promise.all(params.assets.map((a) => fetchTokenBalanceRaw(params.connection, new PublicKey(a.mint), owner).then(BigInt)));
  const heldRaw = await readLegBalances();
  const walletUsdcRaw = BigInt(await fetchTokenBalanceRaw(params.connection, new PublicKey(MAINNET_USDC_MINT), owner));
  const walletSolLamports = BigInt(await params.connection.getBalance(owner, "confirmed"));
  const rtBalanceNow = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));

  // Per-purchase persisted state: resume an interrupted purchase's baseline
  // (so the double-mint guard survives refresh), or start fresh.
  let pending = readPendingBuy(ownerBase58, reserveBase58);
  if (!pending) {
    pending = {
      wallet: ownerBase58,
      reserve: reserveBase58,
      startedAt: Date.now(),
      legFunding: {},
      preMintReserveTokenRaw: rtBalanceNow.toString(),
      expectedNetReserveTokensRaw: expectedNetRaw.toString(),
    };
    savePendingBuy(pending);
  } else {
    log("resuming a previously-started purchase", { startedAt: new Date(pending.startedAt).toISOString(), lastMintSignature: pending.lastMintSignature ?? null });
  }
  const advanceLeg = (mint: string, to: AssetFundingStatus, extra?: Partial<Pick<PersistedAssetFunding, "lastSignature" | "verifiedBalanceRaw" | "targetRaw">>) => {
    pending!.legFunding = advanceAssetFunding(pending!.legFunding, mint, to, extra);
    savePendingBuy(pending!);
  };

  // DOUBLE-MINT GUARD, part 1 (before doing anything else): if a previous
  // attempt's mint already landed -- however that attempt's confirmation
  // ended -- report success and stop. Verified from the buyer's REAL
  // Reserve Token balance, never client state.
  const preMintBaseline = BigInt(pending.preMintReserveTokenRaw);
  if (!shouldSubmitMint(preMintBaseline, rtBalanceNow, BigInt(pending.expectedNetReserveTokensRaw))) {
    log("mint already landed for this purchase (double-mint guard) -- not re-submitting", {
      preMintBaseline: preMintBaseline.toString(),
      rtBalanceNow: rtBalanceNow.toString(),
    });
    clearPendingBuy(ownerBase58, reserveBase58);
    return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
  }

  // Reconcile a previously-submitted mint signature whose confirmation was
  // never seen (refresh/RPC timeout) -- its real status decides.
  if (pending.lastMintSignature) {
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([pending!.lastMintSignature!], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    log("reconciling previously-submitted mint signature", { signature: pending.lastMintSignature, status: st?.confirmationStatus ?? "not-found", err: st?.err ?? null });
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, preMintBaseline);
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
    }
  }

  // The funding plan + whole-purchase feasibility gate -- BEFORE any
  // transaction is constructed or signature requested.
  const legInputs: BuyLegInput[] = params.assets.map((a, i) => ({
    mint: a.mint,
    decimals: a.decimals,
    requiredRaw: requiredAmountsRaw[i],
    heldRaw: heldRaw[i],
    priceUsd: params.assetPricesUsd[a.mint] ?? null,
  }));
  const plan = planBuyFunding(legInputs);
  log("funding plan", {
    walletUsdcRaw: walletUsdcRaw.toString(),
    walletSolLamports: walletSolLamports.toString(),
    actions: plan.actions.map((ac) => (ac.kind === "jupiter-swap" ? { swap: ac.mint, deficitRaw: ac.deficitRaw.toString(), usdcBudgetRaw: ac.usdcBudgetRaw.toString(), receiveWrappedSol: ac.receiveWrappedSol } : { alreadyHeld: ac.mint })),
  });
  const feasibility = assessBuyFeasibility({ plan, walletUsdcRaw, walletSolLamports });
  if (!feasibility.feasible) {
    throw new MultiAssetBuyError(`This purchase can't start yet: ${feasibility.reasons.join("; ")}. Nothing was submitted.`, null);
  }

  const buildFailureReport = async (): Promise<BuyStateReport> => {
    const freshHeld = await readLegBalances().catch(() => heldRaw);
    const freshRt = await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner).then(BigInt).catch(() => rtBalanceNow);
    return buildBuyStateReport(
      params.assets.map((a, i) => ({ mint: a.mint, symbol: a.mint.slice(0, 4) + "..." + a.mint.slice(-4), requiredRaw: requiredAmountsRaw[i], heldRaw: freshHeld[i] })),
      preMintBaseline,
      freshRt,
      BigInt(pending!.expectedNetReserveTokensRaw),
    );
  };

  try {
    // --- Per-leg funding: USDC -> Jupiter -> Reserve asset, one swap per
    // --- genuinely-deficient leg, freshly quoted immediately before each.
    const swapActions = plan.actions.filter((a) => a.kind === "jupiter-swap");
    for (let s = 0; s < swapActions.length; s++) {
      const action = swapActions[s];
      if (action.kind !== "jupiter-swap") continue;
      const legIndex = params.assets.findIndex((a) => a.mint === action.mint);

      // Reconcile a previously-submitted swap for this leg first -- never
      // blindly re-swap what may already have landed.
      const persisted = pending.legFunding[action.mint];
      if (persisted?.lastSignature && (persisted.status === "submitted" || persisted.status === "awaiting_signature")) {
        const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([persisted.lastSignature!], { searchTransactionHistory: true }), 3, 500);
        const st = value[0];
        log("reconciling previous swap signature", { mint: action.mint, signature: persisted.lastSignature, status: st?.confirmationStatus ?? "not-found", err: st?.err ?? null });
        if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          heldRaw[legIndex] = await fetchOwnedBalanceRawSettled(params.connection, new PublicKey(action.mint), owner, heldRaw[legIndex]);
          advanceLeg(action.mint, "confirmed");
          if (heldRaw[legIndex] >= requiredAmountsRaw[legIndex]) {
            advanceLeg(action.mint, "ready_to_seed", { verifiedBalanceRaw: heldRaw[legIndex].toString() });
            continue;
          }
        } else {
          advanceLeg(action.mint, "not_started");
        }
      }

      params.onProgress?.({ phase: "swapping", mint: action.mint, index: s, total: swapActions.length });
      advanceLeg(action.mint, "quoted", { targetRaw: requiredAmountsRaw[legIndex].toString() });
      const quote = await fetchJupiterSwapQuote(action.mint, action.usdcBudgetRaw, ownerBase58, undefined, action.receiveWrappedSol);
      log("swap quote", { mint: action.mint, inUsdcRaw: quote.inAmount.toString(), outRaw: quote.outAmount.toString(), receiveWrappedSol: action.receiveWrappedSol });
      advanceLeg(action.mint, "awaiting_signature");
      await executeJupiterSwap(params.connection, params.wallet, quote, (sig) => advanceLeg(action.mint, "submitted", { lastSignature: sig }));
      advanceLeg(action.mint, "confirmed");
      const newBalance = await fetchOwnedBalanceRawSettled(params.connection, new PublicKey(action.mint), owner, heldRaw[legIndex]);
      heldRaw[legIndex] = newBalance;
      advanceLeg(action.mint, "ready_to_seed", { verifiedBalanceRaw: newBalance.toString() });
      log("leg funded and balance-verified", { mint: action.mint, heldRaw: newBalance.toString(), requiredRaw: requiredAmountsRaw[legIndex].toString() });
      const shortfallPct = computeSwapShortfallPct(requiredAmountsRaw[legIndex], newBalance);
      if (shortfallPct > SHORTFALL_WARN_PCT) {
        params.onSwapShortfall?.({ mint: action.mint, targetRaw: requiredAmountsRaw[legIndex], actualRaw: newBalance, shortfallPct });
      }
    }

    // Every leg must now genuinely hold its requirement -- the mint is
    // never submitted against unverified funding.
    for (let i = 0; i < params.assets.length; i++) {
      if (heldRaw[i] < requiredAmountsRaw[i]) {
        throw new Error(
          `Reserve asset ${params.assets[i].mint} is still short after funding: held ${heldRaw[i].toString()} raw vs required ${requiredAmountsRaw[i].toString()} raw. Nothing further was submitted.`,
        );
      }
    }

    // DOUBLE-MINT GUARD, part 2 (immediately before submitting): re-read
    // the buyer's real Reserve Token balance one more time.
    const rtBeforeMint = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));
    if (!shouldSubmitMint(preMintBaseline, rtBeforeMint, BigInt(pending.expectedNetReserveTokensRaw))) {
      log("mint landed between funding and submission (double-mint guard) -- not re-submitting");
      clearPendingBuy(ownerBase58, reserveBase58);
      return { signature: pending.lastMintSignature ?? "", reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw, alreadyMinted: true };
    }

    params.onProgress?.({ phase: "minting" });
    const { instructions, requiredAmountsRaw: finalRequired } = await buildDirectMultiAssetMintInstructions({
      program,
      protocolConfig: params.protocolConfig,
      protocolFeeDestination: params.protocolFeeDestination,
      reserve: params.reserve,
      reserveTokenMint: params.reserveTokenMint,
      mintAuthority: params.mintAuthority,
      user: owner,
      assets: params.assets,
      reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
      reserveTokensRequested: params.reserveTokensRequested,
      slippageBps: params.slippageBps,
    });
    log("mint instruction built", {
      fixedAndRemainingKeys: instructions[instructions.length - 1].keys.length,
      perLegCapRaw: finalRequired.map((r) => r.toString()),
    });

    // Same real-size-based batching createReserveClient.ts uses -- ATA
    // creations may split into their own leading transaction(s); the mint
    // instruction itself stays one atomic call.
    const batches = packInstructionsBySize(owner, instructions);
    let signature = "";
    for (const batch of batches) {
      params.onProgress?.({ phase: "awaiting-wallet" });
      const isMintBatch = batch.includes(instructions[instructions.length - 1]);
      signature = await signSubmitAndConfirmWithPersistedSig(params.connection, params.wallet, batch, isMintBatch ? (sig) => { pending!.lastMintSignature = sig; savePendingBuy(pending!); } : undefined);
    }

    // DELIVERY VERIFICATION: success is only ever reported after the
    // buyer's REAL Reserve Token balance shows the minted output.
    const rtAfter = await fetchOwnedBalanceRawSettled(params.connection, params.reserveTokenMint, owner, rtBeforeMint);
    const supplyAfter = await program.provider.connection
      .getTokenSupply(params.reserveTokenMint)
      .then((r: { value: { amount: string } }) => r.value.amount)
      .catch(() => "unavailable");
    log("post-mint verification", {
      buyerReserveTokenBefore: rtBeforeMint.toString(),
      buyerReserveTokenAfter: rtAfter.toString(),
      reserveTokenSupplyAfter: supplyAfter,
    });
    if (rtAfter <= rtBeforeMint) {
      throw new Error(
        `The mint transaction confirmed but your Reserve Token balance has not increased yet (before ${rtBeforeMint.toString()}, now ${rtAfter.toString()} raw). Signature: ${signature}. Check the signature on Explorer before retrying.`,
      );
    }
    clearPendingBuy(ownerBase58, reserveBase58);
    return { signature, reserveTokensRequested: params.reserveTokensRequested, requiredAmountsRaw: finalRequired, alreadyMinted: false };
  } catch (e) {
    if (e instanceof AmbiguousConfirmationError) throw e; // DTRDetail's reconcileBuy path owns this case.
    const report = await buildFailureReport().catch(() => null);
    log("buy failed -- verified state report", { error: e instanceof Error ? e.message : String(e), report });
    throw new MultiAssetBuyError(e instanceof Error ? e.message : String(e), report, e);
  }
}

/** signSubmitAndConfirm variant that reports the signature the moment it exists (before confirmation) so the mint signature is persisted for reconciliation across refreshes. */
async function signSubmitAndConfirmWithPersistedSig(
  connection: Connection,
  wallet: WalletContextState,
  ixs: TransactionInstruction[],
  onSubmitted?: (signature: string) => void,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  onSubmitted?.(signature);
  log("transaction submitted", { signature });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature, "Mainnet");
}
