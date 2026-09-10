// SERVER-BUILT multi-asset Buy (2026-09-08 developer directive): the browser
// sends ONE request and gets back every unsigned transaction a USDC ->
// Reserve Token purchase needs, signs them all in ONE wallet prompt, and
// submits. Everything the client used to orchestrate -- vault/supply reads,
// wallet balance reads, the funding plan, N Jupiter quotes + builds, the
// one-transaction fit attempt, the lookup-table decision, the mint -- runs
// HERE, IN PARALLEL wherever the pieces are independent (Promise.all over
// every leg's quote, every leg's build, every RPC batch), against Jupiter
// directly with the server key instead of N rate-limited proxy round trips.
//
// The server signs NOTHING. It returns base64 transactions for the caller's
// own wallet; a caller who never gets a wallet signature never moves anything
// (same invariant as api/mainnet/jupiter-swap.ts / rpc-proxy.ts).
//
// Modes:
//   "single" -- ONE atomic v0 transaction [compute budget, ATA creates, each
//               swap's setup+swap, any recovered-SOL re-wrap, mint], compiled
//               against the Reserve's trading lookup table + Jupiter's route
//               tables (DEC-0156/DEC-0161). Attempted ONLY when it can
//               plausibly fit (<= SINGLE_TX_MAX_SWAP_LEGS swap legs), at most
//               one compile; read-only simulated before it is returned.
//   "batch"  -- one v0 swap transaction per deficient leg (Jupiter's own
//               build, wrapAndUnwrapSol:false, re-stamped with the SHARED
//               blockhash), then ONE v0 mint transaction [compute budget +
//               priority fee, ATA creates, re-wrap, mint] compiled against the
//               Reserve's lookup table.
//   Either mode is preceded by "alt-create"/"alt-extend" transactions when
//   the Reserve has no registered table yet and the purchase/mint cannot fit
//   without one but WOULD fit with it (DEC-0171's auto-enable, now
//   server-decided). The mint/single transaction then references the
//   would-be table by its real address; the client submits the table
//   transactions first, waits for activation, registers the table, and only
//   then broadcasts the rest.
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import {
  buildDirectMultiAssetMintInstructions,
  computeEffectiveFeeSplit,
  computeMintRequirements,
  computeNetMintOutput,
  describeOnChainError,
  PROTOCOL_MIN_MINT_FEE_BPS,
} from "@ssr/sdk";
import { assessBuyFeasibility, planBuyFunding, type BuyFeasibility, type BuyFundingAction, type BuyFundingPlan, type BuyLegInput } from "../../src/merge/lib/multiAssetBuyPlan";
import { assembleSingleBuyInstructions, buildWrapRecoveredSolInstructions, fetchLookupTables, SINGLE_TX_MICRO_LAMPORTS_PER_CU, SINGLE_TX_SWAP_MAX_ACCOUNTS } from "../../src/merge/lib/singleTxBuy";
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
  hypotheticalLookupTable,
  jupiterFailure,
  planAlt,
  readReserveAndWallet,
  serializeBuildResult,
  toBase64,
  type BuiltTransaction,
  type ReadDeps,
} from "./buildCommon";

export { SINGLE_TX_MAX_SWAP_LEGS, MAINNET_TREASURY_VAULT, hypotheticalLookupTable, type BuiltTransaction };
export const MINT_TX_COMPUTE_UNIT_LIMIT = CORE_TX_COMPUTE_UNIT_LIMIT;
export const BuildBuyError = BuildError;
export type BuildBuyError = BuildError;
export const decideBuyMode = (p: { attemptedSingle: boolean; singleFitsWithExistingTables: boolean; singleFitsWithWouldBeTable: boolean; mintFitsWithExistingTables: boolean; mintFitsWithWouldBeTable: boolean; hasRegisteredAlt: boolean }) =>
  decideMode({ ...p, coreFitsWithExistingTables: p.mintFitsWithExistingTables, coreFitsWithWouldBeTable: p.mintFitsWithWouldBeTable });
export const serializeBuildBuyResult = serializeBuildResult;

