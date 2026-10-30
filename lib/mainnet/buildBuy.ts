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
// The server moves nothing on its own. It returns base64 transactions for the
// caller's own wallet; a caller who never gets a wallet signature never moves
// anything (same invariant as api/mainnet/jupiter-swap.ts / rpc-proxy.ts).
// The one signature the server adds (DEC-0238) is the fee quote signer's on
// the mint (or single) transaction it built itself: it fixes the USDC mint
// fee that transaction pays to the Treasury and the Manager. The signer is
// never the fee payer and is named only by the mint instruction.
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
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { buildMintWithUsdcFeeInstructions, computeMintRequirements, describeOnChainError } from "@ssr/sdk";
import { coSignFee, missingFeeDestinationAtaInstructions, quoteUsdcMintFee, resolveUsdcFeeRouting } from "./usdcMintFee";
import { loadFeeLookupTable } from "./feeLookupTable";
import { packContents, packFits, packSwapLegs, type PackableLeg } from "./swapPacking";
import { assessBuyFeasibility, planBuyFunding, type BuyFeasibility, type BuyFundingAction, type BuyFundingPlan, type BuyLegInput } from "../../src/merge/lib/multiAssetBuyPlan";
import { assembleSingleBuyInstructions, deserializeJupiterInstruction, isComputeBudgetInstruction, buildUnwrapSolInstructions, buildWrapRecoveredSolInstructions, countAccountLocks, fetchLookupTables, SINGLE_TX_MICRO_LAMPORTS_PER_CU, SINGLE_TX_SWAP_MAX_ACCOUNTS, SOLANA_MAX_TX_ACCOUNT_LOCKS } from "../../src/merge/lib/singleTxBuy";
import { MAINNET_USDC_MINT, isPriceImpactAcceptable, type JupiterCallResult, type JupiterQuote, type JupiterSwapInstructionsPayload, type JupiterSwapTransactionPayload } from "./jupiter";
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
    /** DEC-0238: the mint fee, paid in USDC inside the mint transaction. */
    usdcMintFeeRaw: string;
    /** USD value of the deposit the fee was computed on, at SSR prices. */
    depositValueUsdcRaw: string;
    requiredAmountsRaw: string[];
    usdcNeededRaw: string;
    feasibility: BuyFeasibility;
    reserveTokenSupplyRaw: string;
    walletUsdcRaw: string;
    walletSolLamports: string;
    walletReserveTokenRaw: string;
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
  /** DEC-0238: SSR's fee quote signer (the settlement keeper). Co-signs the mint so its fee is paid in USDC. */
  feeQuoteSigner: Keypair | null;
}

