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
//
// Pure planning decisions live in exported helpers (decideBuyMode,
// selectSwapActions, ...) so they are unit-testable without a wallet or
// Jupiter; the I/O is injected through BuildBuyDeps so the whole build can be
// exercised offline with fakes.
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import {
  buildDirectMultiAssetMintInstructions,
  computeEffectiveFeeSplit,
  computeMintRequirements,
  computeNetMintOutput,
  describeOnChainError,
  enumerateReserveAssetMintsOnChain,
  findProtocolConfig,
  findReserveAsset,
  findReserveVault,
  findVaultAuthority,
  getTokenSupplyWithRetry,
  PROTOCOL_MIN_MINT_FEE_BPS,
  type ZapAssetLeg,
} from "@ssr/sdk";
import {
  assessBuyFeasibility,
  planBuyFunding,
  type BuyFeasibility,
  type BuyFundingAction,
  type BuyFundingPlan,
  type BuyLegInput,
} from "../../src/merge/lib/multiAssetBuyPlan";
import {
  assembleSingleBuyInstructions,
  buildWrapRecoveredSolInstructions,
  compileSingleBuyTransaction,
  fetchLookupTables,
  SingleTxTooLargeError,
  SINGLE_TX_MICRO_LAMPORTS_PER_CU,
  SINGLE_TX_SWAP_MAX_ACCOUNTS,
} from "../../src/merge/lib/singleTxBuy";
import { buildReserveAltAddresses, chunkAltAddresses } from "../../src/merge/lib/reserveAltClient";
import {
  MAINNET_USDC_MINT,
  isPriceImpactAcceptable,
  jupiterExhaustedResponse,
  type JupiterCallResult,
  type JupiterQuote,
  type JupiterSwapInstructionsPayload,
  type JupiterSwapTransactionPayload,
} from "./jupiter";

/** Above this many swap legs the one-transaction composition has never fit (a 10-asset Reserve's mint alone carries 63 accounts) -- the single attempt is skipped outright, saving its instruction builds. */
export const SINGLE_TX_MAX_SWAP_LEGS = 4;
/** Compute-unit ceiling for the standalone mint transaction: a 12-leg mint plus ATA creations stays well under this; the priority fee scales with it. */
export const MINT_TX_COMPUTE_UNIT_LIMIT = 600_000;
export const MAINNET_TREASURY_VAULT = "3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5";

export class BuildBuyError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>, retryAfterSeconds?: number) {
    super(message);
    this.name = "BuildBuyError";
    this.status = status;
    this.extra = extra;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type BuiltTxKind = "alt-create" | "alt-extend" | "swap" | "mint" | "single";

export interface BuiltTransaction {
  kind: BuiltTxKind;
  /** The Reserve asset this swap funds (kind "swap" only). */
  mint?: string;
  /** Position of that asset in the Reserve's registered order (kind "swap" only). */
  legIndex?: number;
  base64: string;
  bytes: number;
  lastValidBlockHeight: number;
}

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
    feasibility: BuyFeasibility & { requiredUsdcRaw: bigint; missingUsdcRaw: bigint; missingSolLamports: bigint };
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

export interface BuildBuyDeps {
  connection: Connection;
  program: any;
  ssrProgramId: PublicKey;
  jupiterApiKey: string;
  fetchPrices(mints: string[]): Promise<Map<string, { usdPrice: number | null | undefined }>>;
  jupiterQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; maxAccounts: number | null; apiKey: string }): Promise<JupiterCallResult<JupiterQuote>>;
  jupiterBuildTransaction(p: { quote: JupiterQuote; userPublicKey: string; apiKey: string }): Promise<JupiterCallResult<JupiterSwapTransactionPayload>>;
  jupiterBuildInstructions(p: { quote: JupiterQuote; userPublicKey: string; apiKey: string }): Promise<JupiterCallResult<JupiterSwapInstructionsPayload>>;
  lookupReserveAlt(reserve: string): Promise<string | null>;
  /** Read-only simulation of the single transaction before it is handed out (skipped when absent, e.g. offline tests). */
  simulate?: (tx: VersionedTransaction) => Promise<{ err: unknown; logs: string[] | null }>;
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

/** Pure: mode + whether a table must be created first, given the three fit facts the compile step measured. */
export function decideBuyMode(params: {
  attemptedSingle: boolean;
  singleFitsWithExistingTables: boolean;
  singleFitsWithWouldBeTable: boolean;
  mintFitsWithExistingTables: boolean;
  mintFitsWithWouldBeTable: boolean;
  hasRegisteredAlt: boolean;
}): { mode: "single" | "batch"; createAlt: boolean } | { mode: "unfit" } {
  if (params.attemptedSingle) {
    if (params.singleFitsWithExistingTables) return { mode: "single", createAlt: false };
    if (!params.hasRegisteredAlt && params.singleFitsWithWouldBeTable) return { mode: "single", createAlt: true };
  }
  if (params.mintFitsWithExistingTables) return { mode: "batch", createAlt: false };
  if (!params.hasRegisteredAlt && params.mintFitsWithWouldBeTable) return { mode: "batch", createAlt: true };
  return { mode: "unfit" };
}