export interface BuildBuyPlanLeg {
  mint: string;
  legIndex: number;
  decimals: number;
  requiredRaw: string;
  walletHeldRaw: string;
  /** What the client reported this purchase already acquired (countable only up to walletHeldRaw). */
  purchaseAcquiredRaw: string;
  action: "swap" | "already-funded" | "wrap-recovered-sol";
  usdcBudgetRaw: string;
  deficitRaw: string;
  priceUsd: number | null;
}

export interface BuildBuyResult {
  mode: "single" | "batch";
  transactions: BuiltTransaction[];
  plan: {
    legs: BuildBuyPlanLeg[];
    expectedNetReserveTokensRaw: string;
    requiredAmountsRaw: string[];
    usdcNeededRaw: string;
    feasibility: BuyFeasibility;
    reserveTokenSupplyRaw: string;
    walletUsdcRaw: string;
    walletSolLamports: string;
    walletReserveTokenRaw: string;
    /** The manager's Buy tax this purchase pays in USDC on top (DEC-0198), or null when the rate is 0 / this is a swaps-only rebuild. */
    tradeTax: TradeTaxPlan | null;
  };
  reserveAlt: string | null;
  /** Set when alt-create/alt-extend transactions were prepended: the table's address to register (POST /api/mainnet/reserve-alt) once they land. */
  altToRegister: string | null;
  blockhash: string;
  lastValidBlockHeight: number;
  generatedAt: string;
  timings: Record<string, number>;
}

export interface BuildBuyInput {
  reserve: PublicKey;
  wallet: PublicKey;
  reserveTokensRequested: bigint;
  slippageBps: number;
  /** The Reserve's registered asset mints, when the caller knows them (saves a program-wide scan). */
  assetMints: PublicKey[] | null;
  /** mint -> raw amount THIS purchase's own confirmed swaps already acquired (the client's persisted accounting). */
  acquiredRawByMint: Record<string, bigint>;
  /** Rebuild only these legs' swaps (auto-retry of legs that did not land); no mint. */
  legsOnly: string[] | null;
  /** Rebuild only the mint (its blockhash expired while the swaps confirmed). */
  mintOnly: boolean;
}

export interface BuildBuyDeps extends ReadDeps {
  jupiterApiKey: string;
  fetchPrices(mints: string[]): Promise<Map<string, { usdPrice: number | null | undefined }>>;
  jupiterQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; maxAccounts: number | null; apiKey: string }): Promise<JupiterCallResult<JupiterQuote>>;
  jupiterBuildTransaction(p: { quote: JupiterQuote; userPublicKey: string; apiKey: string }): Promise<JupiterCallResult<JupiterSwapTransactionPayload>>;
  jupiterBuildInstructions(p: { quote: JupiterQuote; userPublicKey: string; apiKey: string }): Promise<JupiterCallResult<JupiterSwapInstructionsPayload>>;
  /** Read-only simulation of the single transaction before it is handed out (skipped when absent, e.g. offline tests). */
  simulate?: (tx: VersionedTransaction) => Promise<{ err: unknown; logs: string[] | null }>;
  /** The manager's Buy/Sell tax rates from the Reserve's metadata_uri (DEC-0198); absent = no tax (offline tests). */
  lookupTradeTax?: (metadataUri: string) => Promise<ReserveTradeTaxRates>;
}

// --- Pure decision helpers ---------------------------------------------------

/**
 * Pure: the USDC value this purchase is taxed on -- every leg's required
 * deposit at its price (the USDC leg at 1), i.e. the purchase's full value
 * whether the wallet already held some of it or not. Falls back to the USDC
 * the plan actually spends when any leg's price is unknown.
 */
export function buyTaxBaseUsdcRaw(legs: { mint: string; decimals: number; requiredRaw: bigint; priceUsd: number | null }[], fallbackUsdcRaw: bigint): bigint {
  let total = 0n;
  for (const l of legs) {
    if (l.requiredRaw <= 0n) continue;
    if (l.mint === MAINNET_USDC_MINT) {
      total += l.requiredRaw;
      continue;
    }
    if (l.priceUsd === null || !Number.isFinite(l.priceUsd) || l.priceUsd <= 0) return fallbackUsdcRaw;
    // requiredRaw x price -> USDC raw (6 decimals), integer math on a scaled price.
    const priceScaled = BigInt(Math.round(l.priceUsd * 1e9)); // 9 decimals of price precision
    total += (l.requiredRaw * priceScaled * 1_000_000n) / (10n ** BigInt(l.decimals) * 1_000_000_000n);
  }
  return total;
}

