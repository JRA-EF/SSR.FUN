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
// Scheduled in vercel.json, allowlisted in middleware.ts CRON_PATHS. Same
// CRON_SECRET / `?dryRun=true` conventions as every other cron here. Time
// budgeted (api/mainnet/* maxDuration is 60s): settlement first, accruals with
// the leftover budget; anything unprocessed is reported and picked up next run.
// Jupiter goes through lib/mainnet/jupiter.ts (shared venue exclusions,
// retry policy, JUPITER_API_BASE override for the test site).
//
// The keeper wallet is a dedicated secret (SSR_FEE_SETTLEMENT_KEEPER_SECRET,
// JSON array or base64). Its SOL only pays transaction fees + first-use rent.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
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
} from "@ssr/sdk";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl } from "./_lib/rpc";
import { getSql } from "../../lib/ledger/db";
import { lookupReserveAlt } from "./build-buy";
import { readReserveAndWallet, compileV0, fitsV0, CORE_TX_COMPUTE_UNIT_LIMIT, MAINNET_TREASURY_VAULT } from "../../lib/mainnet/buildCommon";
import { DEFAULT_SLIPPAGE_BPS, MAINNET_USDC_MINT as USDC_MINT_STR, MAX_PRICE_IMPACT_PCT, buildJupiterSwapInstructionsWithRetry, fetchJupiterQuoteWithRetry, isPriceImpactAcceptable } from "../../lib/mainnet/jupiter";
import { deserializeJupiterInstruction, fetchLookupTables, isComputeBudgetInstruction, SINGLE_TX_MICRO_LAMPORTS_PER_CU } from "../../src/merge/lib/singleTxBuy";
import { sendAndConfirmWithRebroadcast } from "../../src/merge/lib/rpcResilience";

const RPC_URL = resolveRpcUrl();
const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const MAINNET_USDC_MINT = new PublicKey(USDC_MINT_STR);
const TREASURY = new PublicKey(MAINNET_TREASURY_VAULT);

// Under this route's own maxDuration (vercel.json: 300s for fee-settlement-cron;
// each Reserve needs several sequential confirmations, ~20-60s).
const BUDGET_MS = 270_000;
const ACCRUE_MIN_ELAPSED_S = 24 * 60 * 60;
const MAX_KNOWN_MINTS = 2000;

/** Per-route runtime config (Vercel reads this export): settlement needs several sequential confirmations per Reserve, ~20-60s each Reserve. */
export const config = { maxDuration: 300 };

/** Pure: same price-impact ceiling as every other Mainnet swap (lib/mainnet/jupiter.ts). A non-finite value (malformed Jupiter response) is NEVER accepted. A `false` leaves the staged asset exactly where it is. */
export function isQuoteSafeToExecute(priceImpactPct: number): boolean {
  return Number.isFinite(priceImpactPct) && priceImpactPct <= MAX_PRICE_IMPACT_PCT;
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
  status: "swapped" | "skipped-price-impact" | "skipped-no-route" | "skipped-error";
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
  error?: string;
}