/** Pure: a would-be lookup table object, size-identical to a real one, keyed by the address the create transaction will produce. */
export function hypotheticalLookupTable(key: PublicKey, addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key,
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
  });
}

function compileV0(payer: PublicKey, recentBlockhash: string, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[]): VersionedTransaction {
  return compileSingleBuyTransaction({ payer, recentBlockhash, instructions, lookupTables });
}

function fits(payer: PublicKey, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[]): boolean {
  try {
    compileV0(payer, "11111111111111111111111111111111", instructions, lookupTables);
    return true;
  } catch (e) {
    if (e instanceof SingleTxTooLargeError) return false;
    throw e;
  }
}

function toBase64(tx: VersionedTransaction): { base64: string; bytes: number } {
  const bytes = tx.serialize();
  return { base64: Buffer.from(bytes).toString("base64"), bytes: bytes.length };
}

function jupiterFailure(what: "quote" | "transaction", mint: string, r: Exclude<JupiterCallResult<unknown>, { kind: "ok" }>): BuildBuyError {
  if (r.kind === "specific-error") return new BuildBuyError(502, `Jupiter could not ${what === "quote" ? "quote" : "build"} the swap for ${mint}: ${r.message}`, { mint });
  const x = jupiterExhaustedResponse(what, r.lastStatus);
  return new BuildBuyError(x.status, `${x.error} (asset ${mint})`, { mint }, x.retryAfterSeconds);
}

// --- The build ---------------------------------------------------------------