/** Pure: whether the one-transaction composition is even worth attempting. */
export function shouldAttemptSingle(params: { swapLegCount: number; legsOnly: string[] | null; mintOnly: boolean }): boolean {
  if (params.mintOnly || params.legsOnly) return false;
  return params.swapLegCount <= SINGLE_TX_MAX_SWAP_LEGS;
}

/** Pure: the swap actions this build must quote -- all deficient legs, or only the named ones (auto-retry), or none (mint-only rebuild). */
export function selectSwapActions(actions: BuyFundingAction[], legsOnly: string[] | null, mintOnly: boolean): Extract<BuyFundingAction, { kind: "jupiter-swap" }>[] {
  const swaps = actions.filter((a): a is Extract<BuyFundingAction, { kind: "jupiter-swap" }> => a.kind === "jupiter-swap");
  if (mintOnly) return [];
  if (legsOnly) {
    const wanted = new Set(legsOnly);
    return swaps.filter((a) => wanted.has(a.mint));
  }
  return swaps;
}

/** Pure: applies the client's persisted per-purchase acquisitions to the fresh plan inputs (never the wallet's unrelated holdings -- countableAcquiredRaw caps at what is still held). */
export function applyClientAcquired(legs: BuyLegInput[], acquiredRawByMint: Record<string, bigint>): BuyLegInput[] {
  return legs.map((l) => ({ ...l, purchaseAcquiredRaw: acquiredRawByMint[l.mint] ?? 0n }));
}

// --- The build ---------------------------------------------------------------