// --- Pure decision helpers ---------------------------------------------------

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
  const { orderedAssets, reserveTokenMint, reserveTokenProgram, mintAuthority, protocolConfig, supplyRaw, heldByMint, walletUsdcRaw, walletReserveTokenRaw, walletSolLamports, reserveAlt } = read;
  // Prices for mints only discovered by the read (caller passed none).
  const priceMap =
    prices ?? (await deps.fetchPrices(orderedAssets.map((a) => a.mint).filter((m) => m !== MAINNET_USDC_MINT)).catch(() => new Map<string, { usdPrice: number | null | undefined }>()));
  timings.readsMs = read.readsMs;

  // Exact per-leg deposit requirements (same integer math the program enforces).
  const requirements = computeMintRequirements(input.reserveTokensRequested, supplyRaw, orderedAssets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) })));
  const requiredAmountsRaw = requirements.map((r) => r.requiredAmount);
  // DEC-0238: the mint fee is paid in USDC inside the mint, so the minter
  // receives every requested Reserve Token.
  const expectedNetRaw = input.reserveTokensRequested;
  if (!deps.feeQuoteSigner) {
    throw new BuildError(503, "Minting is temporarily unavailable: the USDC mint-fee signer is not configured on this deployment. Nothing was submitted.");
  }

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
  // DEC-0238: the USDC mint fee on the deposit's value, plus the Reserve's fee routing.
  const [{ depositValueUsdcRaw, usdcFeeRaw }, feeRouting] = await Promise.all([
    Promise.resolve().then(() =>
      quoteUsdcMintFee({
        legs: orderedAssets.map((a, i) => ({ mint: a.mint, decimals: a.decimals, amountRaw: requiredAmountsRaw[i], priceUsd: legInputs[i].priceUsd })),
        mintFeeBps: Number(read.reserveAccount.feeConfig.mintFeeBps),
      }),
    ),
    resolveUsdcFeeRouting(program, ssrProgramId, input.reserve, read.reserveAccount),
  ]);
  const feasibility = assessBuyFeasibility({ plan, walletUsdcRaw, walletSolLamports, usdcMintFeeRaw: usdcFeeRaw });
  if (!feasibility.feasible && !input.mintOnly) {
    throw new BuildError(422, `This purchase can't start yet: ${feasibility.reasons.join("; ")}. Nothing was submitted.`, { feasibility: serializeBuildResult(feasibility) });
  }

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
      // Capped routes are what let legs share a transaction (single mode, or
      // swap packing in batch mode); an uncapped route is the fallback.
      const capped = attemptSingle || swapActions.length > 1;
      let r = await deps.jupiterQuote({ ...base, maxAccounts: capped ? SINGLE_TX_SWAP_MAX_ACCOUNTS : null });
      if (r.kind !== "ok" && capped) r = await deps.jupiterQuote({ ...base, maxAccounts: null });
      if (r.kind !== "ok") throw jupiterFailure("quote", action.mint, r, { inputMint: MAINNET_USDC_MINT, outputMint: action.mint, amountRaw: action.usdcBudgetRaw });
      if (!isPriceImpactAcceptable(r.value)) {
        throw new BuildError(422, `The swap for ${action.mint} has a price impact of ${Number(r.value.priceImpactPct).toFixed(1)}% -- too high to execute automatically; its on-chain liquidity is too thin right now.`, { mint: action.mint });
      }
      return { action, quote: r.value };
    }),
  );
  timings.quotesMs = Date.now() - tQuote;

  // The mint prelude (ATA creates + mint) -- built once, used by either mode.
  const tBuild = Date.now();
  const feeQuoteSigner = deps.feeQuoteSigner;
  const [{ instructions: mintPrelude }, feeAtaIxs] = await Promise.all([
    buildMintWithUsdcFeeInstructions({
      program,
      protocolConfig,
      reserve: input.reserve,
      reserveTokenMint,
      reserveTokenProgram,
      mintAuthority,
      user: wallet,
      assets: orderedAssets,
      reserveTokenSupplyRaw: supplyRaw.toString(),
      reserveTokensRequested: input.reserveTokensRequested,
      slippageBps: input.slippageBps / 10_000,
      usdcFeeRaw,
      usdcMint: new PublicKey(MAINNET_USDC_MINT),
      feeQuoteSigner: feeQuoteSigner.publicKey,
      routing: feeRouting,
    }),
    missingFeeDestinationAtaInstructions(connection, wallet, feeRouting),
  ]);
  const mintIx = mintPrelude[mintPrelude.length - 1];
  const ataIxs = mintPrelude.slice(0, -1);
  const wrapIxs = wrapActions.flatMap((a) => buildWrapRecoveredSolInstructions(wallet, a.lamports));
  // DEC-0244: unwrap whatever wrapped SOL is left (the swap buffer) back to native SOL, after the mint.
  const unwrapIxs = buildUnwrapSolInstructions(wallet, orderedAssets.map((a) => a.mint));

  // Table facts: the registered table (if any) and the would-be one.
  // DEC-0238: plus the protocol-wide fee table, which every USDC-fee mint compiles against.
  const [alt, feeTables] = await Promise.all([planAlt(connection, wallet, read, input.reserve, ssrProgramId), loadFeeLookupTable(connection)]);

  // Single attempt: instruction builds in parallel, then ONE compile.
  let single: { instructions: TransactionInstruction[]; swapTables: AddressLookupTableAccount[] } | null = null;
  if (attemptSingle && quotes.length > 0) {
    const sets = await Promise.all(
      quotes.map(async ({ action, quote }) => {
        const r = await deps.jupiterBuildInstructions({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey });
        if (r.kind !== "ok") throw jupiterFailure("transaction", action.mint, r, { inputMint: MAINNET_USDC_MINT, outputMint: action.mint, amountRaw: action.usdcBudgetRaw, quote });
        return r.value;
      }),
    );
    const instructions = assembleSingleBuyInstructions({
      ataCreateInstructions: [...ataIxs, ...feeAtaIxs],
      swapSets: sets.map((s) => ({ setupInstructions: s.setupInstructions, swapInstruction: s.swapInstruction, addressLookupTableAddresses: s.addressLookupTableAddresses })),
      wrapInstructions: wrapIxs,
      mintInstruction: mintIx,
      unwrapInstructions: unwrapIxs,
    });
    const swapTables = await fetchLookupTables(connection, sets.flatMap((s) => s.addressLookupTableAddresses));
    single = { instructions, swapTables };
  }
  const mintBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_TX_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
  ];
  const mintFull = [...mintBudgetIxs, ...ataIxs, ...feeAtaIxs, ...wrapIxs, mintIx, ...unwrapIxs];
  // Fee-destination ATA creates stay in the lean set: the fee transfer fails without them.
  const mintLean = [...mintBudgetIxs, ...feeAtaIxs, ...wrapIxs, mintIx, ...unwrapIxs];
  const wouldBe = alt.wouldBeTable;

  const decision = decideMode({
    attemptedSingle: single !== null,
    singleFitsWithExistingTables: single !== null && fitsV0(wallet, single.instructions, [...alt.existingTables, ...feeTables, ...single.swapTables]),
    singleFitsWithWouldBeTable: single !== null && wouldBe !== null && fitsV0(wallet, single.instructions, [wouldBe, ...feeTables, ...single.swapTables]),
    coreFitsWithExistingTables: fitsV0(wallet, mintFull, [...alt.existingTables, ...feeTables]) || fitsV0(wallet, mintLean, [...alt.existingTables, ...feeTables]),
    coreFitsWithWouldBeTable: wouldBe !== null && (fitsV0(wallet, mintFull, [wouldBe, ...feeTables]) || fitsV0(wallet, mintLean, [wouldBe, ...feeTables])),
    hasRegisteredAlt: reserveAlt !== null,
  });
  if (decision.mode === "unfit") {
    throw new BuildError(422, `This Reserve's mint touches ${countAccountLocks(wallet, mintLean)} accounts (Solana allows ${SOLANA_MAX_TX_ACCOUNT_LOCKS} per transaction) and cannot fit one transaction even with a trading lookup table -- nothing was built.`);
  }

  // ONE fresh blockhash for every transaction, fetched last so it is as young as possible.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const reserveTables = [...(decision.createAlt && wouldBe ? [wouldBe] : alt.existingTables), ...feeTables];
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
    transactions.push({ kind: "single", ...toBase64(coSignFee(tx, feeQuoteSigner)), lastValidBlockHeight });
  } else {
    // Batch: swap legs PACKED into as few transactions as fit (swapPacking.ts),
    // each pack atomic. A leg that fits nowhere but alone is built as
    // Jupiter's own full transaction, exactly as before.
    transactions.push(...(await buildPackedSwapTransactions(deps, wallet, quotes, blockhash, lastValidBlockHeight, legIndexOf)));
    if (!input.legsOnly) {
      const mintIxs = fitsV0(wallet, mintFull, reserveTables) ? mintFull : mintLean;
      const mintTx = compileV0(wallet, blockhash, mintIxs, reserveTables);
      transactions.push({ kind: "mint", ...toBase64(coSignFee(mintTx, feeQuoteSigner)), lastValidBlockHeight });
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
      usdcMintFeeRaw: usdcFeeRaw.toString(),
      depositValueUsdcRaw: depositValueUsdcRaw.toString(),
      requiredAmountsRaw: requiredAmountsRaw.map((r) => r.toString()),
      usdcNeededRaw: feasibility.requiredUsdcRaw.toString(),
      feasibility,
      reserveTokenSupplyRaw: supplyRaw.toString(),
      walletUsdcRaw: walletUsdcRaw.toString(),
      walletSolLamports: walletSolLamports.toString(),
      walletReserveTokenRaw: walletReserveTokenRaw.toString(),
    },
    reserveAlt,
    altToRegister: decision.createAlt && alt.wouldBeAlt ? alt.wouldBeAlt.toBase58() : null,
    blockhash,
    lastValidBlockHeight,
    generatedAt: new Date().toISOString(),
    timings,
  };
}

