// GET/POST /api/mainnet/fee-settlement-cron -- the Mainnet fee keeper.
// Two jobs per run, every discovered Reserve:
//
//   A. USDC FEE SETTLEMENT (the 3-step redeem -> swap -> distribute pipeline,
//      2026-08-21 pass, see docs/project/DECISION_LOG.md): for every Reserve
//      whose shared fee vault holds crystallized mint/seed/TVL fee shares, or
//      that has assets already staged from an earlier run:
//        1. redeemFeeVaultShares -- burns the full current vault balance,
//           stages each asset's proportional entitlement into the Reserve's
//           settlement staging ATAs (created idempotently here first -- the
//           program requires them to exist; live 2026-09-08 every redeem
//           failed preflight with ReserveAssetMismatch until they did).
//        2. For each staged non-USDC asset: ONE atomic transaction
//           [approve_settlement_swap (keeper-signed, bounded to the staged
//           amount) -> SPL transfer of exactly that amount from the staging
//           ATA to the keeper's own ATA, signed by the keeper AS THE DELEGATE
//           the approval just created -> Jupiter swap from the keeper's ATA
//           with the USDC output delivered straight into the Reserve's USDC
//           staging ATA (Jupiter destinationTokenAccount)]. The keeper never
//           holds the asset across a transaction boundary; if the swap
//           fails, the whole transaction fails and the asset stays staged.
//           (Live 2026-09-08: the previous version asked Jupiter to swap from
//           the keeper's EMPTY ATA -- the delegate allowance is on the staging
//           account -- so every settlement swap failed with 0x1789.)
//           A route failure or a quote past the price-impact guard is
//           SKIPPED, not forced -- retried next run.
//        3. distributeFeeUsdc -- pays whatever USDC is staged to the Protocol
//           Treasury and the Reserve's Manager fee recipient(s) (their USDC
//           ATAs created idempotently first). Idempotent.
//      Gated on-chain: SettlementKeeperConfig.keeper must equal this
//      deployment's keeper wallet (set_fee_settlement_keeper, Protocol-Admin
//      signed). Until then the job is reported as waiting.
//
//   B. TVL FEE ACCRUAL: `accrue_fees` is permissionless and is the ONLY thing
//      that crystallizes the annual TVL fee. Called for every Reserve whose
//      accumulator was last settled >= 1 day ago (or never started) -- the
//      program accrues on full elapsed days, so daily calls charge the fee
//      daily (JRA's fee spec, 2026-09-10; was weekly before DEC-0198).
//
//   C. RESERVE TOKEN TRANSFER FEES (DEC-0229): every Reserve Token mint
//      created from DEC-0229 on is Token-2022 with a protocol transfer fee,
//      withheld by Token-2022 in each RECEIVING token account. Once a day
//      (TRANSFER_FEE_COLLECT_UTC_HOUR, or ?collectTransferFees=1), for each
//      such mint: one getProgramAccounts scan finds the accounts holding
//      withheld fees, and collect_transfer_fees harvests them (in chunks)
//      and sweeps the mint's withheld total to the Treasury's Reserve Token
//      account. Permissionless and destination-fixed on-chain, so it needs
//      no keeper role; the keeper only pays fees and the first-use ATA rent.
//      Classic (pre-DEC-0229) Reserves have no fee and are skipped.
//
//   D. BASKET FEED (DEC-0251): for every pool created with liquidity terms v2
//      whose creator shares earnings with holders, collect + distribute the
//      pool's creator fees, then swap whatever the program has released (over
//      24h) into the Reserve's assets at target weights and deposit it in the
//      vaults -- see lib/mainnet/basketFeed.ts. Needs the on-chain keeper role
//      (basket_feed_begin is keeper-signed), same as job A.
//
// Scheduled in vercel.json, allowlisted in middleware.ts CRON_PATHS. Same
// CRON_SECRET / `?dryRun=true` conventions as every other cron here. Time
// budgeted (BUDGET_MS under the 300s maxDuration). DEC-0270: TVL accruals run
// FIRST (cheap, no Jupiter), then settlement, transfer fees and basket feed
// with what is left; anything unprocessed is reported and picked up next run.
// Settlement skips dust (lib/mainnet/keeperDust.ts): legs, USDC and vault
// shares worth too little to move wait and accumulate instead of being
// retried every hour. Every completed run writes a heartbeat that
// api/mainnet/keeper-watchdog.ts checks; a run that throws pages at once.
// Jupiter goes through lib/mainnet/jupiter.ts (shared venue exclusions,
// retry policy, JUPITER_API_BASE override for the test site).
//
// The keeper wallet is a dedicated secret (SSR_FEE_SETTLEMENT_KEEPER_SECRET,
// JSON array or base64). Its SOL only pays transaction fees + first-use rent.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
// DEC-0201: a Reserve may hold Token-2022 assets, whose ATAs derive under a
// different program. Deriving them classically would point the keeper at
// accounts that can never hold the asset, so every ASSET-side address here
// goes through the asset's own program. USDC is always classic; the
// Reserve Token is classic before DEC-0229 and Token-2022 after (DEC-0229).
import { assetAta, resolveLegTokenProgram } from "@ssr/sdk";
import {
  discoverAllReserves,
  enumerateReserveAssetMintsOnChain,
  registerDynamicSupportedAssetMints,
  fetchFeeSettlement,
  fetchSettlementKeeperConfig,
  fetchProtocolConfig,
  findSettlementAuthority,
  findManagerFeeRecipients,
  findMintAuthority,
  findProtocolConfig,
  findTvlAccrual,
  findFeeSettlement,
  findFeeVaultAuthority,
  findFeeVaultAta,
  buildReadOnlyProgram,
  buildRedeemFeeVaultSharesInstruction,
  buildApproveSettlementSwapInstruction,
  buildDistributeFeeUsdcInstruction,
  buildCollectTransferFeesInstruction,
  findWithheldFeeAccounts,
  fetchReserveTokenTransferFee,
  MAX_HARVEST_SOURCES_PER_TX,
  buildCollectTradeTax,
  decodeTradeTax,
  findTradeTax,
  MAX_TRADE_TAX_HARVEST_SOURCES,
} from "@ssr/sdk";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl } from "./_lib/rpc";
import { getSql } from "../../lib/ledger/db";
import { lookupReserveAlt } from "./build-buy";
import { readReserveAndWallet, compileV0, fitsV0, CORE_TX_COMPUTE_UNIT_LIMIT, MAINNET_TREASURY_VAULT } from "../../lib/mainnet/buildCommon";
import { DEFAULT_SLIPPAGE_BPS, MAINNET_USDC_MINT as USDC_MINT_STR, MAX_PRICE_IMPACT_PCT, buildJupiterSwapInstructionsWithRetry, fetchJupiterQuoteWithRetry, isPriceImpactAcceptable } from "../../lib/mainnet/jupiter";
import { deserializeJupiterInstruction, fetchLookupTables, isComputeBudgetInstruction, SINGLE_TX_MICRO_LAMPORTS_PER_CU } from "../../src/merge/lib/singleTxBuy";
import { sendAndConfirmWithRebroadcast } from "../../src/merge/lib/rpcResilience";
import { findSharingPools, runBasketFeedForPool, type BasketFeedResult } from "../../lib/mainnet/basketFeed";
import { fetchJupiterPrices } from "./asset-prices";
import { recordAlert, siteLabel } from "../../lib/ops-alerts/alerts";
import { isTransientRpcError, KEEPER_LOW_SOL } from "../../lib/ops-alerts/alertsPure";
import { writeKeeperHeartbeat } from "../../lib/ops-alerts/keeperHeartbeat";
import { navPerReserveTokenUsd, stagedLegDecision, stagedUsdcWorthDistributing, vaultDecision, type DustDecision } from "../../lib/mainnet/keeperDust";

