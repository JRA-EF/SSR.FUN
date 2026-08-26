// USDC-settled Sell for a Mainnet Reserve that is not purely USDC
// (DEC-0158) -- the exact inverse of multiAssetBuyClient.ts, completing the
// funding invariant's sell side: Reserve Tokens out -> USDC in. One
// redeem_reserve_tokens_in_kind pays the redeemer's proportional
// entitlement of every leg into their own ATAs, and every non-USDC leg is
// then sold INTO USDC via Jupiter (the server builds every swap with
// wrapAndUnwrapSol:false -- nothing ever unwraps or closes the seller's
// wSOL ATA mid-flow; see DEC-0156's live root cause).
//
// NORMAL PATH: everything composes into ONE wallet-signed atomic v0
// transaction -- X Reserve Tokens out -> Y USDC in, a single approval,
// read-only-simulated before the wallet is ever asked. All-or-nothing: on
// failure only the network fee is spent.
//
// FALLBACK (SingleTxTooLargeError only -- many-asset Reserves): a
// sequential flow guarded by a persisted per-sale state machine
// (ssr_pending_sells_v1, wallet+reserve-keyed map): the redeem signature
// and every leg's swap signature are recorded when submitted and reconciled
// against real on-chain status before anything is ever re-submitted -- a
// confirmed redeem is never repeated (never burns Reserve Tokens twice), a
// confirmed swap is never repeated, and the sale resumes exactly where it
// stopped across refresh/reconnect.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  buildDirectMultiAssetRedeemInstructions,
  fetchTokenBalanceRaw,
  describeOnChainError,
  MAINNET_USDC_MINT,
  type ZapAssetLeg,
} from "@ssr/sdk";
import { fetchJupiterSwapInstructions, fetchJupiterSwapQuote, executeJupiterSwap } from "./jupiterSwapClient";
import { fetchOwnedBalanceRawSettled } from "./createReserveClient";
import {
  compileSingleBuyTransaction,
  deserializeJupiterInstruction,
  fetchLookupTables,
  isComputeBudgetInstruction,
  SingleTxTooLargeError,
  SINGLE_TX_COMPUTE_UNIT_LIMIT,
  SINGLE_TX_MICRO_LAMPORTS_PER_CU,
  type SwapInstructionSet,
} from "./singleTxBuy";
import { ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import { AmbiguousConfirmationError, confirmSignatureBounded, withRateLimitRetry } from "./rpcResilience";

const log = (msg: string, extra?: Record<string, unknown>) => {
  console.info(`[multi-asset-sell] ${msg}`, extra ?? "");
};

export type MultiAssetSellProgressEvent =
  | { phase: "single-transaction" }
  | { phase: "redeeming" }
  | { phase: "swapping"; mint: string; index: number; total: number }
  | { phase: "awaiting-wallet" };

export interface MultiAssetSellResult {
  signature: string;
  reserveTokensRedeemed: bigint;
  /** Real, measured USDC (raw) the seller's balance gained across the sale. */
  usdcReceivedRaw: bigint;
}

// --- Per-sale persistence (fallback path only; the single-tx path is atomic) --
const PENDING_SELL_KEY = "ssr_pending_sells_v1";

export interface PendingSellState {
  wallet: string;
  reserve: string;
  startedAt: number;
  reserveTokensToRedeem: string;
  /** The seller's Reserve Token balance BEFORE the redeem -- the double-redeem guard's baseline. */
  preRedeemRtRaw: string;
  /** The seller's USDC balance when the sale began -- the final received figure is measured against this. */
  preSaleUsdcRaw: string;
  redeemSignature?: string;
  redeemConfirmed?: boolean;
  /** Per-leg swap progress: mint -> last submitted signature + whether it confirmed. */
  legSwaps: Record<string, { signature?: string; confirmed?: boolean }>;
}

function readPendingSellMap(): Record<string, PendingSellState> {
  try {
    const raw = localStorage.getItem(PENDING_SELL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PendingSellState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readPendingSell(wallet: string, reserve: string): PendingSellState | null {
  const entry = readPendingSellMap()[`${wallet}:${reserve}`];
  if (!entry || entry.wallet !== wallet || entry.reserve !== reserve) return null;
  return entry;
}

export function savePendingSell(state: PendingSellState): void {
  try {
    const map = readPendingSellMap();
    map[`${state.wallet}:${state.reserve}`] = state;
    localStorage.setItem(PENDING_SELL_KEY, JSON.stringify(map));
  } catch {
    // Best-effort -- persistence never blocks the sale itself.
  }
}

export function clearPendingSell(wallet: string, reserve: string): void {
  try {
    const map = readPendingSellMap();
    if (map[`${wallet}:${reserve}`]) {
      delete map[`${wallet}:${reserve}`];
      localStorage.setItem(PENDING_SELL_KEY, JSON.stringify(map));
    }
  } catch {
    // Best-effort.
  }
}

export interface ExecuteMultiAssetSellParams {
  connection: Connection;
  wallet: WalletContextState;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
  onProgress?: (event: MultiAssetSellProgressEvent) => void;
}

/**
 * Full USDC-settled sell: redeem the in-kind basket, then convert every
 * non-USDC leg's entitlement into USDC -- atomically in one transaction
 * where it fits, else sequentially with persisted-signature reconciliation.
 * Success is only ever reported after the seller's REAL USDC balance is
 * re-read; the result carries the measured gain, never an estimate.
 */
export async function executeMultiAssetSellMainnet(params: ExecuteMultiAssetSellParams): Promise<MultiAssetSellResult> {
  if (!params.wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = params.wallet.publicKey;
  const ownerBase58 = owner.toBase58();
  const reserveBase58 = params.reserve.toBase58();
  const program = buildReadOnlyProgram(params.connection) as any;
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);

  log("sell start", {
    reserve: reserveBase58,
    reserveTokensToRedeem: params.reserveTokensToRedeem.toString(),
    legs: params.assets.map((a) => a.mint),
  });

  // ONE redeem builder for every composition (DEC-0160: the builder accepts
  // any leg count >= 1, so a single-asset Reserve like ALPHA takes exactly
  // the same path as CHARLI/BETA).
  const buildRedeem = async () =>
    buildDirectMultiAssetRedeemInstructions({
      program,
      reserve: params.reserve,
      reserveTokenMint: params.reserveTokenMint,
      vaultAuthority: params.vaultAuthority,
      user: owner,
      assets: params.assets,
      reserveTokenSupplyRaw: params.reserveTokenSupplyRaw,
      redemptionFeeBps: params.redemptionFeeBps,
      reserveTokensToRedeem: params.reserveTokensToRedeem,
    });

  const preSaleUsdcRaw = BigInt(await fetchTokenBalanceRaw(params.connection, usdcMint, owner));
  const preRedeemRtRaw = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));
  if (preRedeemRtRaw < params.reserveTokensToRedeem) {
    throw new Error(
      `This wallet holds ${preRedeemRtRaw.toString()} raw Reserve Tokens but the sale needs ${params.reserveTokensToRedeem.toString()} raw. Nothing was submitted.`,
    );
  }

  const { instructions: redeemPrelude, entitlementsRaw } = await buildRedeem();
  const redeemIx = redeemPrelude[redeemPrelude.length - 1];
  const nonUsdcLegs = params.assets
    .map((a, i) => ({ leg: a, entitlementRaw: entitlementsRaw[i] }))
    .filter(({ leg, entitlementRaw }) => leg.mint !== MAINNET_USDC_MINT && entitlementRaw > 0n);

  const verifyDelivery = async (signature: string): Promise<MultiAssetSellResult> => {
    const usdcAfter = await fetchOwnedBalanceRawSettled(params.connection, usdcMint, owner, preSaleUsdcRaw);
    const gained = usdcAfter > preSaleUsdcRaw ? usdcAfter - preSaleUsdcRaw : 0n;
    log("post-sale verification", { usdcBefore: preSaleUsdcRaw.toString(), usdcAfter: usdcAfter.toString(), gainedRaw: gained.toString() });
    if (gained <= 0n) {
      throw new Error(
        `The sale confirmed but your USDC balance has not increased yet (still ${usdcAfter.toString()} raw). Signature: ${signature}. Check the signature on Explorer before retrying.`,
      );
    }
    clearPendingSell(ownerBase58, reserveBase58);
    return { signature, reserveTokensRedeemed: params.reserveTokensToRedeem, usdcReceivedRaw: gained };
  };

  // ---------------------------------------------------------------------
  // SINGLE-TRANSACTION PATH: [compute budget, ATA creates (incl. USDC),
  // redeem, each leg -> USDC swap] -- one approval, atomic.
  // ---------------------------------------------------------------------
  try {
    params.onProgress?.({ phase: "single-transaction" });
    const swapSets: SwapInstructionSet[] = [];
    const lookupAddresses: string[] = [];
    for (const { leg, entitlementRaw } of nonUsdcLegs) {
      const set = await fetchJupiterSwapInstructions(MAINNET_USDC_MINT, entitlementRaw, ownerBase58, undefined, leg.mint);
      log("single-tx sell-swap instructions fetched", { mint: leg.mint, inRaw: entitlementRaw.toString(), quotedUsdcOutRaw: set.outAmount.toString() });
      swapSets.push({ setupInstructions: set.setupInstructions, swapInstruction: set.swapInstruction, addressLookupTableAddresses: set.addressLookupTableAddresses });
      lookupAddresses.push(...set.addressLookupTableAddresses);
    }
    // Order: ONE compute budget pair -> ATA creations (each leg's + the
    // seller's USDC ATA) -> the redeem FIRST (its outputs feed the swaps)
    // -> each leg's setup + swap (their own compute-budget instructions
    // dropped; cleanup never composed -- it would close the wSOL ATA).
    const usdcAtaCreate = createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(usdcMint, owner), owner, usdcMint);
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: SINGLE_TX_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
      ...redeemPrelude.slice(0, -1),
      usdcAtaCreate,
      redeemIx,
    ];
    for (const set of swapSets) {
      for (const setup of set.setupInstructions) {
        const ix = deserializeJupiterInstruction(setup);
        if (!isComputeBudgetInstruction(ix)) ixs.push(ix);
      }
      const swapIx = deserializeJupiterInstruction(set.swapInstruction);
      if (!isComputeBudgetInstruction(swapIx)) ixs.push(swapIx);
    }
    const lookupTables = await fetchLookupTables(params.connection, lookupAddresses);
    const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash("confirmed");
    const tx = compileSingleBuyTransaction({ payer: owner, recentBlockhash: blockhash, instructions: ixs, lookupTables });
    log("single-tx sell composed", { instructions: ixs.length, bytes: tx.serialize().length, lookupTables: lookupTables.length });

    // Read-only simulation BEFORE the wallet signature (same rationale and
    // caveats as the buy path -- see multiAssetBuyClient.ts).
    try {
      const sim = await params.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      if (sim.value.err) {
        log("single-tx sell simulation failed -- refusing before any signature", { err: sim.value.err, logs: sim.value.logs ?? [] });
        throw new Error(
          `${describeOnChainError(new Error(`Transaction failed on-chain (${JSON.stringify(sim.value.err)}).`))} This was caught by a read-only simulation BEFORE anything was signed or submitted -- nothing moved and no fee was paid.`,
        );
      }
    } catch (simError) {
      if (simError instanceof Error && simError.message.includes("read-only simulation")) throw simError;
      log("single-tx sell simulation call itself failed -- proceeding (real confirmation remains the source of truth)", { error: String(simError) });
    }

    params.onProgress?.({ phase: "awaiting-wallet" });
    if (!params.wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
    const signed = await params.wallet.signTransaction(tx);
    const signature = await params.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
    log("single-tx sell submitted", { signature });
    const outcome = await confirmSignatureBounded(params.connection, signature, lastValidBlockHeight);
    if (outcome.status === "failed") {
      throw new Error(
        `${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} The sale was ONE atomic transaction, so nothing was redeemed or swapped -- only the network fee was spent. Signature: ${signature}.`,
      );
    }
    if (outcome.status === "expired") {
      throw new Error(`The sale transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
    }
    if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
    return await verifyDelivery(signature);
  } catch (e) {
    if (!(e instanceof SingleTxTooLargeError)) throw e;
    log("single-tx sell too large for this Reserve -- falling back to the sequential flow", { message: e.message });
  }

  // ---------------------------------------------------------------------
  // SEQUENTIAL FALLBACK: redeem once (double-redeem-guarded), then swap
  // each leg -- every signature persisted and reconciled before any
  // resubmission.
  // ---------------------------------------------------------------------
  let pending = readPendingSell(ownerBase58, reserveBase58);
  if (!pending) {
    pending = {
      wallet: ownerBase58,
      reserve: reserveBase58,
      startedAt: Date.now(),
      reserveTokensToRedeem: params.reserveTokensToRedeem.toString(),
      preRedeemRtRaw: preRedeemRtRaw.toString(),
      preSaleUsdcRaw: preSaleUsdcRaw.toString(),
      legSwaps: {},
    };
    savePendingSell(pending);
  } else {
    log("resuming a previously-started sale", { startedAt: new Date(pending.startedAt).toISOString(), redeemSignature: pending.redeemSignature ?? null });
  }

  const reconcileSignature = async (signature: string): Promise<"confirmed" | "failed" | "unknown"> => {
    const { value } = await withRateLimitRetry(() => params.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 3, 500);
    const st = value[0];
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed";
    if (st?.err) return "failed";
    return "unknown";
  };

  // Step 1: the redeem -- exactly once.
  let redeemDone = pending.redeemConfirmed === true;
  if (!redeemDone && pending.redeemSignature) {
    const status = await reconcileSignature(pending.redeemSignature);
    log("reconciling previous redeem signature", { signature: pending.redeemSignature, status });
    if (status === "confirmed") redeemDone = true;
    else if (status === "unknown") {
      throw new Error(
        `A previous redeem for this sale could not be verified yet (signature ${pending.redeemSignature}). Nothing was submitted -- try again in a moment; a landed redeem will be counted, never repeated.`,
      );
    }
  }
  if (!redeemDone) {
    // Belt-and-braces: if the Reserve Token balance already dropped by the
    // sale amount since the sale began, the redeem landed even without a
    // usable signature record.
    const rtNow = BigInt(await fetchTokenBalanceRaw(params.connection, params.reserveTokenMint, owner));
    if (BigInt(pending.preRedeemRtRaw) - rtNow >= params.reserveTokensToRedeem) {
      log("redeem already landed for this sale (balance guard) -- not re-submitting");
      redeemDone = true;
    }
  }
  if (!redeemDone) {
    params.onProgress?.({ phase: "redeeming" });
    params.onProgress?.({ phase: "awaiting-wallet" });
    const tx = new Transaction().add(...redeemPrelude);
    tx.feePayer = owner;
    const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    if (!params.wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
    const signed = await params.wallet.signTransaction(tx);
    const signature = await params.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
    pending.redeemSignature = signature;
    savePendingSell(pending);
    log("redeem submitted", { signature });
    const outcome = await confirmSignatureBounded(params.connection, signature, lastValidBlockHeight);
    if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
    if (outcome.status === "expired") throw new Error(`The redeem expired before it could be confirmed -- nothing should have moved. Signature: ${signature}.`);
    if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
  }
  pending.redeemConfirmed = true;
  savePendingSell(pending);

  // Step 2: swap each non-USDC leg's redeemed amount into USDC.
  let lastSignature = pending.redeemSignature ?? "";
  for (let s = 0; s < nonUsdcLegs.length; s++) {
    const { leg, entitlementRaw } = nonUsdcLegs[s];
    const persisted = pending.legSwaps[leg.mint];
    if (persisted?.confirmed) continue;
    if (persisted?.signature) {
      const status = await reconcileSignature(persisted.signature);
      log("reconciling previous sell-swap signature", { mint: leg.mint, signature: persisted.signature, status });
      if (status === "confirmed") {
        pending.legSwaps[leg.mint] = { ...persisted, confirmed: true };
        savePendingSell(pending);
        continue;
      }
      if (status === "unknown") {
        throw new Error(
          `A previous swap for this sale could not be verified yet (signature ${persisted.signature}). Nothing was submitted -- try again in a moment; a landed swap will be counted, never repeated.`,
        );
      }
    }
    params.onProgress?.({ phase: "swapping", mint: leg.mint, index: s, total: nonUsdcLegs.length });
    // Swap what the redeem actually delivered and the wallet still holds --
    // never more than the recorded entitlement.
    const held = BigInt(await fetchTokenBalanceRaw(params.connection, new PublicKey(leg.mint), owner));
    const amountIn = held < entitlementRaw ? held : entitlementRaw;
    if (amountIn <= 0n) {
      log("leg has nothing left to swap (already sold or moved) -- skipping", { mint: leg.mint });
      pending.legSwaps[leg.mint] = { confirmed: true };
      savePendingSell(pending);
      continue;
    }
    const quote = await fetchJupiterSwapQuote(MAINNET_USDC_MINT, amountIn, ownerBase58, undefined, undefined, leg.mint);
    params.onProgress?.({ phase: "awaiting-wallet" });
    lastSignature = await executeJupiterSwap(params.connection, params.wallet, quote, (sig) => {
      pending!.legSwaps[leg.mint] = { signature: sig };
      savePendingSell(pending!);
    });
    pending.legSwaps[leg.mint] = { signature: lastSignature, confirmed: true };
    savePendingSell(pending);
    log("leg sold into USDC", { mint: leg.mint, inRaw: amountIn.toString(), signature: lastSignature });
  }

  return await verifyDelivery(lastSignature);
}
