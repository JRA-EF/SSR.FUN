// GET/POST /api/mainnet/fee-settlement-cron -- the Mainnet fee keeper.
// Two jobs per run, every discovered Reserve:
//
//   A. USDC FEE SETTLEMENT (the 3-step redeem -> swap -> distribute pipeline,
//      2026-08-21 pass, see docs/project/DECISION_LOG.md): for every Reserve
//      whose shared fee vault holds crystallized mint/seed/TVL fee shares (or
//      has assets already staged from an earlier run):
//        1. redeemFeeVaultShares -- burns the full current vault balance,
//           stages each asset's proportional entitlement.
//        2. For each asset with a nonzero staging balance: fetch a Jupiter
//           quote, approveSettlementSwap for that exact amount (keeper-SIGNED,
//           Tier B / DEC-0184), then sign and submit an ordinary Jupiter swap
//           AS THE KEEPER (the program never signs a swap). A route failure or
//           a quote past this file's price-impact guard is SKIPPED, not forced
//           -- the staged asset stays in its own ATA, retried next run.
//        3. distributeFeeUsdc -- pays whatever USDC is staged to the Protocol
//           Treasury and the Reserve's Manager fee recipient(s). Idempotent.
//      Gated on-chain: SettlementKeeperConfig.keeper must equal this
//      deployment's keeper wallet (set_fee_settlement_keeper, Protocol-Admin
//      signed). Until that is configured this job is reported as waiting and
//      nothing is submitted for it.
//
//   B. TVL FEE ACCRUAL: `accrue_fees` is permissionless (any payer) and is the
//      ONLY thing that ever crystallizes the annual TVL fee -- on Mainnet it
//      had NEVER been called (PROJECT_STATUS risk: "Mainnet TVL fees have
//      never been accrued"). Called here for every Reserve whose last accrual
//      is >= 7 days old; the instruction is a cheap no-op when nothing new is
//      owed, and the accrued shares land in the same fee vault job A settles.
//      Needs no on-chain keeper config -- only a funded payer.
//
// Scheduled in vercel.json (see its `crons`) and allowlisted in middleware.ts's
// CRON_PATHS. Same CRON_SECRET / `?dryRun=true` conventions as every other
// cron here: dryRun never submits anything and reports exactly what a real run
// would do. Time-budgeted (api/mainnet/* maxDuration is 60s): settlement is
// processed first (the money the tester is waiting on), accruals with the
// leftover budget; anything unprocessed is reported and picked up next run.
//
// The keeper wallet is a dedicated secret (SSR_FEE_SETTLEMENT_KEEPER_SECRET,
// JSON array or base64), distinct from every other key. It only ever custodies
// what one approveSettlementSwap just delegated to it for one asset, for the
// brief window until that swap lands or is abandoned; it never owns Reserve
// funds, and its SOL only pays transaction fees + first-use staging-ATA rent.
import { Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  discoverAllReserves,
  enumerateReserveAssetMintsOnChain,
  registerDynamicSupportedAssetMints,
  fetchFeeSettlement,
  fetchSettlementKeeperConfig,
  fetchProtocolConfig,
  findVaultAuthority,
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

const RPC_URL = resolveRpcUrl();
const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MAINNET_TREASURY_VAULT = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");

// Same guards as api/mainnet/jupiter-swap.ts's -- kept independent (not
// imported) since this is a distinct, standalone server context, but MUST
// stay in sync if either changes.
const DEFAULT_SLIPPAGE_BPS = 150;
const MAX_PRICE_IMPACT_PCT = 15;

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

const BUDGET_MS = 50_000; // under the api/mainnet/* maxDuration of 60s
const ACCRUE_MIN_ELAPSED_S = 7 * 24 * 60 * 60;
const MAX_KNOWN_MINTS = 2000;

/**
 * Pure: decides whether a Jupiter quote is safe enough to actually execute
 * for a settlement swap -- same price-impact ceiling this app already
 * applies to every other Mainnet Jupiter swap (api/mainnet/jupiter-swap.ts).
 * Never mutates anything; a caller that gets `false` back must leave the
 * staged asset exactly where it is (requirement 10 -- report as pending,
 * retry later), never force the swap through anyway.
 */
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

// Candidate asset mints for discovery -- the SAME sourcing as
// api/mainnet/warm-cache-cron.ts / landing-stats.ts (ledger + on-chain
// enumeration). The previous version of this cron passed ONLY USDC, so any
// Reserve holding another asset discovered with unresolved legs and its
// redeemFeeVaultShares would have been built against an incomplete asset list.
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

interface AssetSettlementResult {
  mint: string;
  stagedAmount: string;
  status: "swapped" | "skipped-price-impact" | "skipped-no-route" | "skipped-error";
  detail?: string;
  swapSignature?: string;
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

  // Keeper wallet from env (never the secret itself in any response).
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
  if (protocolFeeDestination.toBase58() !== MAINNET_TREASURY_VAULT.toBase58()) {
    // Requirement: "The Protocol recipient must remain the configured
    // official Treasury vault." -- refuse to proceed rather than silently
    // settling to an unexpected destination.
    res.status(500).json({ error: "protocolConfig.defaultProtocolFeeDestination does not match the official Treasury vault -- refusing to settle." });
    return;
  }

  const [ledgerMints, onChainMints] = await Promise.all([
    loadKnownAssetMints().catch(() => [] as string[]),
    enumerateReserveAssetMintsOnChain(connection).catch(() => [] as string[]),
  ]);
  const knownMints = [...new Set([...ledgerMints, ...onChainMints])];
  registerDynamicSupportedAssetMints(knownMints);
  const candidateAssetMints = [MAINNET_USDC_MINT, ...knownMints.filter((m) => m !== MAINNET_USDC_MINT.toBase58()).map((m) => new PublicKey(m))];

  const { reserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints).catch((e) => {
    throw new Error(`Failed to discover Reserves: ${e instanceof Error ? e.message : String(e)}`);
  });

  // --- Job A candidates: anything in the fee vault or already staged. ---
  const candidates: {
    reserve: string;
    reserveTokenMint: string;
    assetsResolved: boolean;
    assets: { mint: string; decimals: number; reserveAsset: string; vault: string; vaultBalanceRaw: string }[];
    feeSettlement: Awaited<ReturnType<typeof fetchFeeSettlement>>;
  }[] = [];
  for (const r of reserves) {
    const feeSettlement = await fetchFeeSettlement(connection, PROGRAM_ID, new PublicKey(r.reserve)).catch(() => null);
    if (!feeSettlement) continue;
    const vaultTotal = BigInt(feeSettlement.protocolSharesInVault) + BigInt(feeSettlement.managerSharesInVault);
    const pendingTotal = BigInt(feeSettlement.protocolSharesPendingSettlement) + BigInt(feeSettlement.managerSharesPendingSettlement);
    if (vaultTotal > 0n || pendingTotal > 0n) {
      candidates.push({
        reserve: r.reserve,
        reserveTokenMint: r.reserveTokenMint,
        assetsResolved: r.resolvedAssetCount === r.assetCount,
        assets: r.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw })),
        feeSettlement,
      });
    }
  }

  // --- Job B candidates: accrual overdue, judged by the accumulator itself. ---
  // accrue_fees bills `TvlAccrual.period_supply_seconds` since
  // `TvlAccrual.last_settled_ts` (programs/.../accrue_fees.rs). A Reserve with
  // NO TvlAccrual yet has never started its clock -- its first call only
  // creates the account with last_settled_ts = now (nothing billed, rent
  // paid), so it is always "due" until initialized. After that, the legacy
  // `reserve.fee_config.last_fee_accrual_ts` is NOT advanced by a no-op call,
  // which is why the accumulator's own timestamp is the gate here: judging by
  // the legacy field re-settled every such Reserve on every hourly run
  // (observed on the first scheduled run, 2026-09-08 00:15 UTC).
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
      candidates: candidates.map((c) => ({ reserve: c.reserve, assetsResolved: c.assetsResolved, feeSettlement: c.feeSettlement })),
      accrueDue,
    });
    return;
  }

  if (!keeper) {
    res.status(500).json({ error: keeperEnvError ?? "Keeper wallet not configured." });
    return;
  }
  const program = buildReadOnlyProgram(connection) as any;

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
        const reserveTokenMintPk = new PublicKey(c.reserveTokenMint);

        // Step 1: redeem the full current vault balance (if any).
        const vaultTotal = BigInt(c.feeSettlement.protocolSharesInVault) + BigInt(c.feeSettlement.managerSharesInVault);
        if (vaultTotal > 0n) {
          const [vaultAuthority] = findVaultAuthority(reservePk, PROGRAM_ID);
          const ix = await buildRedeemFeeVaultSharesInstruction({
            program,
            programId: PROGRAM_ID,
            reserve: reservePk,
            reserveTokenMint: reserveTokenMintPk,
            vaultAuthority,
            payer: keeper.publicKey,
            assets: c.assets,
            shares: vaultTotal,
          });
          const tx = new Transaction().add(ix);
          tx.feePayer = keeper.publicKey;
          result.redeemSignature = await sendAndConfirmTransaction(connection, tx, [keeper], { commitment: "confirmed" });
          result.redeemedShares = vaultTotal.toString();
        }

        // Step 2: attempt a swap for every asset with a nonzero staging balance.
        const [settlementAuthority] = findSettlementAuthority(reservePk, PROGRAM_ID);
        for (const asset of c.assets) {
          if (Date.now() > deadline) break;
          const mint = new PublicKey(asset.mint);
          const stagingAta = getAssociatedTokenAddressSync(mint, settlementAuthority, true);
          const stagedInfo = await connection.getTokenAccountBalance(stagingAta).catch(() => null);
          const stagedAmount = stagedInfo ? BigInt(stagedInfo.value.amount) : 0n;
          if (stagedAmount === 0n) continue;
          // USDC needs no swap -- distribute below pays out staged USDC directly.
          if (asset.mint === MAINNET_USDC_MINT.toBase58()) continue;

          const assetResult: AssetSettlementResult = { mint: asset.mint, stagedAmount: stagedAmount.toString(), status: "skipped-no-route" };
          try {
            const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${asset.mint}&outputMint=${MAINNET_USDC_MINT.toBase58()}&amount=${stagedAmount.toString()}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&swapMode=ExactIn`;
            const quoteRes = await fetch(quoteUrl, { headers: { "x-api-key": process.env.JUPITER_API_KEY ?? "" } });
            if (!quoteRes.ok) {
              assetResult.status = "skipped-no-route";
              assetResult.detail = `Quote request failed (HTTP ${quoteRes.status}).`;
            } else {
              const quote = await quoteRes.json();
              const priceImpactPct = Number(quote.priceImpactPct);
              if (!isQuoteSafeToExecute(priceImpactPct)) {
                assetResult.status = "skipped-price-impact";
                assetResult.detail = `Price impact ${priceImpactPct}% exceeds the ${MAX_PRICE_IMPACT_PCT}% safety ceiling.`;
              } else {
                // approveSettlementSwap: bounded, per-call delegate approval, keeper-signed.
                const approveIx = await buildApproveSettlementSwapInstruction({
                  program,
                  programId: PROGRAM_ID,
                  reserve: reservePk,
                  assetMint: mint,
                  keeper: keeper.publicKey,
                  amount: stagedAmount,
                });
                const approveTx = new Transaction().add(approveIx);
                approveTx.feePayer = keeper.publicKey;
                await sendAndConfirmTransaction(connection, approveTx, [keeper], { commitment: "confirmed" });

                const swapRes = await fetch(JUPITER_SWAP_URL, {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-api-key": process.env.JUPITER_API_KEY ?? "" },
                  body: JSON.stringify({ quoteResponse: quote, userPublicKey: keeper.publicKey.toBase58(), dynamicComputeUnitLimit: true, dynamicSlippage: true }),
                });
                const swapBody = await swapRes.json().catch(() => null);
                if (!swapRes.ok || !swapBody?.swapTransaction) {
                  assetResult.status = "skipped-error";
                  assetResult.detail = swapBody?.error || "Failed to build the Jupiter swap transaction.";
                } else {
                  const vtx = VersionedTransaction.deserialize(Buffer.from(swapBody.swapTransaction, "base64"));
                  vtx.sign([keeper]);
                  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 0 });
                  await connection.confirmTransaction(sig, "confirmed");
                  assetResult.status = "swapped";
                  assetResult.swapSignature = sig;
                }
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
        let legacyManagerDestination: PublicKey | undefined;
        if (!recipientsAccount) {
          const reserveAccount = await program.account.reserve.fetch(reservePk);
          legacyManagerDestination = reserveAccount.feeConfig.feeDestination;
        }
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
        const distributeTx = new Transaction().add(distributeIx);
        distributeTx.feePayer = keeper.publicKey;
        result.distributeSignature = await sendAndConfirmTransaction(connection, distributeTx, [keeper], { commitment: "confirmed" });
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
      // DEPLOYED-PROGRAM BUG (found 2026-09-08 on the first overdue accrual):
      // AccrueFees declares reserve_token_mint WITHOUT `mut`, so the IDL marks
      // it read-only and Anchor builds the key read-only -- the mint_to CPI
      // then fails with PrivilegeEscalation the moment there is anything to
      // bill (a clock-start mints nothing, which is why the first run passed).
      // The runtime only checks that a CPI never escalates what the caller
      // passed, so passing the mint WRITABLE from here is the complete fix
      // (simulated on Reserves 7 and 16: err null, FeeVaultCredited emitted).
      // Program source gets `mut` in the next upgrade (docs/project/final-fixes.md).
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