const RPC_URL = resolveRpcUrl();
const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const MAINNET_USDC_MINT = new PublicKey(USDC_MINT_STR);
const TREASURY = new PublicKey(MAINNET_TREASURY_VAULT);

// Under this route's own maxDuration (vercel.json: 300s for fee-settlement-cron;
// each Reserve needs several sequential confirmations, ~20-60s). DEC-0270: 240s
// leaves room for one in-flight confirmation, the alerts and the heartbeat.
const BUDGET_MS = 240_000;
/** DEC-0270: accrue_fees calls in flight at once (each is one small permissionless transaction). */
const ACCRUAL_CONCURRENCY = 4;
const ACCRUE_MIN_ELAPSED_S = 24 * 60 * 60;
/** Job C runs on the hourly cron's run in this UTC hour only (one scan per fee-carrying mint per day). */
const TRANSFER_FEE_COLLECT_UTC_HOUR = 0;
const MAX_KNOWN_MINTS = 2000;

/** Per-route runtime config (Vercel reads this export): settlement needs several sequential confirmations per Reserve, ~20-60s each Reserve. */
export const config = { maxDuration: 300 };

/** Pure: same price-impact ceiling as every other Mainnet swap (lib/mainnet/jupiter.ts). A non-finite value (malformed Jupiter response) is NEVER accepted. A `false` leaves the staged asset exactly where it is. */
export function isQuoteSafeToExecute(priceImpactPct: number): boolean {
  return Number.isFinite(priceImpactPct) && priceImpactPct <= MAX_PRICE_IMPACT_PCT;
}

/**
 * Pure: whether an `accrue_fees` call for this Reserve can do anything at all.
 * The program returns before touching `last_settled_ts` when the accumulator
 * has nothing to bill (`period_supply_seconds == 0`), which is permanently the
 * case for a Reserve with zero Reserve Token supply (never seeded, still
 * `assetsInitializing`). Such a Reserve therefore stays "due" forever and
 * every hourly call is a paid no-op (5,000 lamports). Live 2026-09-08 ..
 * 2026-09-25: 14 unseeded Reserves x 24 calls/day drained the keeper's 0.05 SOL
 * and every settlement stopped for a week (DEC-0221). Only an Active Reserve
 * with a nonzero supply is worth a transaction.
 */
export function isAccrualWorthSending(r: { status: string; reserveTokenSupplyRaw: string }): boolean {
  if (r.status !== "active") return false;
  try {
    return BigInt(r.reserveTokenSupplyRaw) > 0n;
  } catch {
    return false;
  }
}

function loadKeeperKeypair(): Keypair {
  const raw = process.env.SSR_FEE_SETTLEMENT_KEEPER_SECRET;
  if (!raw) throw new Error("SSR_FEE_SETTLEMENT_KEEPER_SECRET is not configured on this deployment.");
  const parsed: number[] = raw.trim().startsWith("[") ? JSON.parse(raw) : Array.from(Buffer.from(raw, "base64"));
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function getHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function loadKnownAssetMints(): Promise<string[]> {
  const sql = getSql();
  const rows = (await sql`
    select distinct reserve_asset_mint as mint
    from ledger_events
    where cluster = 'mainnet-beta'
      and reserve_asset_mint is not null
      and status = 'confirmed'
    limit ${MAX_KNOWN_MINTS}
  `) as { mint: string }[];
  return rows.map((r) => r.mint);
}

/** DEC-0270: USD prices for the dust rules, 50 mints per Jupiter Price request, a few retries on a rate-limited or failed call. A mint left out is "unpriced". */
async function fetchUsdPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>([[USDC_MINT_STR, 1]]);
  const wanted = [...new Set(mints)].filter((m) => m !== USDC_MINT_STR);
  for (let i = 0; i < wanted.length; i += 50) {
    const chunk = wanted.slice(i, i + 50);
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await fetchJupiterPrices(chunk).catch(() => new Map());
      for (const [mint, p] of got) if (typeof p.usdPrice === "number") out.set(mint, p.usdPrice);
      if (got.size > 0) break;
      await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
    }
  }
  return out;
}

