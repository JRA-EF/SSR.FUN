// SERVER-BUILT multi-asset Sell (the USDC-settled sell, DEC-0158): ONE
// request builds every unsigned transaction a Reserve Token -> USDC sale
// needs -- the in-kind redeem plus one asset -> USDC Jupiter swap per
// non-USDC leg -- and the browser signs them all in ONE wallet prompt.
// Mirrors buildBuy.ts exactly (parallel reads, parallel quotes/builds, the
// single-transaction attempt only when it can plausibly fit, the shared
// blockhash, server-decided lookup-table creation, server signs nothing).
//
// Modes:
//   "single" -- ONE atomic v0 transaction [compute budget, ATA creates (incl.
//               the seller's USDC ATA), redeem, each leg's setup+swap]
//               compiled against the Reserve table + Jupiter's route tables.
//   "batch"  -- [redeem v0 tx (compute budget + priority fee, ATA creates,
//               redeem)] then one Jupiter swap tx per non-USDC leg (re-stamped
//               with the shared blockhash). When the redeem has NOT landed yet
//               each swap sells EXACTLY the leg's entitlement (what the redeem
//               will deliver); on a resume after a landed redeem
//               (`redeemDone`) it sells min(held, entitlement).
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildDirectMultiAssetRedeemInstructions, describeOnChainError } from "@ssr/sdk";
import { deserializeJupiterInstruction, fetchLookupTables, isComputeBudgetInstruction, SINGLE_TX_COMPUTE_UNIT_LIMIT, SINGLE_TX_MICRO_LAMPORTS_PER_CU, SINGLE_TX_SWAP_MAX_ACCOUNTS } from "../../src/merge/lib/singleTxBuy";
import { MAINNET_USDC_MINT, isPriceImpactAcceptable, type JupiterCallResult, type JupiterQuote, type JupiterSwapInstructionsPayload, type JupiterSwapTransactionPayload } from "./jupiter";
import { ZERO_TRADE_TAX, buildTradeTaxInstructions, computeTradeTax, tradeTaxBps, tradeTaxPlan, type ReserveTradeTaxRates, type TradeTaxPlan } from "./tradeTax";
import {
  BuildError,
  CORE_TX_COMPUTE_UNIT_LIMIT,
  MAINNET_TREASURY_VAULT,
  SINGLE_TX_MAX_SWAP_LEGS,
  altTransactions,
  compileV0,
  decideMode,
  fitsV0,
  jupiterFailure,
  planAlt,
  readReserveAndWallet,
  toBase64,
  type BuiltTransaction,
  type ReadDeps,
} from "./buildCommon";

export interface BuildSellPlanLeg {
  mint: string;
  legIndex: number;
  decimals: number;
  /** Floor-rounded amount the redeem pays this leg (computeRedemptionEntitlements). */
  entitlementRaw: string;
  walletHeldRaw: string;
  /** What the swap for this leg sells (entitlement, or min(held, entitlement) after a landed redeem). "0" for USDC / skipped legs. */
  amountInRaw: string;
  action: "swap" | "usdc" | "skip";
  quotedUsdcOutRaw: string;
}

export interface BuildSellResult {
  mode: "single" | "batch";
  transactions: BuiltTransaction[];
  plan: {
    legs: BuildSellPlanLeg[];
    reserveTokensToRedeem: string;
    entitlementsRaw: string[];
    quotedUsdcOutRaw: string;
    reserveTokenSupplyRaw: string;
    walletReserveTokenRaw: string;
    walletUsdcRaw: string;
    walletSolLamports: string;
    /** The manager's Sell tax taken out of the USDC proceeds (DEC-0198), or null when the rate is 0 / this is a swaps-only rebuild. */
    tradeTax: TradeTaxPlan | null;
  };
  reserveAlt: string | null;
  altToRegister: string | null;
  blockhash: string;
  lastValidBlockHeight: number;
  generatedAt: string;
  timings: Record<string, number>;
}

export interface BuildSellInput {
  reserve: PublicKey;
  wallet: PublicKey;
  reserveTokensToRedeem: bigint;
  slippageBps: number;
  assetMints: PublicKey[] | null;
  /** Rebuild only these legs' swaps (auto-retry / resume); implies the redeem already landed. */
  legsOnly: string[] | null;
  /** The redeem already landed (resume): no redeem transaction; swaps sell what is held. */
  redeemDone: boolean;
  /**
   * Rebuild ONLY the Sell-tax transaction (its blockhash expired after every
   * swap landed) on the USDC base the original build computed -- no quotes,
   * no redeem, no swaps. The client persists that base; the rate and the
   * destinations are re-read live.
   */
  taxOnly: { baseUsdcRaw: bigint } | null;
}