/**
 * Builds the batch-mode swap transactions, packing legs together where they
 * fit (bytes, account locks, compute). Each returned swap transaction names
 * every mint it buys (`mints`); `mint`/`legIndex` stay the first leg's so
 * older clients keep working.
 */
async function buildPackedSwapTransactions(
  deps: BuildBuyDeps,
  wallet: PublicKey,
  quotes: { action: Extract<BuyFundingAction, { kind: "jupiter-swap" }>; quote: JupiterQuote }[],
  blockhash: string,
  lastValidBlockHeight: number,
  legIndexOf: (mint: string) => number,
): Promise<BuiltTransaction[]> {
  const single = async ({ action, quote }: (typeof quotes)[number]): Promise<BuiltTransaction> => {
    const r = await deps.jupiterBuildTransaction({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey });
    if (r.kind !== "ok") throw jupiterFailure("transaction", action.mint, r, { inputMint: MAINNET_USDC_MINT, outputMint: action.mint, amountRaw: action.usdcBudgetRaw, quote });
    const tx = VersionedTransaction.deserialize(Buffer.from(r.value.swapTransaction, "base64"));
    tx.message.recentBlockhash = blockhash;
    return { kind: "swap" as const, mint: action.mint, mints: [action.mint], legIndex: legIndexOf(action.mint), ...toBase64(tx), lastValidBlockHeight };
  };
  if (quotes.length < 2) return Promise.all(quotes.map(single));
  // Instruction form of every leg (parallel); a leg whose instructions cannot
  // be fetched is simply built whole.
  const sets = await Promise.all(
    quotes.map(async ({ quote }) => {
      const r = await deps.jupiterBuildInstructions({ quote, userPublicKey: wallet.toBase58(), apiKey: deps.jupiterApiKey }).catch(() => null);
      return r && r.kind === "ok" ? r.value : null;
    }),
  );
  const tables = await fetchLookupTables(deps.connection, sets.flatMap((s) => s?.addressLookupTableAddresses ?? [])).catch(() => null);
  if (!tables || sets.some((s) => s === null)) return Promise.all(quotes.map(single));
  const tableByKey = new Map(tables.map((t) => [t.key.toBase58(), t]));
  const legs: PackableLeg[] = sets.map((set) => ({
    instructions: [...set!.setupInstructions, set!.swapInstruction].map(deserializeJupiterInstruction).filter((ix) => !isComputeBudgetInstruction(ix)),
    tables: set!.addressLookupTableAddresses.map((a) => tableByKey.get(a)!).filter(Boolean),
  }));
  const packs = packSwapLegs(wallet, legs);
  return Promise.all(
    packs.map(async (pack) => {
      if (pack.length === 1 && !packFits(wallet, [legs[pack[0]]])) return single(quotes[pack[0]]);
      const { instructions, tables: packTables } = packContents(pack.map((i) => legs[i]));
      const tx = compileV0(wallet, blockhash, instructions, packTables);
      const mints = pack.map((i) => quotes[i].action.mint);
      return { kind: "swap" as const, mint: mints[0], mints, legIndex: legIndexOf(mints[0]), ...toBase64(tx), lastValidBlockHeight };
    }),
  );
}