/** Compile a v0 transaction for the keeper, simulate it read-only (throwing with the program logs on failure), sign, send, confirm, and verify the on-chain status. */
async function sendV0(connection: Connection, keeper: Keypair, label: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = compileV0(keeper.publicKey, blockhash, ixs, tables);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => /Error|failed|Instruction:/.test(l)).slice(-6).join(" | ");
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)} -- ${logs}`);
  }
  tx.sign([keeper]);
  // Re-broadcast until it lands (live 2026-09-08: a simulated-OK settlement swap
  // sent once was dropped and "not found after confirmation window").
  const { signature, outcome } = await sendAndConfirmWithRebroadcast(connection, tx.serialize(), lastValidBlockHeight);
  if (outcome.status === "failed") throw new Error(`${label}: transaction ${signature} failed on-chain ${outcome.error}.`);
  if (outcome.status === "expired") throw new Error(`${label}: transaction ${signature} expired before it was included.`);
  if (outcome.status !== "confirmed") throw new Error(`${label}: transaction ${signature} could not be confirmed in time (status unknown).`);
  return signature;
}

const budgetIxs = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
];

interface AssetSettlementResult {
  mint: string;
  stagedAmount: string;
  status: "swapped" | "skipped-price-impact" | "skipped-no-route" | "skipped-error" | "skipped-dust" | "skipped-unpriced";
  detail?: string;
  swapSignature?: string;
  /** When the atomic composition did not fit one transaction, the delegate-transfer went in its own transaction first. */
  transferSignature?: string;
}

interface ReserveSettlementResult {
  reserve: string;
  redeemSignature?: string;
  redeemedShares?: string;
  assets: AssetSettlementResult[];
  distributeSignature?: string;
  /** DEC-0221: set instead of distributeSignature when the staging account held no USDC (no transaction sent). */
  distributeSkipped?: string;
  error?: string;
}

interface AccrualResult {
  reserveId: string;
  reserve: string;
  elapsedDays: string;
  signature?: string;
  error?: string;
}

interface TransferFeeCollectResult {
  reserveId: string;
  reserve: string;
  harvestedAccounts: number;
  /** Withheld fees found (accounts + mint) before collecting, raw Reserve Token units. */
  withheldRaw: string;
  signatures: string[];
  error?: string;
}

async function runKeeper(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const dryRun = req.query?.dryRun === "true" || req.query?.dryRun === "1";
  const forceTransferFees = req.query?.collectTransferFees === "true" || req.query?.collectTransferFees === "1";

  if (!dryRun) {
    const expected = process.env.CRON_SECRET;
    const provided = getHeader(req, "authorization");
    if (!expected) {
      res.status(500).json({ error: "CRON_SECRET is not configured on this deployment." });
      return;
    }
    if (provided !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
  }

  const startedAt = Date.now();
  const deadline = startedAt + BUDGET_MS;
  const connection = new Connection(RPC_URL, "confirmed");

  let keeper: Keypair | null = null;
  let keeperEnvError: string | null = null;
  try {
    keeper = loadKeeperKeypair();
  } catch (e) {
    keeperEnvError = e instanceof Error ? e.message : String(e);
  }
  const keeperSolBalance = keeper ? await connection.getBalance(keeper.publicKey).catch(() => null) : null;

  const keeperConfig = await fetchSettlementKeeperConfig(connection, PROGRAM_ID).catch(() => null);
  const keeperMatchesOnChain = !!(keeper && keeperConfig && keeper.publicKey.toBase58() === keeperConfig.keeper);

  const protocolConfig = await fetchProtocolConfig(connection, PROGRAM_ID);
  if (!protocolConfig) {
    res.status(500).json({ error: "ProtocolConfig not found." });
    return;
  }
  const protocolFeeDestination = new PublicKey(protocolConfig.defaultProtocolFeeDestination);
  if (!protocolFeeDestination.equals(TREASURY)) {
    res.status(500).json({ error: "protocolConfig.defaultProtocolFeeDestination does not match the official Treasury vault -- refusing to settle." });
    return;
  }

  const [ledgerMints, onChainMints] = await Promise.all([
    loadKnownAssetMints().catch(() => [] as string[]),
    enumerateReserveAssetMintsOnChain(connection).catch(() => [] as string[]),
  ]);
  const knownMints = [...new Set([...ledgerMints, ...onChainMints])];
  registerDynamicSupportedAssetMints(knownMints);
  const candidateAssetMints = [MAINNET_USDC_MINT, ...knownMints.filter((m) => m !== USDC_MINT_STR).map((m) => new PublicKey(m))];

  const { reserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints).catch((e) => {
    throw new Error(`Failed to discover Reserves: ${e instanceof Error ? e.message : String(e)}`);
  });

  // --- Job A candidates: anything in the fee vault, pending, or staged. ---
  const candidates: { reserve: string; reserveTokenMint: string; assetsResolved: boolean; feeSettlement: Awaited<ReturnType<typeof fetchFeeSettlement>>; staged: { mint: string; amount: string }[]; keeperHeld: boolean }[] = [];
  for (const r of reserves) {
    const feeSettlement = await fetchFeeSettlement(connection, PROGRAM_ID, new PublicKey(r.reserve)).catch(() => null);
    if (!feeSettlement) continue;
    const vaultTotal = BigInt(feeSettlement.protocolSharesInVault) + BigInt(feeSettlement.managerSharesInVault);
    const pendingTotal = BigInt(feeSettlement.protocolSharesPendingSettlement) + BigInt(feeSettlement.managerSharesPendingSettlement);
    // Staged (or keeper-held) asset balances are checked for EVERY Reserve, not
    // only those with vault/pending shares: distribute_fee_usdc zeroes the
    // pending accounting even when a leg's swap was skipped, so the real tokens
    // left in that staging ATA would otherwise never be looked at again (live
    // 2026-09-08: two skipped legs vanished from the candidate list).
    const [sa] = findSettlementAuthority(new PublicKey(r.reserve), PROGRAM_ID);
    const mintPrograms = [...r.assets.map((a) => resolveLegTokenProgram({ tokenProgram: a.tokenProgram ?? null })), TOKEN_PROGRAM_ID];
    const mints = [...r.assets.map((a) => new PublicKey(a.assetMint)), MAINNET_USDC_MINT];
    const stagingAtas = mints.map((m, i) => assetAta(m, sa, mintPrograms[i], true));
    const keeperAtas = keeper ? mints.map((m, i) => assetAta(m, keeper.publicKey, mintPrograms[i])) : [];
    const [infos, keeperInfos] = await Promise.all([
      connection.getMultipleAccountsInfo(stagingAtas).catch(() => stagingAtas.map(() => null)),
      keeperAtas.length ? connection.getMultipleAccountsInfo(keeperAtas).catch(() => keeperAtas.map(() => null)) : Promise.resolve([] as (null | { data: Buffer })[]),
    ]);
    const staged: { mint: string; amount: string }[] = [];
    let keeperHeldAny = false;
    mints.forEach((m, i) => {
      const info = infos[i];
      const amount = info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
      if (amount > 0n) staged.push({ mint: m.toBase58(), amount: amount.toString() });
      const k = keeperInfos[i];
      if (m.toBase58() !== USDC_MINT_STR && k && k.data.length >= 72 && k.data.readBigUInt64LE(64) > 0n) keeperHeldAny = true;
    });
    if (vaultTotal === 0n && pendingTotal === 0n && staged.length === 0 && !keeperHeldAny) continue;
    candidates.push({ reserve: r.reserve, reserveTokenMint: r.reserveTokenMint, assetsResolved: r.resolvedAssetCount === r.assetCount, feeSettlement, staged, keeperHeld: keeperHeldAny });
  }

  // --- Job B candidates: accrual overdue, judged by the accumulator itself (see DEC-0186/0192). ---
  const nowS = Math.floor(Date.now() / 1000);
  const readOnly = buildReadOnlyProgram(connection) as any;
  const tvlAccrualAddrs = reserves.map((r) => findTvlAccrual(new PublicKey(r.reserve), PROGRAM_ID)[0]);
  const tvlAccruals: ({ lastSettledTs: { toString(): string } } | null)[] = await readOnly.account.tvlAccrual
    .fetchMultiple(tvlAccrualAddrs)
    .catch(() => reserves.map(() => null));
  const accrueDue = reserves
    .map((r, i) => {
      const acc = tvlAccruals[i];
      const lastSettled = acc ? Number(acc.lastSettledTs.toString()) : null;
      const elapsedS = lastSettled === null ? null : nowS - lastSettled;
      return {
        reserveId: r.reserveId,
        reserve: r.reserve,
        reserveTokenMint: r.reserveTokenMint,
        reserveTokenProgram: r.reserveTokenProgram,
        status: r.status,
        reserveTokenSupplyRaw: r.reserveTokenSupplyRaw,
        accumulatorInitialized: lastSettled !== null,
        elapsedDays: elapsedS === null ? "clock not started" : (elapsedS / 86400).toFixed(2),
        due: lastSettled === null || (elapsedS as number) >= ACCRUE_MIN_ELAPSED_S,
      };
    })
    // DEC-0221: a due-but-unbillable Reserve (no supply) would be a paid no-op every hour, forever.
    .filter((r) => r.due && isAccrualWorthSending(r));

  // --- Job C candidates (DEC-0229): Token-2022 Reserve Tokens carry the transfer fee. ---
  const transferFeeReserves = reserves.filter((r) => r.reserveTokenProgram === "token-2022");
  const transferFeeDue = forceTransferFees || new Date(startedAt).getUTCHours() === TRANSFER_FEE_COLLECT_UTC_HOUR;

  // --- DEC-0270: dust plan for Job A. One price read for every asset the candidates hold. ---
  const utcHour = new Date(startedAt).getUTCHours();
  const reserveByAddr = new Map(reserves.map((r) => [r.reserve, r]));
  const prices = candidates.length ? await fetchUsdPrices(candidates.flatMap((c) => reserveByAddr.get(c.reserve)?.assets.map((a) => a.assetMint) ?? [])) : new Map<string, number>();
  const settlementPlan = candidates.map((c) => {
    const r = reserveByAddr.get(c.reserve);
    const decimalsOf = new Map((r?.assets ?? []).map((a) => [a.assetMint, a.decimals]));
    const vaultShares = BigInt(c.feeSettlement.protocolSharesInVault) + BigInt(c.feeSettlement.managerSharesInVault);
    const nav = r ? navPerReserveTokenUsd(r.assets, r.reserveTokenSupplyRaw, (m) => prices.get(m)) : null;
    const vault: DustDecision = vaultDecision(vaultShares, nav, utcHour);
    // Staging lists USDC once per leg that is USDC plus the appended USDC staging account (same account): count it once.
    const usdcStaged = c.staged.find((s) => s.mint === USDC_MINT_STR);
    const usdc = usdcStaged && stagedUsdcWorthDistributing(BigInt(usdcStaged.amount)) ? "move" : "dust";
    const legs = c.staged
      .filter((s) => s.mint !== USDC_MINT_STR)
      .map((s) => ({ mint: s.mint, amount: s.amount, decision: stagedLegDecision(BigInt(s.amount), decimalsOf.get(s.mint) ?? 0, prices.get(s.mint), utcHour) }));
    // Keeper-held legs (left by a split approve+transfer whose swap failed) are always worked: that asset sits outside the Reserve.
    const actionable = vault === "move" || usdc === "move" || legs.some((l) => l.decision === "move") || c.keeperHeld;
    return { reserve: c.reserve, vault, usdc, legs, actionable };
  });
  const dustSkipped = settlementPlan.filter((p) => !p.actionable);
  const planOf = new Map(settlementPlan.map((p) => [p.reserve, p]));

  // --- Job D candidates (DEC-0251): v2 pools whose creator shares earnings with holders. ---
  const sharingPools = await findSharingPools(connection, PROGRAM_ID).catch(() => [] as Awaited<ReturnType<typeof findSharingPools>>);

  const status = {
    keeperWallet: keeper ? keeper.publicKey.toBase58() : null,
    keeperEnvError,
    keeperSolBalance: keeperSolBalance === null ? null : keeperSolBalance / 1e9,
    onChainKeeper: keeperConfig?.keeper ?? null,
    settlementEnabled: keeperMatchesOnChain,
    settlementBlockedBy: keeperMatchesOnChain
      ? null
      : !keeper
        ? "keeper wallet not configured in env"
        : !keeperConfig
          ? "SettlementKeeperConfig not set on-chain yet -- a Protocol Admin must sign set_fee_settlement_keeper (see /internal/set-keeper)"
          : "on-chain keeper differs from this deployment's keeper wallet",
    totalReserves: reserves.length,
    reservesWithSomethingToSettle: candidates.length,
    reservesWaitingAsDust: dustSkipped.length,
    accrualsDue: accrueDue.length,
    transferFeeReserves: transferFeeReserves.length,
    transferFeeCollectionDue: transferFeeDue,
    basketFeedPools: sharingPools.length,
  };

  if (dryRun) {
    res.status(200).json({
      dryRun: true,
      basketFeed: sharingPools.map((p) => ({ reserve: p.terms.reserve.toBase58(), holderShareBps: p.terms.holderShareBps, lockedRaw: p.terms.locked.toString(), unlockedRaw: p.terms.unlocked.toString(), totalFedRaw: p.terms.totalFed.toString() })),
      ...status,
      candidates: candidates.map((c) => ({ reserve: c.reserve, assetsResolved: c.assetsResolved, feeSettlement: c.feeSettlement, staged: c.staged })),
      settlementPlan,
      accrueDue,
      transferFeeReserves: transferFeeReserves.map((r) => ({ reserveId: r.reserveId, reserve: r.reserve, reserveTokenMint: r.reserveTokenMint })),
    });
    return;
  }

  // DEC-0261: page the team when the keeper cannot run or is about to run dry (at most every 6 hours each).
  if (!keeperMatchesOnChain) await recordAlert({ source: "keeper", step: "keeper-config", message: status.settlementBlockedBy ?? keeperEnvError ?? "Keeper not running." }, { quietMinutes: 360 });
  if (status.keeperSolBalance !== null && status.keeperSolBalance < KEEPER_LOW_SOL) {
    await recordAlert({ source: "keeper", step: "keeper-balance", message: `Keeper has ${status.keeperSolBalance.toFixed(4)} SOL (alert below ${KEEPER_LOW_SOL}). Top it up or settlement stops.`, wallet: status.keeperWallet }, { quietMinutes: 360 });
  }
  // Command center burn rate: one balance sample per run (lib/command-center/balances.ts
  // owns the table and reads it). Inlined on purpose: lib/command-center is an ES module
  // folder this CommonJS function cannot load (that import crashed the 12:15 run on
  // 2026-10-28). Never fails settlement and waits at most 3 s.
  if (keeper && status.keeperSolBalance !== null) {
    const sol = status.keeperSolBalance;
    const wallet = keeper.publicKey.toBase58();
    const sample = Promise.resolve().then(() => getSql()`INSERT INTO command_center_balances (wallet, sol)
      SELECT ${wallet}, ${sol} WHERE NOT EXISTS (
        SELECT 1 FROM command_center_balances WHERE wallet = ${wallet} AND at > now() - interval '50 minutes')`).catch(() => undefined);
    await Promise.race([sample, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
  if (!keeper) {
    res.status(500).json({ error: keeperEnvError ?? "Keeper wallet not configured." });
    return;
  }
  const apiKey = process.env.JUPITER_API_KEY ?? "";
  const program = readOnly;
  const deps = { connection, program, ssrProgramId: PROGRAM_ID, lookupReserveAlt };

  // ---------------------------------------------------------------------
  // Job B: TVL accrual FIRST (DEC-0270; permissionless, keeper pays). Cheap and
  // Jupiter-free, so settlement retries can no longer starve it (Reserve 61 went
  // 41 h without an accrual on 2026-10-28 while settlement used the budget).
  // ---------------------------------------------------------------------
  const accruals: AccrualResult[] = [];
  const accrualsSkippedForBudget: string[] = [];
  const protocolConfigAddress = findProtocolConfig(PROGRAM_ID)[0];
  const accrueOne = async (r: (typeof accrueDue)[number]) => {
    if (Date.now() > deadline) {
      accrualsSkippedForBudget.push(r.reserve);
      return;
    }
    try {
      const reservePk = new PublicKey(r.reserve);
      const reserveTokenMintPk = new PublicKey(r.reserveTokenMint);
      // DEC-0229: classic for pre-DEC-0229 Reserves, Token-2022 after (from discovery's mint read).
      const reserveTokenProgram = r.reserveTokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const ix = await program.methods
        .accrueFees()
        .accounts({
          protocolConfig: protocolConfigAddress,
          reserve: reservePk,
          reserveTokenMint: reserveTokenMintPk,
          mintAuthority: findMintAuthority(reservePk, PROGRAM_ID)[0],
          tvlAccrual: findTvlAccrual(reservePk, PROGRAM_ID)[0],
          feeSettlement: findFeeSettlement(reservePk, PROGRAM_ID)[0],
          feeVault: findFeeVaultAta(reservePk, reserveTokenMintPk, PROGRAM_ID, reserveTokenProgram),
          feeVaultAuthority: findFeeVaultAuthority(reservePk, PROGRAM_ID)[0],
          payer: keeper.publicKey,
          tokenProgram: reserveTokenProgram,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      // DEPLOYED-PROGRAM BUG (DEC-0192): AccrueFees declares reserve_token_mint
      // without `mut`; the mint_to CPI needs it writable. Passing it writable
      // from here is the complete fix against the deployed binary.
      for (const k of ix.keys) if (k.pubkey.equals(reserveTokenMintPk)) k.isWritable = true;
      const tx = new Transaction().add(ix);
      tx.feePayer = keeper.publicKey;
      const signature = await sendAndConfirmTransaction(connection, tx, [keeper], { commitment: "confirmed" });
      accruals.push({ reserveId: r.reserveId, reserve: r.reserve, elapsedDays: r.elapsedDays, signature });
    } catch (e) {
      accruals.push({ reserveId: r.reserveId, reserve: r.reserve, elapsedDays: r.elapsedDays, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const accrualQueue = [...accrueDue];
  await Promise.all(Array.from({ length: Math.min(ACCRUAL_CONCURRENCY, accrualQueue.length) }, async () => {
    for (let r = accrualQueue.shift(); r; r = accrualQueue.shift()) await accrueOne(r);
  }));

  // ---------------------------------------------------------------------
  // Job A: settlement (only when the on-chain keeper is THIS wallet).
  // ---------------------------------------------------------------------
  const results: ReserveSettlementResult[] = [];
  const skippedForBudget: string[] = [];
  if (keeperMatchesOnChain) {
    // DEC-0270: a Reserve with only dust to move waits (listed in dustSkipped).
    for (const c of candidates.filter((c) => planOf.get(c.reserve)?.actionable)) {
      if (Date.now() > deadline) {
        skippedForBudget.push(c.reserve);
        continue;
      }
      const result: ReserveSettlementResult = { reserve: c.reserve, assets: [] };
      try {
        if (!c.assetsResolved) throw new Error("Not every asset leg resolved in discovery -- refusing to redeem against an incomplete asset list.");
        const reservePk = new PublicKey(c.reserve);
        const read = await readReserveAndWallet(deps, reservePk, keeper.publicKey, null);
        const legs = read.orderedAssets;
        const [settlementAuthority] = findSettlementAuthority(reservePk, PROGRAM_ID);
        const programOfMint = new Map(legs.map((l) => [l.mint, resolveLegTokenProgram(l)]));
        const programFor = (mint: PublicKey) => programOfMint.get(mint.toBase58()) ?? TOKEN_PROGRAM_ID;
        const stagingAtaOf = (mint: PublicKey) => assetAta(mint, settlementAuthority, programFor(mint), true);
        const usdcStaging = stagingAtaOf(MAINNET_USDC_MINT);
        const reserveTables = read.reserveAlt ? await fetchLookupTables(connection, [read.reserveAlt]) : [];
        const createStagingIxs = [
          ...legs.map((l) => createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, stagingAtaOf(new PublicKey(l.mint)), settlementAuthority, new PublicKey(l.mint), resolveLegTokenProgram(l))),
          createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, usdcStaging, settlementAuthority, MAINNET_USDC_MINT),
        ];

        // Step 1: redeem the full current vault balance (if any, and worth moving -- DEC-0270).
        const vaultTotal = BigInt(c.feeSettlement.protocolSharesInVault) + BigInt(c.feeSettlement.managerSharesInVault);
        if (vaultTotal > 0n && planOf.get(c.reserve)?.vault === "move") {
          const redeemIx = await buildRedeemFeeVaultSharesInstruction({
            program,
            programId: PROGRAM_ID,
            reserve: reservePk,
            reserveTokenMint: read.reserveTokenMint,
            reserveTokenProgram: read.reserveTokenProgram,
            vaultAuthority: read.vaultAuthority,
            payer: keeper.publicKey,
            assets: legs,
            shares: vaultTotal,
          });
          // Staging ATA creations go in their own transaction(s) whenever there are
          // more than a few: the redeem itself CPIs once per asset, and N ATA
          // creations (each a CPI into the ATA program + system + token) in the same
          // transaction hit MaxInstructionTraceLengthExceeded on the 10-asset
          // Reserve (live 2026-09-08). Only the ones that don't exist yet are sent.
          const stagingInfosNow = await connection.getMultipleAccountsInfo([...legs.map((l) => stagingAtaOf(new PublicKey(l.mint))), usdcStaging]);
          const missingCreates = createStagingIxs.filter((_, i) => !stagingInfosNow[i]);
          let ixs = [...budgetIxs(CORE_TX_COMPUTE_UNIT_LIMIT), ...missingCreates, redeemIx];
          if (missingCreates.length > 3 || !fitsV0(keeper.publicKey, ixs, reserveTables)) {
            for (let i = 0; i < missingCreates.length; i += 6) {
              await sendV0(connection, keeper, "create staging ATAs", [...budgetIxs(200_000), ...missingCreates.slice(i, i + 6)], []);
            }
            ixs = [...budgetIxs(CORE_TX_COMPUTE_UNIT_LIMIT), redeemIx];
            if (!fitsV0(keeper.publicKey, ixs, reserveTables)) throw new Error(`redeem_fee_vault_shares does not fit one transaction for this ${legs.length}-asset Reserve${read.reserveAlt ? " even with its lookup table" : " (no lookup table registered)"}.`);
          }
          result.redeemSignature = await sendV0(connection, keeper, "redeem_fee_vault_shares", ixs, reserveTables);
          result.redeemedShares = vaultTotal.toString();
        }

        // Step 2: one atomic [approve -> delegate transfer -> swap -> USDC to staging] per staged non-USDC asset.
        // Also sweeps any of the asset already sitting in the KEEPER's own ATA
        // (left there when a split approve+transfer landed but its swap did not):
        // that balance is swapped too, straight into the USDC staging ATA.
        const stagingAtas = legs.map((l) => stagingAtaOf(new PublicKey(l.mint)));
        const keeperAtas = legs.map((l) => assetAta(new PublicKey(l.mint), keeper.publicKey, resolveLegTokenProgram(l)));
        const [stagedInfos, keeperInfos] = await Promise.all([connection.getMultipleAccountsInfo(stagingAtas), connection.getMultipleAccountsInfo(keeperAtas)]);
        const amountOf = (info: { data: Buffer } | null) => (info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n);
        for (let i = 0; i < legs.length; i++) {
          if (Date.now() > deadline) break;
          const leg = legs[i];
          if (leg.mint === USDC_MINT_STR) continue;
          const stagedAmount = amountOf(stagedInfos[i]);
          const keeperHeld = amountOf(keeperInfos[i]);
          const toSwap = stagedAmount + keeperHeld;
          if (toSwap === 0n) continue;
          // DEC-0270: dust waits and accumulates; an unpriced leg is tried once a day. Keeper-held legs always move.
          const dust = keeperHeld > 0n ? "move" : stagedLegDecision(toSwap, leg.decimals, prices.get(leg.mint), utcHour);
          if (dust !== "move") {
            result.assets.push({ mint: leg.mint, stagedAmount: stagedAmount.toString(), status: dust === "dust" ? "skipped-dust" : "skipped-unpriced" });
            continue;
          }
          const mint = new PublicKey(leg.mint);
          const assetResult: AssetSettlementResult = { mint: leg.mint, stagedAmount: stagedAmount.toString(), status: "skipped-no-route", ...(keeperHeld > 0n ? { detail: `includes ${keeperHeld.toString()} already held by the keeper from an earlier partial run` } : {}) };
          try {
            const quoteR = await fetchJupiterQuoteWithRetry({ inputMint: leg.mint, outputMint: USDC_MINT_STR, amount: toSwap, slippageBps: DEFAULT_SLIPPAGE_BPS, maxAccounts: null, apiKey });
            if (quoteR.kind !== "ok") {
              assetResult.detail = quoteR.kind === "specific-error" ? quoteR.message : `Quote request exhausted retries (last status ${quoteR.lastStatus}).`;
            } else if (!isPriceImpactAcceptable(quoteR.value)) {
              assetResult.status = "skipped-price-impact";
              assetResult.detail = `Price impact ${Number(quoteR.value.priceImpactPct).toFixed(2)}% exceeds the safety ceiling.`;
            } else {
              const builtR = await buildJupiterSwapInstructionsWithRetry({ quote: quoteR.value, userPublicKey: keeper.publicKey.toBase58(), apiKey, destinationTokenAccount: usdcStaging.toBase58() });
              if (builtR.kind !== "ok") {
                assetResult.status = "skipped-error";
                assetResult.detail = builtR.kind === "specific-error" ? builtR.message : `Swap build exhausted retries (last status ${builtR.lastStatus}).`;
              } else {
                const built = builtR.value;
                const keeperAta = keeperAtas[i];
                // DEC-0201: every asset-side account and CPI uses the asset's
                // own token program, so a Token-2022 asset settles identically.
                const legProgram = resolveLegTokenProgram(leg);
                const prelude: TransactionInstruction[] = [
                  createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperAta, keeper.publicKey, mint, legProgram),
                  createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, usdcStaging, settlementAuthority, MAINNET_USDC_MINT),
                ];
                if (stagedAmount > 0n) {
                  prelude.unshift(await buildApproveSettlementSwapInstruction({ program, programId: PROGRAM_ID, reserve: reservePk, assetMint: mint, keeper: keeper.publicKey, amount: stagedAmount, assetTokenProgram: legProgram }));
                  // The keeper signs as the SPL DELEGATE the approval above just created -- bounded to exactly stagedAmount.
                  // TransferChecked (not Transfer): Token-2022 requires the
                  // mint and decimals, and it is strictly safer on classic too.
                  prelude.push(createTransferCheckedInstruction(stagingAtaOf(mint), mint, keeperAta, keeper.publicKey, stagedAmount, leg.decimals, [], legProgram));
                }
                const swapIxs = [
                  ...built.setupInstructions.map(deserializeJupiterInstruction).filter((ix) => !isComputeBudgetInstruction(ix)),
                  deserializeJupiterInstruction(built.swapInstruction),
                ];
                const jupTables = await fetchLookupTables(connection, built.addressLookupTableAddresses);
                const atomic = [...budgetIxs(CORE_TX_COMPUTE_UNIT_LIMIT), ...prelude, ...swapIxs];
                if (fitsV0(keeper.publicKey, atomic, jupTables)) {
                  assetResult.swapSignature = await sendV0(connection, keeper, `settle ${leg.mint.slice(0, 6)} (atomic)`, atomic, jupTables);
                } else {
                  // Too large for one transaction: the bounded delegate transfer first, then the swap. The keeper holds the
                  // asset only between these two sends; a failed swap leaves it in the keeper ATA, retried by the next run
                  // (the staged amount check below then reads 0 -- operators reconcile keeper ATAs via the dry-run report).
                  assetResult.transferSignature = await sendV0(connection, keeper, `settle ${leg.mint.slice(0, 6)} (approve+transfer)`, [...budgetIxs(200_000), ...prelude], []);
                  assetResult.swapSignature = await sendV0(connection, keeper, `settle ${leg.mint.slice(0, 6)} (swap)`, [...budgetIxs(CORE_TX_COMPUTE_UNIT_LIMIT), ...swapIxs], jupTables);
                }
                assetResult.status = "swapped";
              }
            }
          } catch (e) {
            assetResult.status = "skipped-error";
            assetResult.detail = e instanceof Error ? e.message : String(e);
          }
          result.assets.push(assetResult);
        }

        // Step 3: distribute whatever USDC is now staged. The instruction is an
        // idempotent no-op on an empty staging account, but a no-op still costs the
        // keeper the base fee plus the priority fee on the full compute budget
        // (~65,000 lamports) -- live 12:15 UTC 2026-10-02, 8 of 10 distributes moved
        // nothing (DEC-0221). Read the real balance first and skip when it is zero.
        const stagedUsdcInfo = await connection.getAccountInfo(usdcStaging);
        const stagedUsdc = stagedUsdcInfo && stagedUsdcInfo.data.length >= 72 ? stagedUsdcInfo.data.readBigUInt64LE(64) : 0n;
        if (!stagedUsdcWorthDistributing(stagedUsdc)) {
          result.distributeSkipped = stagedUsdc === 0n ? "no USDC staged" : `dust: ${stagedUsdc.toString()} raw USDC staged, waits until worth a transaction`;
          results.push(result);
          continue;
        }
        // DEC-0262: a few September Reserves have a FeeSettlement account that was
        // never filled in (reserve and bump all zero), so distribute fails its seeds
        // check every run (live 17:15 UTC 2026-10-26, Reserve …cWD7z, 0.00009 USDC).
        // Nothing can settle there; skip instead of failing (and alerting) hourly.
        const feeSettlementInfo = await connection.getAccountInfo(findFeeSettlement(reservePk, PROGRAM_ID)[0]);
        if (!feeSettlementInfo || !feeSettlementInfo.data.subarray(9, 41).equals(reservePk.toBuffer())) {
          result.distributeSkipped = "FeeSettlement account not linked to this Reserve (legacy, cannot settle)";
          results.push(result);
          continue;
        }
        const [managerFeeRecipientsAddr] = findManagerFeeRecipients(reservePk, PROGRAM_ID);
        const recipientsAccount = await program.account.managerFeeRecipients.fetchNullable(managerFeeRecipientsAddr);
        const managerRecipients = recipientsAccount
          ? (recipientsAccount.recipients as any[]).slice(0, recipientsAccount.recipientCount).map((r) => ({ wallet: r.wallet.toBase58() }))
          : [];
        const legacyManagerDestination: PublicKey | undefined = recipientsAccount ? undefined : (read.reserveAccount.feeConfig.feeDestination as PublicKey);
        const recipientWallets = managerRecipients.length ? managerRecipients.map((r) => new PublicKey(r.wallet)) : [legacyManagerDestination!];
        const distributeIx = await buildDistributeFeeUsdcInstruction({
          program,
          programId: PROGRAM_ID,
          reserve: reservePk,
          usdcMint: MAINNET_USDC_MINT,
          protocolFeeDestination,
          payer: keeper.publicKey,
          managerRecipients,
          legacyManagerDestination,
        });
        const recipientAtaIxs = recipientWallets.map((w) => createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, getAssociatedTokenAddressSync(MAINNET_USDC_MINT, w, true), w, MAINNET_USDC_MINT));
        result.distributeSignature = await sendV0(connection, keeper, "distribute_fee_usdc", [...budgetIxs(CORE_TX_COMPUTE_UNIT_LIMIT), ...recipientAtaIxs, distributeIx], []);
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
      }
      results.push(result);
    }
  }

  // ---------------------------------------------------------------------
  // Job C (DEC-0229): sweep Token-2022 Reserve Token transfer fees to the
  // Treasury, once a day, with whatever budget is left.
  // ---------------------------------------------------------------------
  const transferFeeResults: TransferFeeCollectResult[] = [];
  const transferFeeSkippedForBudget: string[] = [];
  if (transferFeeDue) {
    for (const r of transferFeeReserves) {
      if (Date.now() > deadline) {
        transferFeeSkippedForBudget.push(r.reserve);
        continue;
      }
      const reservePk = new PublicKey(r.reserve);
      const mintPk = new PublicKey(r.reserveTokenMint);
      const result: TransferFeeCollectResult = { reserveId: r.reserveId, reserve: r.reserve, harvestedAccounts: 0, withheldRaw: "0", signatures: [] };
      try {
        const sources = await findWithheldFeeAccounts(connection, mintPk);
        const onMint = (await fetchReserveTokenTransferFee(connection, mintPk))?.withheldOnMintRaw ?? 0n;
        const total = sources.reduce((sum, s) => sum + s.withheldRaw, onMint);
        result.withheldRaw = total.toString();
        if (total === 0n) {
          transferFeeResults.push(result);
          continue;
        }
        // DEC-0257: a mint carrying a creator trade tax is split by
        // collect_trade_tax (collect_transfer_fees refuses it on-chain).
        const tradeTaxAccount = await connection.getAccountInfo(findTradeTax(reservePk, PROGRAM_ID), "confirmed");
        const tradeTax = tradeTaxAccount ? decodeTradeTax(tradeTaxAccount.data) : null;
        // Each chunk harvests a batch of accounts and sweeps the mint; an
        // empty source list still sweeps what is already on the mint.
        const perTx = tradeTax ? MAX_TRADE_TAX_HARVEST_SOURCES : MAX_HARVEST_SOURCES_PER_TX;
        const chunks: PublicKey[][] = [];
        for (let i = 0; i < sources.length; i += perTx) chunks.push(sources.slice(i, i + perTx).map((s) => s.address));
        if (chunks.length === 0) chunks.push([]);
        for (const chunk of chunks) {
          if (Date.now() > deadline) break;
          const ix = tradeTax
            ? buildCollectTradeTax({ programId: PROGRAM_ID, reserve: reservePk, protocolTreasury: protocolFeeDestination, creatorTreasury: tradeTax.treasury, payer: keeper.publicKey, harvestSources: chunk })
            : await buildCollectTransferFeesInstruction({ program: readOnly as never, programId: PROGRAM_ID, reserve: reservePk, treasury: protocolFeeDestination, payer: keeper.publicKey, harvestSources: chunk });
          const tx = new Transaction().add(ix);
          tx.feePayer = keeper.publicKey;
          result.signatures.push(await sendAndConfirmTransaction(connection, tx, [keeper], { commitment: "confirmed" }));
          result.harvestedAccounts += chunk.length;
        }
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
      }
      transferFeeResults.push(result);
    }
  }

  // ---------------------------------------------------------------------
  // Job D (DEC-0251): feed released holder shares into Reserve vaults.
  // ---------------------------------------------------------------------
  const basketFeedResults: BasketFeedResult[] = [];
  const basketFeedSkippedForBudget: string[] = [];
  if (keeperMatchesOnChain) {
    const feedDeps = {
      connection, keeper, program: readOnly, programId: PROGRAM_ID, protocolTreasury: protocolFeeDestination, apiKey, deadline,
      send: (label: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[]) => sendV0(connection, keeper!, label, ixs, tables),
      budget: budgetIxs,
      fits: (ixs: TransactionInstruction[], tables: AddressLookupTableAccount[]) => fitsV0(keeper!.publicKey, ixs, tables),
      reserveTables: async (reserve: PublicKey) => { const alt = await lookupReserveAlt(reserve.toBase58()).catch(() => null); return alt ? fetchLookupTables(connection, [alt]) : []; },
      jupiterTables: (addresses: string[]) => fetchLookupTables(connection, addresses),
      jupiterInstructions: (built: any) => [...built.setupInstructions.map(deserializeJupiterInstruction).filter((ix: TransactionInstruction) => !isComputeBudgetInstruction(ix)), deserializeJupiterInstruction(built.swapInstruction)],
      prices: fetchJupiterPrices,
    };
    for (const p of sharingPools) {
      if (Date.now() > deadline) { basketFeedSkippedForBudget.push(p.terms.reserve.toBase58()); continue; }
      try { basketFeedResults.push(await runBasketFeedForPool(feedDeps, p.terms)); }
      catch (e) { basketFeedResults.push({ reserve: p.terms.reserve.toBase58(), holderShareBps: p.terms.holderShareBps, releasedUsdcRaw: "0", legs: [], error: e instanceof Error ? e.message : String(e) }); }
    }
  }

  // DEC-0261: every job failure is logged and alerted (repeats grouped by lib/ops-alerts).
  // DEC-0262: one-off RPC hiccups retry next run and are not alerted; a repeat of
  // the same keeper failure posts at most every 6 hours (the job runs hourly).
  const failures = [
    ...results.filter((r) => r.error).map((r) => ({ step: "settlement", reserve: r.reserve, message: r.error! })),
    ...accruals.filter((r) => r.error).map((r) => ({ step: "accrual", reserve: r.reserve, message: r.error! })),
    ...transferFeeResults.filter((r) => r.error).map((r) => ({ step: "transfer-fees", reserve: r.reserve, message: r.error! })),
    ...basketFeedResults.filter((r) => r.error).map((r) => ({ step: "basket-feed", reserve: r.reserve, message: r.error! })),
  ];
  for (const f of failures) if (!isTransientRpcError(f.message)) await recordAlert({ source: "keeper", ...f }, { quietMinutes: 360 });

  // DEC-0270: one line per run in the Vercel logs (the JSON response is not
  // logged), and the heartbeat the watchdog checks. Neither can fail the run.
  const summary = `accruals ${accruals.filter((a) => a.signature).length}/${accrueDue.length} (skipped ${accrualsSkippedForBudget.length}), settled ${results.length}/${candidates.length} (dust ${dustSkipped.length}, budget ${skippedForBudget.length}), failures ${failures.length}, ${Math.round((Date.now() - startedAt) / 1000)}s`;
  console.info(`[keeper] ${summary}`);
  await Promise.race([
    Promise.resolve().then(() => writeKeeperHeartbeat(getSql(), siteLabel(), summary)).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);

  res.status(200).json({
    dryRun: false,
    ...status,
    elapsedMs: Date.now() - startedAt,
    settlement: { reservesProcessed: results.length, results, skippedForBudget, dustSkipped },
    accrual: { processed: accruals.length, results: accruals, skippedForBudget: accrualsSkippedForBudget },
    transferFees: { ran: transferFeeDue, results: transferFeeResults, skippedForBudget: transferFeeSkippedForBudget },
    basketFeed: { ran: keeperMatchesOnChain, results: basketFeedResults, skippedForBudget: basketFeedSkippedForBudget },
  });
}

/**
 * DEC-0270: a run that throws (discovery failed, an RPC outage mid-run) pages the
 * team at once instead of returning a bare 500 nobody sees. A one-off RPC hiccup is
 * left to the next hourly run; if runs keep failing, the watchdog reports it.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    await runKeeper(req, res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[keeper] run crashed: ${message}`);
    if (!isTransientRpcError(message)) await recordAlert({ source: "keeper", step: "keeper-crash", message }, { quietMinutes: 60 }).catch(() => undefined);
    try { res.status(500).json({ error: message }); } catch { /* response already sent */ }
  }
}

// Referenced for type-completeness of the v0 path; VersionedTransaction is what compileV0 returns.
void VersionedTransaction;