export async function buildBuyTransactions(deps: BuildBuyDeps, input: BuildBuyInput): Promise<BuildBuyResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const { connection, program, ssrProgramId } = deps;
  const wallet = input.wallet;
  const usdcMint = new PublicKey(MAINNET_USDC_MINT);

  // Phase 1 (parallel): the Reserve account + which asset mints to resolve.
  const [reserveAccount, candidateMints] = await Promise.all([
    program.account.reserve.fetchNullable(input.reserve) as Promise<any>,
    input.assetMints ? Promise.resolve(input.assetMints) : enumerateReserveAssetMintsOnChain(connection).then((ms) => ms.map((m) => new PublicKey(m))),
  ]);
  if (!reserveAccount) throw new BuildBuyError(404, "Reserve not found on Mainnet.");
  const reserveTokenMint = new PublicKey(reserveAccount.reserveTokenMint);
  const mintAuthority = PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), input.reserve.toBuffer()], ssrProgramId)[0];
  const [protocolConfig] = findProtocolConfig(ssrProgramId);

  // Phase 2 (parallel): every read the plan needs -- asset registrations,
  // vault balances, supply, the wallet's balances, prices, the table registry.
  const reserveAssetPdas = candidateMints.map((m) => findReserveAsset(input.reserve, m, ssrProgramId)[0]);
  const vaultPdas = candidateMints.map((m) => findReserveVault(input.reserve, m, ssrProgramId)[0]);
  const walletAtas = candidateMints.map((m) => getAssociatedTokenAddressSync(m, wallet));
  const walletUsdcAta = getAssociatedTokenAddressSync(usdcMint, wallet);
  const walletRtAta = getAssociatedTokenAddressSync(reserveTokenMint, wallet);
  const nonUsdcMints = candidateMints.map((m) => m.toBase58()).filter((m) => m !== MAINNET_USDC_MINT);
  const tRead = Date.now();
  type ReserveAssetRow = { decimals: number; orderIndex: number } | null;
  const [reserveAssets, vaultInfos, supply, walletInfos, walletSolLamports, prices, reserveAlt] = await Promise.all([
    program.account.reserveAsset.fetchMultiple(reserveAssetPdas) as Promise<ReserveAssetRow[]>,
    connection.getMultipleAccountsInfo(vaultPdas),
    getTokenSupplyWithRetry(connection, reserveTokenMint),
    connection.getMultipleAccountsInfo([...walletAtas, walletUsdcAta, walletRtAta]),
    connection.getBalance(wallet, "confirmed"),
    deps.fetchPrices(nonUsdcMints).catch(() => new Map<string, { usdPrice: number | null | undefined }>()),
    deps.lookupReserveAlt(input.reserve.toBase58()).catch(() => null),
  ]);
  timings.readsMs = Date.now() - tRead;

  const tokenAmount = (pda: PublicKey, info: Parameters<typeof unpackAccount>[1]): bigint => {
    if (!info) return 0n;
    try {
      return unpackAccount(pda, info).amount;
    } catch {
      return 0n;
    }
  };
  const assets: ZapAssetLeg[] = [];
  const orderIndexes: number[] = [];
  candidateMints.forEach((m, i) => {
    const ra = reserveAssets[i];
    if (!ra) return;
    assets.push({
      mint: m.toBase58(),
      decimals: ra.decimals,
      reserveAsset: reserveAssetPdas[i].toBase58(),
      vault: vaultPdas[i].toBase58(),
      vaultBalanceRaw: tokenAmount(vaultPdas[i], vaultInfos[i]).toString(),
    });
    orderIndexes.push(ra.orderIndex);
  });
  // Registered order (order_index) -- the order the mint's remaining accounts must follow.
  const order = assets.map((_, i) => i).sort((a, b) => orderIndexes[a] - orderIndexes[b]);
  const orderedAssets = order.map((i) => assets[i]);
  const heldByMint = new Map<string, bigint>();
  candidateMints.forEach((m, i) => heldByMint.set(m.toBase58(), tokenAmount(walletAtas[i], walletInfos[i])));
  const walletUsdcRaw = tokenAmount(walletUsdcAta, walletInfos[candidateMints.length]);
  const walletReserveTokenRaw = tokenAmount(walletRtAta, walletInfos[candidateMints.length + 1]);

  if (orderedAssets.length !== reserveAccount.assetCount) {
    throw new BuildBuyError(422, `Could not resolve every registered asset of this Reserve (${orderedAssets.length} of ${reserveAccount.assetCount}) -- refusing to build against an incomplete asset list.`);
  }
  if (orderedAssets.length === 0) throw new BuildBuyError(422, "This Reserve has no registered assets.");

  // Exact per-leg deposit requirements (same integer math the program enforces).
  const supplyRaw = BigInt(supply ? supply.value.amount : "0");
  const requirements = computeMintRequirements(
    input.reserveTokensRequested,
    supplyRaw,
    orderedAssets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) })),
  );
  const requiredAmountsRaw = requirements.map((r) => r.requiredAmount);
  const mintSplit = computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS);
  const { netOut: expectedNetRaw } = computeNetMintOutput(input.reserveTokensRequested, mintSplit.effectiveTotalBps);

  // Funding plan + feasibility (pure, shared with the old client path).
  const legInputs = applyClientAcquired(
    orderedAssets.map((a, i) => ({
      mint: a.mint,
      decimals: a.decimals,
      requiredRaw: requiredAmountsRaw[i],
      walletHeldRaw: heldByMint.get(a.mint) ?? 0n,
      purchaseAcquiredRaw: 0n,
      priceUsd: a.mint === MAINNET_USDC_MINT ? 1 : (prices.get(a.mint)?.usdPrice ?? null),
    })),
    input.acquiredRawByMint,
  );
  let plan: BuyFundingPlan;
  try {
    plan = planBuyFunding(legInputs);
  } catch (e) {
    throw new BuildBuyError(422, e instanceof Error ? e.message : String(e));
  }
  const feasibility = assessBuyFeasibility({ plan, walletUsdcRaw, walletSolLamports: BigInt(walletSolLamports) });
  if (!feasibility.feasible && !input.mintOnly) {
    throw new BuildBuyError(422, `This purchase can't start yet: ${feasibility.reasons.join("; ")}. Nothing was submitted.`, {
      feasibility: { ...feasibility, requiredUsdcRaw: feasibility.requiredUsdcRaw.toString(), missingUsdcRaw: feasibility.missingUsdcRaw.toString(), missingSolLamports: feasibility.missingSolLamports.toString() },
    });
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
      let r = await deps.jupiterQuote({ ...base, maxAccounts: attemptSingle ? SINGLE_TX_SWAP_MAX_ACCOUNTS : null });
      if (r.kind !== "ok" && attemptSingle) r = await deps.jupiterQuote({ ...base, maxAccounts: null });
      if (r.kind !== "ok") throw jupiterFailure("quote", action.mint, r);
      if (!isPriceImpactAcceptable(r.value)) {
        throw new BuildBuyError(422, `The swap for ${action.mint} has a price impact of ${Number(r.value.priceImpactPct).toFixed(1)}% -- too high to execute automatically; its on-chain liquidity is too thin right now.`, { mint: action.mint });
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
  const altAddresses = buildReserveAltAddresses({
    ssrProgramId,
    reserve: input.reserve,
    reserveTokenMint,
    mintAuthority,
    vaultAuthority: findVaultAuthority(input.reserve, ssrProgramId)[0],
    protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
    assets: orderedAssets.map((a) => ({ mint: a.mint, reserveAsset: a.reserveAsset, vault: a.vault })),
  });
  const recentSlot = reserveAlt ? 0 : await connection.getSlot("finalized");
  const [altCreateIx, wouldBeAlt] = reserveAlt
    ? [null, null]
    : AddressLookupTableProgram.createLookupTable({ authority: wallet, payer: wallet, recentSlot });
  const existingReserveTables = reserveAlt ? await fetchLookupTables(connection, [reserveAlt]) : [];
  const wouldBeTable = wouldBeAlt ? hypotheticalLookupTable(wouldBeAlt, altAddresses) : null;

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
    const instructions = assembleSingleBuyInstructions({
      ataCreateInstructions: ataIxs,
      swapSets: sets.map((s) => ({ setupInstructions: s.setupInstructions, swapInstruction: s.swapInstruction, addressLookupTableAddresses: s.addressLookupTableAddresses })),
      wrapInstructions: wrapIxs,
      mintInstruction: mintIx,
    });
    const swapTables = await fetchLookupTables(connection, sets.flatMap((s) => s.addressLookupTableAddresses));
    single = { instructions, swapTables };
  }
  const mintBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_TX_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
  ];
  const mintFull = [...mintBudgetIxs, ...ataIxs, ...wrapIxs, mintIx];
  const mintLean = [...mintBudgetIxs, ...wrapIxs, mintIx];

  const decision = decideBuyMode({
    attemptedSingle: single !== null,
    singleFitsWithExistingTables: single !== null && fits(wallet, single.instructions, [...existingReserveTables, ...single.swapTables]),
    singleFitsWithWouldBeTable: single !== null && wouldBeTable !== null && fits(wallet, single.instructions, [wouldBeTable, ...single.swapTables]),
    mintFitsWithExistingTables: fits(wallet, mintFull, existingReserveTables) || fits(wallet, mintLean, existingReserveTables),
    mintFitsWithWouldBeTable: wouldBeTable !== null && (fits(wallet, mintFull, [wouldBeTable]) || fits(wallet, mintLean, [wouldBeTable])),
    hasRegisteredAlt: reserveAlt !== null,
  });
  if (decision.mode === "unfit") {
    throw new BuildBuyError(422, `This Reserve's mint references ${mintIx.keys.length} accounts and cannot fit one transaction even with a trading lookup table -- nothing was built.`);
  }

  // ONE fresh blockhash for every transaction, fetched last so it is as young as possible.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const reserveTables = decision.createAlt && wouldBeTable ? [wouldBeTable] : existingReserveTables;
  const transactions: BuiltTransaction[] = [];

  if (decision.createAlt && altCreateIx && wouldBeAlt) {
    const chunks = chunkAltAddresses(altAddresses);
    const createTx = compileV0(wallet, blockhash, [altCreateIx, AddressLookupTableProgram.extendLookupTable({ lookupTable: wouldBeAlt, authority: wallet, payer: wallet, addresses: chunks[0] })], []);
    transactions.push({ kind: "alt-create", ...toBase64(createTx), lastValidBlockHeight });
    for (const chunk of chunks.slice(1)) {
      const extendTx = compileV0(wallet, blockhash, [AddressLookupTableProgram.extendLookupTable({ lookupTable: wouldBeAlt, authority: wallet, payer: wallet, addresses: chunk })], []);
      transactions.push({ kind: "alt-extend", ...toBase64(extendTx), lastValidBlockHeight });
    }
  }

  if (decision.mode === "single" && single) {
    const tx = compileV0(wallet, blockhash, single.instructions, [...reserveTables, ...single.swapTables]);
    if (deps.simulate && !decision.createAlt) {
      // Read-only simulation BEFORE the wallet ever sees it (a doomed
      // transaction costs no approval and no fee). Skipped when the table
      // does not exist yet (it would fail on the missing table, not the purchase).
      const sim = await deps.simulate(tx).catch(() => null);
      if (sim && sim.err) {
        throw new BuildBuyError(422, `${describeOnChainError(new Error(`Transaction failed on-chain (${JSON.stringify(sim.err)}).`))} This was caught by a read-only simulation BEFORE anything was signed or submitted -- nothing moved and no fee was paid.`, { logs: sim.logs ?? [] });
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
      const mintIxs = fits(wallet, mintFull, reserveTables) ? mintFull : mintLean;
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
      walletSolLamports: BigInt(walletSolLamports).toString(),
      walletReserveTokenRaw: walletReserveTokenRaw.toString(),
    },
    reserveAlt,
    altToRegister: decision.createAlt && wouldBeAlt ? wouldBeAlt.toBase58() : null,
    blockhash,
    lastValidBlockHeight,
    generatedAt: new Date().toISOString(),
    timings,
  };
}

/** JSON-safe view of a result (bigint -> string). */
export function serializeBuildBuyResult(r: BuildBuyResult): Record<string, unknown> {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
