// POST/GET /api/mainnet/fee-settlement-cron -- the keeper behind the USDC
// fee-settlement pipeline (2026-08-21 pass, see docs/project/DECISION_LOG.md).
// Mirrors api/devnet/accrue-fees-cron.ts's structure/auth/dryRun conventions
// exactly, adapted for the 3-step redeem -> swap -> distribute pipeline.
//
// NOT wired into vercel.json's `crons` list -- per the explicit deployment
// plan (see the Decision Log entry above), this is deployed and callable but
// NOT scheduled to run automatically until a Creator-designated keeper
// wallet has been configured on-chain (set_fee_settlement_keeper) and this
// endpoint has been manually dry-run-verified against at least one real
// Reserve with a small pending fee balance.
//
// One run does, per discovered Reserve with a nonzero fee-vault balance:
//   1. redeemFeeVaultShares -- burns the full current vault balance, stages
//      each asset's proportional entitlement.
//   2. For each asset with a nonzero staging balance: fetch a Jupiter quote,
//      approveSettlementSwap for that exact amount, then sign and submit an
//      ordinary Jupiter swap transaction AS THE KEEPER (the program never
//      signs a swap -- see approve_settlement_swap.rs's header). A route
//      failure or a quote whose price impact/slippage exceeds this file's
//      own guards (mirroring api/mainnet/jupiter-swap.ts's) is SKIPPED, not
//      retried blindly -- the staged asset simply remains in its own ATA,
//      safely retryable on the next run (requirement 10: report as pending,
//      never lose it).
//   3. distributeFeeUsdc -- pays out whatever USDC ended up in the staging
//      ATA (possibly from THIS run's swaps, possibly left over from an
//      earlier run) to the Protocol Treasury and the Reserve's configured
//      Manager fee recipient(s). Safe to call even if step 2 swapped
//      nothing this run (idempotent no-op, never an error).
//
// The keeper wallet is a dedicated secret (SSR_FEE_SETTLEMENT_KEEPER_SECRET,
// base58 or JSON array, same convention as every other server-held keypair
// in this app) -- distinct from any DevNet authority, distinct from the
// user's own wallet. It only ever custodies whatever a real
// approveSettlementSwap call just delegated to it for one specific asset,
// for the brief window until that swap either lands or is abandoned; it is
// never the OWNER of any Reserve funds, and its own SOL balance only ever
// pays ordinary transaction fees.
import { Connection, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  discoverAllReserves,
  fetchFeeSettlement,
  fetchSettlementKeeperConfig,
  fetchProtocolConfig,
  findVaultAuthority,
  findSettlementAuthority,
  findManagerFeeRecipients,
  buildReadOnlyProgram,
  buildRedeemFeeVaultSharesInstruction,
  buildApproveSettlementSwapInstruction,
  buildDistributeFeeUsdcInstruction,
} from "@ssr/sdk";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";

const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
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
  usdcDistributed?: string;
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

  const connection = new Connection(RPC_URL, "confirmed");

  const keeperConfig = await fetchSettlementKeeperConfig(connection, PROGRAM_ID).catch(() => null);
  if (!keeperConfig) {
    res.status(200).json({ dryRun, note: "SettlementKeeperConfig has not been configured yet (set_fee_settlement_keeper) -- nothing to do.", reserves: [] });
    return;
  }

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

  const { reserves } = await discoverAllReserves(connection, PROGRAM_ID, [MAINNET_USDC_MINT]).catch((e) => {
    throw new Error(`Failed to discover Reserves: ${e instanceof Error ? e.message : String(e)}`);
  });

  const candidates: { reserve: string; reserveTokenMint: string; assets: { mint: string; decimals: number; reserveAsset: string; vault: string; vaultBalanceRaw: string }[]; feeSettlement: Awaited<ReturnType<typeof fetchFeeSettlement>> }[] = [];
  for (const r of reserves) {
    const feeSettlement = await fetchFeeSettlement(connection, PROGRAM_ID, new PublicKey(r.reserve));
    const vaultTotal = BigInt(feeSettlement.protocolSharesInVault) + BigInt(feeSettlement.managerSharesInVault);
    const pendingTotal = BigInt(feeSettlement.protocolSharesPendingSettlement) + BigInt(feeSettlement.managerSharesPendingSettlement);
    if (vaultTotal > 0n || pendingTotal > 0n) {
      candidates.push({
        reserve: r.reserve,
        reserveTokenMint: r.reserveTokenMint,
        assets: r.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals, reserveAsset: a.reserveAsset, vault: a.vault, vaultBalanceRaw: a.vaultBalanceRaw })),
        feeSettlement,
      });
    }
  }

  if (dryRun) {
    res.status(200).json({
      dryRun: true,
      keeper: keeperConfig.keeper,
      totalReserves: reserves.length,
      reservesWithSomethingToSettle: candidates.length,
      candidates: candidates.map((c) => ({ reserve: c.reserve, feeSettlement: c.feeSettlement })),
    });
    return;
  }

  let keeper: Keypair;
  try {
    keeper = loadKeeperKeypair();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Keeper wallet not configured." });
    return;
  }
  if (keeper.publicKey.toBase58() !== keeperConfig.keeper) {
    res.status(500).json({ error: "The configured SSR_FEE_SETTLEMENT_KEEPER_SECRET does not match on-chain SettlementKeeperConfig.keeper -- refusing to proceed." });
    return;
  }

  const program = buildReadOnlyProgram(connection) as any;
  const results: ReserveSettlementResult[] = [];

  for (const c of candidates) {
    const result: ReserveSettlementResult = { reserve: c.reserve, assets: [] };
    try {
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
        const mint = new PublicKey(asset.mint);
        const stagingAta = getAssociatedTokenAddressSync(mint, settlementAuthority, true);
        const stagedInfo = await connection.getTokenAccountBalance(stagingAta).catch(() => null);
        const stagedAmount = stagedInfo ? BigInt(stagedInfo.value.amount) : 0n;
        if (stagedAmount === 0n) continue;

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
              // approveSettlementSwap: bounded, per-call delegate approval.
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

  res.status(200).json({ dryRun: false, keeper: keeperConfig.keeper, reservesProcessed: results.length, results });
}