export interface BuildSellDeps extends ReadDeps {
  jupiterApiKey: string;
  jupiterQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; maxAccounts: number | null; apiKey: string }): Promise<JupiterCallResult<JupiterQuote>>;
  jupiterBuildTransaction(p: { quote: JupiterQuote; userPublicKey: string; apiKey: string }): Promise<JupiterCallResult<JupiterSwapTransactionPayload>>;
  jupiterBuildInstructions(p: { quote: JupiterQuote; userPublicKey: string; apiKey: string }): Promise<JupiterCallResult<JupiterSwapInstructionsPayload>>;
  simulate?: (tx: VersionedTransaction) => Promise<{ err: unknown; logs: string[] | null }>;
  /** The manager's Buy/Sell tax rates from the Reserve's metadata_uri (DEC-0198); absent = no tax (offline tests). */
  lookupTradeTax?: (metadataUri: string) => Promise<ReserveTradeTaxRates>;
}

/** Pure: the USDC a sale is taxed on -- each swap's MINIMUM out at the sale's slippage (never the optimistic quote, so the tax transfer cannot exceed what actually arrives) plus the USDC leg's entitlement when the redeem is part of this build. */
export function sellTaxBaseUsdcRaw(quotedOutRaws: bigint[], slippageBps: number, usdcLegEntitlementRaw: bigint, redeemInThisBuild: boolean): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  let total = 0n;
  for (const out of quotedOutRaws) total += (out * (10_000n - bps)) / 10_000n;
  return total + (redeemInThisBuild ? usdcLegEntitlementRaw : 0n);
}

/** Pure: which legs a sale must swap into USDC, and how much of each. */
/** Compute budget for the standalone tax transaction: two ATA creates + two transfers. */
const TAX_TX_COMPUTE_UNIT_LIMIT = 120_000;

export function planSellLegs(
  legs: { mint: string; entitlementRaw: bigint; walletHeldRaw: bigint }[],
  redeemDone: boolean,
  legsOnly: string[] | null,
): { mint: string; amountInRaw: bigint; action: "swap" | "usdc" | "skip" }[] {
  const wanted = legsOnly ? new Set(legsOnly) : null;
  return legs.map((l) => {
    if (l.mint === MAINNET_USDC_MINT) return { mint: l.mint, amountInRaw: 0n, action: "usdc" as const };
    const amountIn = redeemDone ? (l.walletHeldRaw < l.entitlementRaw ? l.walletHeldRaw : l.entitlementRaw) : l.entitlementRaw;
    if (amountIn <= 0n || (wanted && !wanted.has(l.mint))) return { mint: l.mint, amountInRaw: 0n, action: "skip" as const };
    return { mint: l.mint, amountInRaw: amountIn, action: "swap" as const };
  });
}

/** Pure: whether the one-transaction composition is worth attempting for a sale. */
export function shouldAttemptSingleSell(params: { swapLegCount: number; legsOnly: string[] | null; redeemDone: boolean }): boolean {
  if (params.redeemDone || params.legsOnly) return false;
  return params.swapLegCount <= SINGLE_TX_MAX_SWAP_LEGS;
}

