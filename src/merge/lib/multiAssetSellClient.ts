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
// FALLBACK (SingleTxTooLargeError only -- many-asset Reserves): the redeem
// plus every leg's USDC swap are signed together in ONE wallet approval
// (signAllTransactions, mirroring multiAssetBuyClient's batch), the redeem
// is submitted and confirmed first, then every swap is broadcast in
// parallel; a swap that definitively does not land is automatically
// re-quoted and re-signed once. The whole flow is guarded by a persisted
// per-sale state machine (ssr_pending_sells_v1, wallet+reserve-keyed map):
// the redeem signature and every leg's swap signature are recorded when
// submitted and reconciled against real on-chain status before anything is
// ever re-submitted -- a confirmed redeem is never repeated (never burns
// Reserve Tokens twice), a confirmed swap is never repeated, and the sale
// resumes exactly where it stopped across refresh/reconnect. A wallet
// without signAllTransactions takes the same flow one signature at a time.
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
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
import {
  fetchJupiterSwapInstructions,
  fetchJupiterSwapQuote,
  executeJupiterSwap,
  submitSignedJupiterSwap,
  partitionSwapOutcomes,
  JupiterSwapNotLandedError,
  SWAP_AUTO_RETRY_LIMIT,
  type JupiterSwapQuote,
} from "./jupiterSwapClient";
import { fetchOwnedBalanceRawSettled } from "./createReserveClient";
import {
  compileSingleBuyTransaction,
  deserializeJupiterInstruction,
  fetchLookupTables,
  isComputeBudgetInstruction,
  SingleTxTooLargeError,
  SINGLE_TX_COMPUTE_UNIT_LIMIT,
  SINGLE_TX_MICRO_LAMPORTS_PER_CU,
  SINGLE_TX_SWAP_MAX_ACCOUNTS,
  type SwapInstructionSet,
} from "./singleTxBuy";
import { ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import { AmbiguousConfirmationError, confirmSignatureBounded, withRateLimitRetry } from "./rpcResilience";
import { fetchReserveAltAddress } from "./reserveAltClient";

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
      // Account-budgeted quote first (DEC-0161; a live uncapped SSR->USDC
      // route used 68 accounts and overran the wire limit, forcing the
      // 3-signature fallback); uncapped retry if no route fits the budget.
      const set = await fetchJupiterSwapInstructions(MAINNET_USDC_MINT, entitlementRaw, ownerBase58, undefined, leg.mint, SINGLE_TX_SWAP_MAX_ACCOUNTS).catch(
        () => fetchJupiterSwapInstructions(MAINNET_USDC_MINT, entitlementRaw, ownerBase58, undefined, leg.mint),
      );
      log("single-tx sell-swap instructions fetched", { mint: leg.mint, inRaw: entitlementRaw.toString(), quotedUsdcOutRaw: set.outAmount.toString(), swapAccounts: set.swapInstruction.accounts.length });
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
    // The Reserve's registered trading lookup table (DEC-0161, when one
    // exists) compresses the protocol's fixed accounts -- often the
    // difference between one approval and the sequential fallback.
    const reserveAlt = await fetchReserveAltAddress(reserveBase58);
    const lookupTables = await fetchLookupTables(params.connection, [...(reserveAlt ? [reserveAlt] : []), ...lookupAddresses]);
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
  // Submits an already-signed redeem and confirms it; the signature is
  // persisted the instant it exists so a refresh mid-confirmation reconciles
  // it instead of burning twice.
  const submitSignedRedeem = async (signed: Transaction, lastValidBlockHeight: number): Promise<void> => {
    const signature = await params.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
    pending!.redeemSignature = signature;
    savePendingSell(pending!);
    log("redeem submitted", { signature });
    const outcome = await confirmSignatureBounded(params.connection, signature, lastValidBlockHeight);
    if (outcome.status === "failed") throw new Error(`${describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))} Signature: ${signature}.`);
    if (outcome.status === "expired") throw new Error(`The redeem expired before it could be confirmed -- nothing should have moved. Signature: ${signature}.`);
    if (outcome.status !== "confirmed") throw new AmbiguousConfirmationError(signature, "Mainnet");
    pending!.redeemConfirmed = true;
    savePendingSell(pending!);
  };
  const buildRedeemTx = async (): Promise<{ tx: Transaction; lastValidBlockHeight: number }> => {
    const tx = new Transaction().add(...redeemPrelude);
    tx.feePayer = owner;
    const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    return { tx, lastValidBlockHeight };
  };

  // Step 2 prep: decide which legs still need selling -- reconciling any
  // previously-submitted swap signature FIRST -- before anything is signed.
  // When the redeem has not landed yet, the amount to sell is the exact
  // entitlement the redeem will deliver (buildRedeem's floor-rounded figure);
  // on a resume after a landed redeem it is what the wallet still holds,
  // never more than that entitlement.
  type SellLeg = { leg: ZapAssetLeg; entitlementRaw: bigint; amountIn: bigint };
  const legsToSell: SellLeg[] = [];
  for (const { leg, entitlementRaw } of nonUsdcLegs) {
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
    let amountIn = entitlementRaw;
    if (redeemDone) {
      const held = BigInt(await fetchTokenBalanceRaw(params.connection, new PublicKey(leg.mint), owner));
      amountIn = held < entitlementRaw ? held : entitlementRaw;
      if (amountIn <= 0n) {
        log("leg has nothing left to swap (already sold or moved) -- skipping", { mint: leg.mint });
        pending.legSwaps[leg.mint] = { confirmed: true };
        savePendingSell(pending);
        continue;
      }
    }
    legsToSell.push({ leg, entitlementRaw, amountIn });
  }

  type QuotedSellLeg = SellLeg & { quote: JupiterSwapQuote; tx: VersionedTransaction };
  const quoteSellLeg = async (l: SellLeg): Promise<QuotedSellLeg> => {
    const quote = await fetchJupiterSwapQuote(MAINNET_USDC_MINT, l.amountIn, ownerBase58, undefined, undefined, l.leg.mint);
    log("sell-swap quote", { mint: l.leg.mint, inRaw: l.amountIn.toString(), quotedUsdcOutRaw: quote.outAmount.toString() });
    return { ...l, quote, tx: VersionedTransaction.deserialize(Buffer.from(quote.swapTransaction, "base64")) };
  };
  let lastSignature = pending.redeemSignature ?? "";
  const recordSwapSubmitted = (mint: string) => (sig: string) => {
    pending!.legSwaps[mint] = { signature: sig };
    savePendingSell(pending!);
  };
  const recordSwapConfirmed = (l: SellLeg, sig: string) => {
    pending!.legSwaps[l.leg.mint] = { signature: sig, confirmed: true };
    savePendingSell(pending!);
    lastSignature = sig;
    log("leg sold into USDC", { mint: l.leg.mint, inRaw: l.amountIn.toString(), signature: sig });
  };

  // ---------------------------------------------------------------------
  // ONE-APPROVAL FALLBACK: [redeem, swap leg 1..N] signed together in a single
  // wallet prompt (the live complaint: "redeem still asks for 1 signature per
  // reserve asset"). Submission ORDER is still strict -- the redeem first,
  // confirmed, THEN the swaps (their inputs are the redeem's outputs); a
  // redeem that fails simply discards the signed swaps, which are never
  // broadcast. The swaps then go out in parallel, and any that definitively
  // does not land (JupiterSwapNotLandedError: executed-and-failed, or expired
  // unincluded while the redeem was confirming) is re-quoted and re-signed
  // once automatically.
  // ---------------------------------------------------------------------
  const canBatch = typeof params.wallet.signAllTransactions === "function";
  if (canBatch && (!redeemDone || legsToSell.length > 0)) {
    const redeem = redeemDone ? null : await buildRedeemTx();
    let batch = await Promise.all(legsToSell.map(quoteSellLeg));
    params.onProgress?.({ phase: "awaiting-wallet" });
    const toSign: (Transaction | VersionedTransaction)[] = [...(redeem ? [redeem.tx] : []), ...batch.map((q) => q.tx)];
    log("one-approval sell batch", { redeem: redeem !== null, swaps: batch.length, mints: batch.map((q) => q.leg.mint) });
    const signedAll = await params.wallet.signAllTransactions!(toSign);
    let signedSwaps = signedAll.slice(redeem ? 1 : 0) as VersionedTransaction[];
    if (redeem) {
      params.onProgress?.({ phase: "redeeming" });
      await submitSignedRedeem(signedAll[0] as Transaction, redeem.lastValidBlockHeight);
    }

    const submitSwaps = (legs: QuotedSellLeg[], signed: VersionedTransaction[]) =>
      Promise.allSettled(
        legs.map(async (q, s) => {
          params.onProgress?.({ phase: "swapping", mint: q.leg.mint, index: s, total: legs.length });
          const sig = await submitSignedJupiterSwap(params.connection, signed[s], q.quote.lastValidBlockHeight, recordSwapSubmitted(q.leg.mint));
          recordSwapConfirmed(q, sig);
        }),
      );
    let outcomes = await submitSwaps(batch, signedSwaps);
    for (let attempt = 0; attempt < SWAP_AUTO_RETRY_LIMIT; attempt++) {
      const { retryable, fatal } = partitionSwapOutcomes(batch, outcomes);
      if (fatal !== null) throw fatal;
      if (retryable.length === 0) break;
      log("sell-swap leg(s) did not land -- automatically re-quoting and re-signing once", {
        attempt: attempt + 1,
        mints: retryable.map((q) => q.leg.mint),
        reasons: outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected").map((o) => String((o.reason as Error)?.message ?? o.reason)),
      });
      batch = await Promise.all(retryable.map((q) => quoteSellLeg({ leg: q.leg, entitlementRaw: q.entitlementRaw, amountIn: q.amountIn })));
      params.onProgress?.({ phase: "awaiting-wallet" });
      signedSwaps = await params.wallet.signAllTransactions!(batch.map((q) => q.tx));
      outcomes = await submitSwaps(batch, signedSwaps);
    }
    {
      const { retryable, fatal } = partitionSwapOutcomes(batch, outcomes);
      if (fatal !== null) throw fatal;
      if (retryable.length > 0) {
        const first = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected")!.reason as Error;
        throw new Error(`${first.message} (This swap was already automatically retried once with a fresh quote and did not land either.)`);
      }
    }
    return await verifyDelivery(lastSignature);
  }

  // ---------------------------------------------------------------------
  // SEQUENTIAL (wallet without signAllTransactions): the same steps, one
  // signature each -- redeem once, then each leg with the same retry-once.
  // ---------------------------------------------------------------------
  if (!redeemDone) {
    params.onProgress?.({ phase: "redeeming" });
    params.onProgress?.({ phase: "awaiting-wallet" });
    if (!params.wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
    const { tx, lastValidBlockHeight } = await buildRedeemTx();
    await submitSignedRedeem(await params.wallet.signTransaction(tx), lastValidBlockHeight);
  }
  for (let s = 0; s < legsToSell.length; s++) {
    const l = legsToSell[s];
    params.onProgress?.({ phase: "swapping", mint: l.leg.mint, index: s, total: legsToSell.length });
    for (let attempt = 0; ; attempt++) {
      const quote = await fetchJupiterSwapQuote(MAINNET_USDC_MINT, l.amountIn, ownerBase58, undefined, undefined, l.leg.mint);
      params.onProgress?.({ phase: "awaiting-wallet" });
      try {
        const sig = await executeJupiterSwap(params.connection, params.wallet, quote, recordSwapSubmitted(l.leg.mint));
        recordSwapConfirmed(l, sig);
        break;
      } catch (e) {
        if (e instanceof JupiterSwapNotLandedError && attempt < SWAP_AUTO_RETRY_LIMIT) {
          log("sell-swap did not land -- automatically re-quoting and re-signing once", { mint: l.leg.mint, kind: e.kind, signature: e.signature });
          continue;
        }
        if (e instanceof JupiterSwapNotLandedError) throw new Error(`${e.message} (This swap was already automatically retried once with a fresh quote and did not land either.)`);
        throw e;
      }
    }
  }

  return await verifyDelivery(lastSignature);
}