export async function buildBuyTransactions(deps: BuildBuyDeps, input: BuildBuyInput): Promise<BuildBuyResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const { connection, program, ssrProgramId } = deps;
  const wallet = input.wallet;

  // Phases 1+2 (parallel reads) + prices, at once.
  const [read, prices] = await Promise.all([
    readReserveAndWallet(deps, input.reserve, wallet, input.assetMints),
    (async () => {
      const mints = (input.assetMints ?? []).map((m) => m.toBase58()).filter((m) => m !== MAINNET_USDC_MINT);
      return mints.length > 0 ? deps.fetchPrices(mints).catch(() => new Map<string, { usdPrice: number | null | undefined }>()) : null;
    })(),
  ]);
  const { orderedAssets, reserveTokenMint, mintAuthority, protocolConfig, supplyRaw, heldByMint, walletUsdcRaw, walletReserveTokenRaw, walletSolLamports, reserveAlt } = read;
  // The manager's Buy tax rate (DEC-0198) -- resolved while the quotes run; a metadata failure means no tax, never a blocked purchase.
  const taxRatesPromise: Promise<ReserveTradeTaxRates> = deps.lookupTradeTax
    ? deps.lookupTradeTax(String(read.reserveAccount.metadataUri ?? "")).catch(() => ZERO_TRADE_TAX)
    : Promise.resolve(ZERO_TRADE_TAX);
  // Prices for mints only discovered by the read (caller passed none).
  const priceMap =
    prices ?? (await deps.fetchPrices(orderedAssets.map((a) => a.mint).filter((m) => m !== MAINNET_USDC_MINT)).catch(() => new Map<string, { usdPrice: number | null | undefined }>()));
  timings.readsMs = read.readsMs;

  // Exact per-leg deposit requirements (same integer math the program enforces).
  const requirements = computeMintRequirements(input.reserveTokensRequested, supplyRaw, orderedAssets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) })));
  const requiredAmountsRaw = requirements.map((r) => r.requiredAmount);
  const mintSplit = computeEffectiveFeeSplit(BigInt(read.reserveAccount.feeConfig.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS);
  const { netOut: expectedNetRaw } = computeNetMintOutput(input.reserveTokensRequested, mintSplit.effectiveTotalBps);

  // Funding plan + feasibility (pure, shared with the old client path).
  const legInputs = applyClientAcquired(
    orderedAssets.map((a, i) => ({
      mint: a.mint,
      decimals: a.decimals,
      requiredRaw: requiredAmountsRaw[i],
      walletHeldRaw: heldByMint.get(a.mint) ?? 0n,
      purchaseAcquiredRaw: 0n,
      priceUsd: a.mint === MAINNET_USDC_MINT ? 1 : (priceMap.get(a.mint)?.usdPrice ?? null),
    })),
    input.acquiredRawByMint,
  );
  let plan: BuyFundingPlan;
  try {
    plan = planBuyFunding(legInputs);
  } catch (e) {
    throw new BuildError(422, e instanceof Error ? e.message : String(e));
  }
  const feasibility = assessBuyFeasibility({ plan, walletUsdcRaw, walletSolLamports });
  if (!feasibility.feasible && !input.mintOnly) {
    throw new BuildError(422, `This purchase can't start yet: ${feasibility.reasons.join("; ")}. Nothing was submitted.`, { feasibility: serializeBuildResult(feasibility) });
  }

  // Buy tax (DEC-0198): paid in USDC inside the mint transaction, so a
  // swaps-only rebuild (legsOnly) never carries it and a mint-only rebuild
  // always does. The wallet must cover it on top of the purchase itself.
  const taxRates = await taxRatesPromise;
  const taxSplit = computeTradeTax(buyTaxBaseUsdcRaw(legInputs, feasibility.requiredUsdcRaw), tradeTaxBps(taxRates.buyTaxPct));
  const managerDestinationRaw = read.reserveAccount.feeConfig?.feeDestination;
  const managerDestination = managerDestinationRaw ? new PublicKey(managerDestinationRaw) : null;
  const protocolDestination = new PublicKey(MAINNET_TREASURY_VAULT);
  const taxIxs =
    !input.legsOnly && taxSplit.taxUsdcRaw > 0n && managerDestination
      ? buildTradeTaxInstructions({ trader: wallet, usdcMint: new PublicKey(MAINNET_USDC_MINT), protocolDestination, managerDestination, split: taxSplit })
      : [];
  if (taxIxs.length > 0) {
    const usdcNeeded = (input.mintOnly ? 0n : feasibility.requiredUsdcRaw) + taxSplit.taxUsdcRaw;
    if (walletUsdcRaw < usdcNeeded) {
      throw new BuildError(
        422,
        `This purchase can't start yet: this wallet holds ${(Number(walletUsdcRaw) / 1e6).toFixed(2)} USDC but the purchase plus its ${(taxSplit.taxBps / 100).toFixed(2)}% Buy tax (${(Number(taxSplit.taxUsdcRaw) / 1e6).toFixed(2)} USDC) needs ~${(Number(usdcNeeded) / 1e6).toFixed(2)} USDC. Nothing was submitted.`,
      );
    }
  }
  const tradeTax = taxIxs.length > 0 && managerDestination ? tradeTaxPlan(taxSplit, protocolDestination, managerDestination) : null;

  const swapActions = selectSwapActions(plan.actions, input.legsOnly, input.mintOnly);
  const wrapActions = plan.actions.filter((a): a is Extract<BuyFundingAction, { kind: "wrap-recovered-sol" }> => a.kind === "wrap-recovered-sol");
  const legIndexOf = (mint: string) => orderedAssets.findIndex((a) => a.mint === mint);
  const attemptSingle = shouldAttemptSingle({ swapLegCount: swapActions.length, legsOnly: input.legsOnly, mintOnly: input.mintOnly });

  // Phase 3 (parallel): EVERY leg's Jupiter quote at once. For the single
  // attempt the quote is account-budgeted (DEC-0161) and falls back uncapped.
  const tQuote = Date.now();
  const quotes = await Promise.all(
    swapActions.map(async (action) => {
      const base = { inputMint: MAINNET_USDC_MINT, outputMint: action.mint, amount: action.usdcBudgetRaw, slippageBps: input.slippageBps, apiKey: deps.jupiterApiKey };
      let r = await deps.jupiterQuote({ ...base, maxAccounts: attemptSingle ? SINGLE_TX_SWAP_MAX_ACCOUNTS : null });
      if (r.kind !== "ok" && attemptSingle) r = await deps.jupiterQuote({ ...base, maxAccounts: null });
      if (r.kind !== "ok") throw jupiterFailure("quote", action.mint, r);
      if (!isPriceImpactAcceptable(r.value)) {
        throw new BuildError(422, `The swap for ${action.mint} has a price impact of ${Number(r.value.priceImpactPct).toFixed(1)}% -- too high to execute automatically; its on-chain liquidity is too thin right now.`, { mint: action.mint });
      }
      return { action, quote: r.value };
    }),
  );
  timings.quotesMs = Date.now() - tQuote;

  // The mint prelude (ATA creates + mint) -- built once, used by either mode.
  const tBuild = Date.now();
  const { instructions: mintPrelude } = await buildDirectMultiAssetMintInstructions({
    program,
    protocolConfig,
    protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
    reserve: input.reserve,
    reserveTokenMint,
    mintAuthority,
    user: wallet,
    assets: orderedAssets,
    reserveTokenSupplyRaw: supplyRaw.toString(),
    reserveTokensRequested: input.reserveTokensRequested,
    slippageBps: input.slippageBps / 10_000,
    minReserveTokensOut: expectedNetRaw,
  });
  const mintIx = mintPrelude[mintPrelude.length - 1];
  const ataIxs = mintPrelude.slice(0, -1);
  const wrapIxs = wrapActions.flatMap((a) => buildWrapRecoveredSolInstructions(wallet, a.lamports));

  // Table facts: the registered table (if any) and the would-be one.
  const alt = await planAlt(connection, wallet, read, input.reserve, ssrProgramId);

  // Single attempt: instruction builds in parallel, then ONE compile.
  let single: { instructions: TransactionInstruction[]; swapTables: AddressLookupTableAccount[] } | null = null;
  if (attemptSingle && quotes.length > 0) {
    const sets = await Promise.all(
      quotes.map(async ({ action, quote }) => {
        const r = await deps.jupiterBuildInstructions({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey });
        if (r.kind !== "ok") throw jupiterFailure("transaction", action.mint, r);
        return r.value;
      }),
    );
    const instructions = [
      ...assembleSingleBuyInstructions({
        ataCreateInstructions: ataIxs,
        swapSets: sets.map((s) => ({ setupInstructions: s.setupInstructions, swapInstruction: s.swapInstruction, addressLookupTableAddresses: s.addressLookupTableAddresses })),
        wrapInstructions: wrapIxs,
        mintInstruction: mintIx,
      }),
      ...taxIxs,
    ];
    const swapTables = await fetchLookupTables(connection, sets.flatMap((s) => s.addressLookupTableAddresses));
    single = { instructions, swapTables };
  }
  const mintBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_TX_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
  ];
  const mintFull = [...mintBudgetIxs, ...ataIxs, ...wrapIxs, mintIx, ...taxIxs];
  const mintLean = [...mintBudgetIxs, ...wrapIxs, mintIx, ...taxIxs];
  const wouldBe = alt.wouldBeTable;

  const decision = decideMode({
    attemptedSingle: single !== null,
    singleFitsWithExistingTables: single !== null && fitsV0(wallet, single.instructions, [...alt.existingTables, ...single.swapTables]),
    singleFitsWithWouldBeTable: single !== null && wouldBe !== null && fitsV0(wallet, single.instructions, [wouldBe, ...single.swapTables]),
    coreFitsWithExistingTables: fitsV0(wallet, mintFull, alt.existingTables) || fitsV0(wallet, mintLean, alt.existingTables),
    coreFitsWithWouldBeTable: wouldBe !== null && (fitsV0(wallet, mintFull, [wouldBe]) || fitsV0(wallet, mintLean, [wouldBe])),
    hasRegisteredAlt: reserveAlt !== null,
  });
  if (decision.mode === "unfit") {
    throw new BuildError(422, `This Reserve's mint references ${mintIx.keys.length} accounts and cannot fit one transaction even with a trading lookup table -- nothing was built.`);
  }

  // ONE fresh blockhash for every transaction, fetched last so it is as young as possible.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const reserveTables = decision.createAlt && wouldBe ? [wouldBe] : alt.existingTables;
  const transactions: BuiltTransaction[] = decision.createAlt ? altTransactions(wallet, blockhash, lastValidBlockHeight, alt) : [];

  if (decision.mode === "single" && single) {
    const tx = compileV0(wallet, blockhash, single.instructions, [...reserveTables, ...single.swapTables]);
    if (deps.simulate && !decision.createAlt) {
      // Read-only simulation BEFORE the wallet ever sees it (a doomed
      // transaction costs no approval and no fee). Skipped when the table
      // does not exist yet (it would fail on the missing table, not the purchase).
      const sim = await deps.simulate(tx).catch(() => null);
      if (sim && sim.err) {
        throw new BuildError(422, `${describeOnChainError(new Error(`Transaction failed on-chain (${JSON.stringify(sim.err)}).`))} This was caught by a read-only simulation BEFORE anything was signed or submitted -- nothing moved and no fee was paid.`, { logs: sim.logs ?? [] });
      }
    }
    transactions.push({ kind: "single", ...toBase64(tx), lastValidBlockHeight });
  } else {
    // Batch: every swap's transaction built in parallel, re-stamped with the shared blockhash.
    const swapTxs = await Promise.all(
      quotes.map(async ({ action, quote }) => {
        const r = await deps.jupiterBuildTransaction({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey });
        if (r.kind !== "ok") throw jupiterFailure("transaction", action.mint, r);
        const tx = VersionedTransaction.deserialize(Buffer.from(r.value.swapTransaction, "base64"));
        tx.message.recentBlockhash = blockhash;
        return { kind: "swap" as const, mint: action.mint, legIndex: legIndexOf(action.mint), ...toBase64(tx), lastValidBlockHeight };
      }),
    );
    transactions.push(...swapTxs);
    if (!input.legsOnly) {
      const mintIxs = fitsV0(wallet, mintFull, reserveTables) ? mintFull : mintLean;
      const mintTx = compileV0(wallet, blockhash, mintIxs, reserveTables);
      transactions.push({ kind: "mint", ...toBase64(mintTx), lastValidBlockHeight });
    }
  }
  timings.buildMs = Date.now() - tBuild;
  timings.totalMs = Date.now() - t0;

  const actionByMint = new Map<string, BuyFundingAction>(plan.actions.map((a) => [a.mint, a]));
  return {
    mode: decision.mode,
    transactions,
    plan: {
      legs: orderedAssets.map((a, i) => {
        const act = actionByMint.get(a.mint);
        return {
          mint: a.mint,
          legIndex: i,
          decimals: a.decimals,
          requiredRaw: requiredAmountsRaw[i].toString(),
          walletHeldRaw: (heldByMint.get(a.mint) ?? 0n).toString(),
          purchaseAcquiredRaw: (input.acquiredRawByMint[a.mint] ?? 0n).toString(),
          action: act?.kind === "jupiter-swap" ? "swap" : act?.kind === "wrap-recovered-sol" ? "wrap-recovered-sol" : "already-funded",
          usdcBudgetRaw: act?.kind === "jupiter-swap" ? act.usdcBudgetRaw.toString() : "0",
          deficitRaw: act?.kind === "jupiter-swap" ? act.deficitRaw.toString() : "0",
          priceUsd: legInputs[i].priceUsd,
        };
      }),
      expectedNetReserveTokensRaw: expectedNetRaw.toString(),
      requiredAmountsRaw: requiredAmountsRaw.map((r) => r.toString()),
      usdcNeededRaw: feasibility.requiredUsdcRaw.toString(),
      feasibility,
      reserveTokenSupplyRaw: supplyRaw.toString(),
      walletUsdcRaw: walletUsdcRaw.toString(),
      walletSolLamports: walletSolLamports.toString(),
      walletReserveTokenRaw: walletReserveTokenRaw.toString(),
      tradeTax,
    },
    reserveAlt,
    altToRegister: decision.createAlt && alt.wouldBeAlt ? alt.wouldBeAlt.toBase58() : null,
    blockhash,
    lastValidBlockHeight,
    generatedAt: new Date().toISOString(),
    timings,
  };
}