export async function buildSellTransactions(deps: BuildSellDeps, input: BuildSellInput): Promise<BuildSellResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const { connection, program, ssrProgramId } = deps;
  const wallet = input.wallet;
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);
  const redeemDone = input.redeemDone || input.legsOnly !== null;

  const read = await readReserveAndWallet(deps, input.reserve, wallet, input.assetMints);
  timings.readsMs = read.readsMs;
  const { orderedAssets, reserveTokenMint, vaultAuthority, supplyRaw, heldByMint, walletUsdcRaw, walletReserveTokenRaw, walletSolLamports, reserveAlt } = read;
  const taxRatesPromise: Promise<ReserveTradeTaxRates> = deps.lookupTradeTax
    ? deps.lookupTradeTax(String(read.reserveAccount.metadataUri ?? "")).catch(() => ZERO_TRADE_TAX)
    : Promise.resolve(ZERO_TRADE_TAX);
  const protocolDestination = new PublicKey(MAINNET_TREASURY_VAULT);
  const managerDestinationRaw = read.reserveAccount.feeConfig?.feeDestination;
  const managerDestination = managerDestinationRaw ? new PublicKey(managerDestinationRaw) : null;
  const taxInstructionsFor = (baseUsdcRaw: bigint, taxPct: number) => {
    const split = computeTradeTax(baseUsdcRaw, tradeTaxBps(taxPct));
    const ixs = split.taxUsdcRaw > 0n && managerDestination ? buildTradeTaxInstructions({ trader: wallet, usdcMint, protocolDestination, managerDestination, split }) : [];
    return { split, ixs, plan: ixs.length > 0 && managerDestination ? tradeTaxPlan(split, protocolDestination, managerDestination) : null };
  };

  if (input.taxOnly) {
    // Only the tax transaction, on the persisted base (see BuildSellInput.taxOnly).
    const tax = taxInstructionsFor(input.taxOnly.baseUsdcRaw, (await taxRatesPromise).sellTaxPct);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const transactions: BuiltTransaction[] = [];
    if (tax.ixs.length > 0) {
      const taxTx = compileV0(wallet, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: TAX_TX_COMPUTE_UNIT_LIMIT }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }), ...tax.ixs], []);
      transactions.push({ kind: "tax", ...toBase64(taxTx), lastValidBlockHeight });
    }
    timings.totalMs = Date.now() - t0;
    return {
      mode: "batch",
      transactions,
      plan: {
        legs: orderedAssets.map((a, i) => ({ mint: a.mint, legIndex: i, decimals: a.decimals, entitlementRaw: "0", walletHeldRaw: (heldByMint.get(a.mint) ?? 0n).toString(), amountInRaw: "0", action: a.mint === MAINNET_USDC_MINT ? ("usdc" as const) : ("skip" as const), quotedUsdcOutRaw: "0" })),
        reserveTokensToRedeem: input.reserveTokensToRedeem.toString(),
        entitlementsRaw: [],
        quotedUsdcOutRaw: "0",
        reserveTokenSupplyRaw: supplyRaw.toString(),
        walletReserveTokenRaw: walletReserveTokenRaw.toString(),
        walletUsdcRaw: walletUsdcRaw.toString(),
        walletSolLamports: walletSolLamports.toString(),
        tradeTax: tax.plan,
      },
      reserveAlt,
      altToRegister: null,
      blockhash,
      lastValidBlockHeight,
      generatedAt: new Date().toISOString(),
      timings,
    };
  }
  if (!redeemDone && walletReserveTokenRaw < input.reserveTokensToRedeem) {
    throw new BuildError(422, `This wallet holds ${walletReserveTokenRaw.toString()} raw Reserve Tokens but the sale needs ${input.reserveTokensToRedeem.toString()} raw. Nothing was submitted.`);
  }
  if (supplyRaw <= 0n) throw new BuildError(422, "This Reserve has no Reserve Token supply to redeem against.");

  // The redeem prelude (ATA creates + redeem) and the exact entitlements.
  const { instructions: redeemPrelude, entitlementsRaw } = await buildDirectMultiAssetRedeemInstructions({
    program,
    reserve: input.reserve,
    reserveTokenMint,
    vaultAuthority,
    user: wallet,
    assets: orderedAssets,
    reserveTokenSupplyRaw: supplyRaw.toString(),
    redemptionFeeBps: BigInt(read.reserveAccount.feeConfig.redemptionFeeBps),
    reserveTokensToRedeem: input.reserveTokensToRedeem,
  });
  const redeemIx = redeemPrelude[redeemPrelude.length - 1];
  const ataIxs = redeemPrelude.slice(0, -1);
  const usdcAtaCreate = createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(usdcMint, wallet), wallet, usdcMint);

  const sellLegs = planSellLegs(
    orderedAssets.map((a, i) => ({ mint: a.mint, entitlementRaw: entitlementsRaw[i], walletHeldRaw: heldByMint.get(a.mint) ?? 0n })),
    redeemDone,
    input.legsOnly,
  );
  const swapLegs = sellLegs.filter((l) => l.action === "swap");
  const legIndexOf = (mint: string) => orderedAssets.findIndex((a) => a.mint === mint);
  const attemptSingle = shouldAttemptSingleSell({ swapLegCount: swapLegs.length, legsOnly: input.legsOnly, redeemDone: input.redeemDone });

  // EVERY leg's asset -> USDC quote at once (account-budgeted first for the single attempt).
  const tQuote = Date.now();
  const quotes = await Promise.all(
    swapLegs.map(async (leg) => {
      const base = { inputMint: leg.mint, outputMint: MAINNET_USDC_MINT, amount: leg.amountInRaw, slippageBps: input.slippageBps, apiKey: deps.jupiterApiKey };
      let r = await deps.jupiterQuote({ ...base, maxAccounts: attemptSingle ? SINGLE_TX_SWAP_MAX_ACCOUNTS : null });
      if (r.kind !== "ok" && attemptSingle) r = await deps.jupiterQuote({ ...base, maxAccounts: null });
      if (r.kind !== "ok") throw jupiterFailure("quote", leg.mint, r);
      if (!isPriceImpactAcceptable(r.value)) {
        throw new BuildError(422, `Selling ${leg.mint} has a price impact of ${Number(r.value.priceImpactPct).toFixed(1)}% -- too high to execute automatically; its on-chain liquidity is too thin right now.`, { mint: leg.mint });
      }
      return { leg, quote: r.value };
    }),
  );
  timings.quotesMs = Date.now() - tQuote;
  const quotedUsdcOutRaw = quotes.reduce((s, q) => s + BigInt(q.quote.outAmount), 0n);

  // Sell tax (DEC-0198): out of the USDC proceeds this build produces. A
  // swaps-only rebuild (legsOnly) never carries it -- the original build's tax
  // transaction is still the one the client submits once every swap lands.
  const usdcLegIndex = orderedAssets.findIndex((a) => a.mint === MAINNET_USDC_MINT);
  const usdcLegEntitlementRaw = usdcLegIndex >= 0 ? entitlementsRaw[usdcLegIndex] : 0n;
  const taxBase = input.legsOnly ? 0n : sellTaxBaseUsdcRaw(quotes.map((q) => BigInt(q.quote.outAmount)), input.slippageBps, usdcLegEntitlementRaw, !redeemDone);
  const tax = taxInstructionsFor(taxBase, (await taxRatesPromise).sellTaxPct);

  const tBuild = Date.now();
  const alt = await planAlt(connection, wallet, read, input.reserve, ssrProgramId);

  // Single attempt: [budget, ATA creates, USDC ATA, redeem, swaps' setup+swap] -- one compile.
  let single: { instructions: TransactionInstruction[]; swapTables: AddressLookupTableAccount[] } | null = null;
  if (attemptSingle) {
    const sets = await Promise.all(
      quotes.map(async ({ leg, quote }) => {
        const r = await deps.jupiterBuildInstructions({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey });
        if (r.kind !== "ok") throw jupiterFailure("transaction", leg.mint, r);
        return r.value;
      }),
    );
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: SINGLE_TX_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
      ...ataIxs,
      usdcAtaCreate,
      redeemIx,
    ];
    for (const set of sets) {
      for (const setup of set.setupInstructions) {
        const ix = deserializeJupiterInstruction(setup);
        if (!isComputeBudgetInstruction(ix)) ixs.push(ix);
      }
      const swapIx = deserializeJupiterInstruction(set.swapInstruction);
      if (!isComputeBudgetInstruction(swapIx)) ixs.push(swapIx);
    }
    ixs.push(...tax.ixs);
    const swapTables = await fetchLookupTables(connection, sets.flatMap((s) => s.addressLookupTableAddresses));
    single = { instructions: ixs, swapTables };
  }
  const redeemBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CORE_TX_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
  ];
  const redeemFull = [...redeemBudgetIxs, ...ataIxs, usdcAtaCreate, redeemIx];
  const redeemLean = [...redeemBudgetIxs, redeemIx];
  const wouldBe = alt.wouldBeTable;

  // With the redeem already landed there is no core transaction to fit -- batch, no table needed.
  const decision = redeemDone
    ? { mode: "batch" as const, createAlt: false }
    : decideMode({
        attemptedSingle: single !== null,
        singleFitsWithExistingTables: single !== null && fitsV0(wallet, single.instructions, [...alt.existingTables, ...single.swapTables]),
        singleFitsWithWouldBeTable: single !== null && wouldBe !== null && fitsV0(wallet, single.instructions, [wouldBe, ...single.swapTables]),
        coreFitsWithExistingTables: fitsV0(wallet, redeemFull, alt.existingTables) || fitsV0(wallet, redeemLean, alt.existingTables),
        coreFitsWithWouldBeTable: wouldBe !== null && (fitsV0(wallet, redeemFull, [wouldBe]) || fitsV0(wallet, redeemLean, [wouldBe])),
        hasRegisteredAlt: reserveAlt !== null,
      });
  if (decision.mode === "unfit") {
    throw new BuildError(422, `This Reserve's redeem references ${redeemIx.keys.length} accounts and cannot fit one transaction even with a trading lookup table -- nothing was built.`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const reserveTables = decision.createAlt && wouldBe ? [wouldBe] : alt.existingTables;
  const transactions: BuiltTransaction[] = decision.createAlt ? altTransactions(wallet, blockhash, lastValidBlockHeight, alt) : [];

  if (decision.mode === "single" && single) {
    const tx = compileV0(wallet, blockhash, single.instructions, [...reserveTables, ...single.swapTables]);
    if (deps.simulate && !decision.createAlt) {
      const sim = await deps.simulate(tx).catch(() => null);
      if (sim && sim.err) {
        throw new BuildError(422, `${describeOnChainError(new Error(`Transaction failed on-chain (${JSON.stringify(sim.err)}).`))} This was caught by a read-only simulation BEFORE anything was signed or submitted -- nothing moved and no fee was paid.`, { logs: sim.logs ?? [] });
      }
    }
    transactions.push({ kind: "single", ...toBase64(tx), lastValidBlockHeight });
  } else {
    if (!redeemDone) {
      const redeemIxs = fitsV0(wallet, redeemFull, reserveTables) ? redeemFull : redeemLean;
      const redeemTx = compileV0(wallet, blockhash, redeemIxs, reserveTables);
      transactions.push({ kind: "redeem", ...toBase64(redeemTx), lastValidBlockHeight });
    }
    const swapTxs = await Promise.all(
      quotes.map(async ({ leg, quote }) => {
        const r = await deps.jupiterBuildTransaction({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey });
        if (r.kind !== "ok") throw jupiterFailure("transaction", leg.mint, r);
        const tx = VersionedTransaction.deserialize(Buffer.from(r.value.swapTransaction, "base64"));
        tx.message.recentBlockhash = blockhash;
        return { kind: "swap" as const, mint: leg.mint, legIndex: legIndexOf(leg.mint), ...toBase64(tx), lastValidBlockHeight };
      }),
    );
    transactions.push(...swapTxs);
    if (tax.ixs.length > 0) {
      const taxTx = compileV0(wallet, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: TAX_TX_COMPUTE_UNIT_LIMIT }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }), ...tax.ixs], []);
      transactions.push({ kind: "tax", ...toBase64(taxTx), lastValidBlockHeight });
    }
  }
  timings.buildMs = Date.now() - tBuild;
  timings.totalMs = Date.now() - t0;

  const quoteByMint = new Map(quotes.map((q) => [q.leg.mint, q.quote]));
  return {
    mode: decision.mode,
    transactions,
    plan: {
      legs: orderedAssets.map((a, i) => ({
        mint: a.mint,
        legIndex: i,
        decimals: a.decimals,
        entitlementRaw: entitlementsRaw[i].toString(),
        walletHeldRaw: (heldByMint.get(a.mint) ?? 0n).toString(),
        amountInRaw: sellLegs[i].amountInRaw.toString(),
        action: sellLegs[i].action,
        quotedUsdcOutRaw: quoteByMint.get(a.mint)?.outAmount ?? "0",
      })),
      reserveTokensToRedeem: input.reserveTokensToRedeem.toString(),
      entitlementsRaw: entitlementsRaw.map((e) => e.toString()),
      quotedUsdcOutRaw: quotedUsdcOutRaw.toString(),
      reserveTokenSupplyRaw: supplyRaw.toString(),
      walletReserveTokenRaw: walletReserveTokenRaw.toString(),
      walletUsdcRaw: walletUsdcRaw.toString(),
      walletSolLamports: walletSolLamports.toString(),
      tradeTax: tax.plan,
    },
    reserveAlt,
    altToRegister: decision.createAlt && alt.wouldBeAlt ? alt.wouldBeAlt.toBase58() : null,
    blockhash,
    lastValidBlockHeight,
    generatedAt: new Date().toISOString(),
    timings,
  };
}