interface AccrualResult {
  reserveId: string;
  reserve: string;
  elapsedDays: string;
  signature?: string;
  error?: string;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const dryRun = req.query?.dryRun === "true" || req.query?.dryRun === "1";

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
  const candidates: { reserve: string; reserveTokenMint: string; assetsResolved: boolean; feeSettlement: Awaited<ReturnType<typeof fetchFeeSettlement>>; staged: { mint: string; amount: string }[] }[] = [];
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
    const mints = [...r.assets.map((a) => new PublicKey(a.assetMint)), MAINNET_USDC_MINT];
    const stagingAtas = mints.map((m) => getAssociatedTokenAddressSync(m, sa, true));
    const keeperAtas = keeper ? mints.map((m) => getAssociatedTokenAddressSync(m, keeper.publicKey)) : [];
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
    candidates.push({ reserve: r.reserve, reserveTokenMint: r.reserveTokenMint, assetsResolved: r.resolvedAssetCount === r.assetCount, feeSettlement, staged });
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
        accumulatorInitialized: lastSettled !== null,
        elapsedDays: elapsedS === null ? "clock not started" : (elapsedS / 86400).toFixed(2),
        due: lastSettled === null || (elapsedS as number) >= ACCRUE_MIN_ELAPSED_S,
      };
    })
    .filter((r) => r.due);

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
    accrualsDue: accrueDue.length,
  };

  if (dryRun) {
    res.status(200).json({
      dryRun: true,
      ...status,
      candidates: candidates.map((c) => ({ reserve: c.reserve, assetsResolved: c.assetsResolved, feeSettlement: c.feeSettlement, staged: c.staged })),
      accrueDue,
    });
    return;
  }

  if (!keeper) {
    res.status(500).json({ error: keeperEnvError ?? "Keeper wallet not configured." });
    return;
  }
  const apiKey = process.env.JUPITER_API_KEY ?? "";
  const program = readOnly;
  const deps = { connection, program, ssrProgramId: PROGRAM_ID, lookupReserveAlt };

  // ---------------------------------------------------------------------
  // Job A: settlement (only when the on-chain keeper is THIS wallet).
  // ---------------------------------------------------------------------
  const results: ReserveSettlementResult[] = [];
  const skippedForBudget: string[] = [];
  if (keeperMatchesOnChain) {
    for (const c of candidates) {
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
        const stagingAtaOf = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, settlementAuthority, true);
        const usdcStaging = stagingAtaOf(MAINNET_USDC_MINT);
        const reserveTables = read.reserveAlt ? await fetchLookupTables(connection, [read.reserveAlt]) : [];
        const createStagingIxs = [
          ...legs.map((l) => createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, stagingAtaOf(new PublicKey(l.mint)), settlementAuthority, new PublicKey(l.mint))),
          createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, usdcStaging, settlementAuthority, MAINNET_USDC_MINT),
        ];

        // Step 1: redeem the full current vault balance (if any).
        const vaultTotal = BigInt(c.feeSettlement.protocolSharesInVault) + BigInt(c.feeSettlement.managerSharesInVault);
        if (vaultTotal > 0n) {
          const redeemIx = await buildRedeemFeeVaultSharesInstruction({
            program,
            programId: PROGRAM_ID,
            reserve: reservePk,
            reserveTokenMint: read.reserveTokenMint,
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
        const keeperAtas = legs.map((l) => getAssociatedTokenAddressSync(new PublicKey(l.mint), keeper.publicKey));
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
                const prelude: TransactionInstruction[] = [
                  createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperAta, keeper.publicKey, mint),
                  createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, usdcStaging, settlementAuthority, MAINNET_USDC_MINT),
                ];
                if (stagedAmount > 0n) {
                  prelude.unshift(await buildApproveSettlementSwapInstruction({ program, programId: PROGRAM_ID, reserve: reservePk, assetMint: mint, keeper: keeper.publicKey, amount: stagedAmount }));
                  // The keeper signs as the SPL DELEGATE the approval above just created -- bounded to exactly stagedAmount.
                  prelude.push(createTransferInstruction(stagingAtaOf(mint), keeperAta, keeper.publicKey, stagedAmount));
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

        // Step 3: distribute whatever USDC is now staged (idempotent no-op if none).
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
  // Job B: TVL accrual with the remaining budget (permissionless, keeper pays).
  // ---------------------------------------------------------------------
  const accruals: AccrualResult[] = [];
  const accrualsSkippedForBudget: string[] = [];
  const protocolConfigAddress = findProtocolConfig(PROGRAM_ID)[0];
  for (const r of accrueDue) {
    if (Date.now() > deadline) {
      accrualsSkippedForBudget.push(r.reserve);
      continue;
    }
    try {
      const reservePk = new PublicKey(r.reserve);
      const reserveTokenMintPk = new PublicKey(r.reserveTokenMint);
      const ix = await program.methods
        .accrueFees()
        .accounts({
          protocolConfig: protocolConfigAddress,
          reserve: reservePk,
          reserveTokenMint: reserveTokenMintPk,
          mintAuthority: findMintAuthority(reservePk, PROGRAM_ID)[0],
          tvlAccrual: findTvlAccrual(reservePk, PROGRAM_ID)[0],
          feeSettlement: findFeeSettlement(reservePk, PROGRAM_ID)[0],
          feeVault: findFeeVaultAta(reservePk, reserveTokenMintPk, PROGRAM_ID),
          feeVaultAuthority: findFeeVaultAuthority(reservePk, PROGRAM_ID)[0],
          payer: keeper.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
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
  }

  res.status(200).json({
    dryRun: false,
    ...status,
    elapsedMs: Date.now() - startedAt,
    settlement: { reservesProcessed: results.length, results, skippedForBudget },
    accrual: { processed: accruals.length, results: accruals, skippedForBudget: accrualsSkippedForBudget },
  });
}

// Referenced for type-completeness of the v0 path; VersionedTransaction is what compileV0 returns.
void VersionedTransaction;
