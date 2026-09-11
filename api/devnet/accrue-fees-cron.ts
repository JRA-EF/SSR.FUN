// GET /api/devnet/accrue-fees-cron -- the production keeper behind the
// Annualized TVL fee's weekly settlement requirement (2026-08-14 pass, see
// docs/project/DECISION_LOG.md). `accrue_fees` is the ONLY instruction that
// ever actually SETTLES a TVL-fee period (mints the Protocol's share
// straight to treasury, credits the Manager's share) -- see
// programs/ssr_protocol/src/instructions/accrue_fees.rs's header comment. A
// real mint/redeem/seed only ever cheaply CHECKPOINTS the time-weighted
// accumulator for free; it never settles. That means THIS keeper is the
// weekly fallback for EVERY Reserve, not just dormant ones with no organic
// activity -- an active Reserve's fees would otherwise accrue in the
// accumulator forever without ever actually being paid out. Every
// non-dry-run invocation therefore calls `accrue_fees` for every discovered
// Reserve unconditionally; the instruction itself is a safe, cheap no-op
// (no mint, no event) for a Reserve with nothing new to settle, so calling
// it weekly for a Reserve that settled five minutes ago via another trigger
// costs a transaction fee and nothing else -- never a double charge (see
// TvlAccrual's persisted `last_settled_ts`, which only a successful
// settlement ever advances).
//
// Also sweeps any Reserve's LEGACY `pending_protocol_fee_shares` balance
// (accrued before this pass, when the Protocol's TVL-fee share was still
// left pending rather than settled instantly) to the Protocol treasury via
// `collect_protocol_fee` -- purely a one-time drain of pre-existing
// balances; new activity never adds to this figure anymore.
//
// Triggered by vercel.json's `crons` entry -- scheduled `0 0 * * 1` (00:00
// UTC every Monday), the closest fixed-UTC approximation to "00:00 UK time
// every Monday": Vercel Cron has no timezone support (UTC only), and the
// UK observes DST (BST, UTC+1) roughly late March-late October -- this
// lands exactly on UK midnight during GMT months and 1 hour after UK
// midnight during BST months. Using Vercel's own documented cron-security
// pattern: a real request from Vercel's scheduler carries `Authorization:
// Bearer $CRON_SECRET`. `?dryRun=true` skips that check entirely and NEVER
// sends a transaction -- it only reports which Reserves look overdue, safe
// for anyone to call for manual inspection (the underlying data is all
// public on-chain state anyway).
//
// accrue_fees and collect_protocol_fee are both genuinely permissionless,
// zero-discretion instructions (see their own header comments) -- this
// endpoint pays the transaction fee via the same shared DevNet-only
// authority keypair already reused by swap-sign.ts/faucet-devusdc.ts
// (api/devnet/_lib/authority.ts), not because privilege is required, but
// because SOMEONE has to be the payer (also fronts the one-time rent for a
// Reserve's very first `TvlAccrual`/protocol-fee-ATA, if either doesn't
// exist yet).
import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DEVNET_FIXTURES,
  DEVUSDC_MINT,
  WRAPPED_SOL_MINT,
  discoverAllReserves,
  findMintAuthority,
  findProtocolConfig,
  findTvlAccrual,
  findFeeSettlement,
  findFeeVaultAuthority,
  findFeeVaultAta,
  fetchProtocolConfig,
  buildReadOnlyProgram,
} from "@ssr/sdk";

type MintMeta = { address: string; decimals: number; symbol: string };
import { loadDevnetAuthority } from "./_lib/authority";
import { assertDevnetCluster, NotDevnetError } from "./_lib/network";
import { type ApiRequest, type ApiResponse } from "./_lib/apiTypes";
import { resolveRpcUrl } from "./_lib/rpc";

const RPC_URL = resolveRpcUrl();
const PROGRAM_ID = new PublicKey(DEVNET_FIXTURES.programId);

// Purely informational for `?dryRun=true` reporting (which Reserves "look
// overdue") -- the real (non-dry-run) run always attempts settlement for
// EVERY discovered Reserve regardless of this threshold, since an ACTIVE
// Reserve's fees are never actually paid out except by this keeper (see this
// file's header comment). One week's worth of margin below the weekly
// schedule.
const OVERDUE_THRESHOLD_SECONDS = 8 * 24 * 60 * 60;

function getHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
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
  try {
    await assertDevnetCluster(connection);
  } catch (e) {
    res.status(e instanceof NotDevnetError ? 403 : 502).json({ error: e instanceof Error ? e.message : "Could not verify the Solana DevNet cluster." });
    return;
  }

  const candidateAssetMints = [WRAPPED_SOL_MINT, DEVUSDC_MINT, ...Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => new PublicKey(m.address))];

  let reserves;
  try {
    ({ reserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Failed to discover Reserves." });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const overdue = reserves.filter((r) => now - Number(r.lastFeeAccrualTs) >= OVERDUE_THRESHOLD_SECONDS);

  if (dryRun) {
    res.status(200).json({
      dryRun: true,
      checkedAt: new Date(now * 1000).toISOString(),
      totalReserves: reserves.length,
      note: "The real run settles every Reserve below, not just these -- this list is only a visibility aid for which ones look overdue.",
      overdueReserves: overdue.map((r) => ({
        reserveId: r.reserveId,
        reserve: r.reserve,
        lastFeeAccrualTs: r.lastFeeAccrualTs,
        elapsedDays: ((now - Number(r.lastFeeAccrualTs)) / 86400).toFixed(2),
      })),
    });
    return;
  }

  let authority;
  try {
    authority = loadDevnetAuthority();
  } catch {
    res.status(500).json({ error: "The DevNet keeper authority is not configured on this deployment." });
    return;
  }

  const protocolConfigForSettlement = await fetchProtocolConfig(connection, PROGRAM_ID);
  if (!protocolConfigForSettlement) {
    res.status(500).json({ error: "ProtocolConfig not found -- cannot settle without a configured treasury destination." });
    return;
  }
  const protocolFeeDestination = new PublicKey(protocolConfigForSettlement.defaultProtocolFeeDestination);

  const program = buildReadOnlyProgram(connection) as any;
  const protocolConfigAddress = findProtocolConfig(PROGRAM_ID)[0];
  const results: { reserveId: string; reserve: string; signature?: string; error?: string }[] = [];
  // Every discovered Reserve, unconditionally -- see this file's header
  // comment for why this keeper cannot limit itself to "stale/dormant"
  // Reserves the way it used to (checkpointing != settlement anymore).
  for (const r of reserves) {
    try {
      const reservePk = new PublicKey(r.reserve);
      const reserveTokenMintPk = new PublicKey(r.reserveTokenMint);
      const [mintAuthority] = findMintAuthority(reservePk, PROGRAM_ID);
      const [tvlAccrual] = findTvlAccrual(reservePk, PROGRAM_ID);
      // Tier B (DEC-0184 settlement pipeline): accrue_fees now routes the
      // protocol fee into the per-Reserve fee VAULT (fee_settlement/fee_vault/
      // fee_vault_authority) instead of a destination ATA + manager-fee-recipients
      // sentinel -- same 3-for-3 account swap as the mint builder in
      // packages/sdk/src/directInstructions.ts. See mint_reserve_tokens_in_kind.rs
      // / accrue_fees.rs and the regenerated IDL.
      const [feeSettlement] = findFeeSettlement(reservePk, PROGRAM_ID);
      const [feeVaultAuthority] = findFeeVaultAuthority(reservePk, PROGRAM_ID);
      const feeVault = findFeeVaultAta(reservePk, reserveTokenMintPk, PROGRAM_ID);
      const ix = await program.methods
        .accrueFees()
        .accounts({
          protocolConfig: protocolConfigAddress,
          reserve: reservePk,
          reserveTokenMint: reserveTokenMintPk,
          mintAuthority,
          tvlAccrual,
          feeSettlement,
          feeVault,
          feeVaultAuthority,
          payer: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = authority.publicKey;
      const signature = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
      results.push({ reserveId: r.reserveId, reserve: r.reserve, signature });
    } catch (e) {
      results.push({ reserveId: r.reserveId, reserve: r.reserve, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Sweeps any Reserve's LEGACY `pending_protocol_fee_shares` balance
  // (accrued before this pass, when the Protocol's TVL-fee share was still
  // left pending rather than settled instantly by `accrue_fees` itself --
  // see this file's header comment) to the Protocol treasury via
  // `collect_protocol_fee`. New activity never adds to this figure anymore,
  // so this naturally becomes a permanent no-op once every legacy balance
  // has been drained once. Manager's pending balance is deliberately left
  // untouched (collect_protocol_fee only ever moves the Protocol's share) --
  // the Manager keeps choosing when to collect their own. Re-fetches
  // discovery fresh (rather than reusing `reserves` from above, which would
  // be stale for any Reserve just settled in the accrual loop above) so this
  // only ever attempts a collection where one is genuinely owed.
  let protocolFeeResults: { reserveId: string; reserve: string; amount?: string; signature?: string; error?: string }[] = [];
  try {
    const { reserves: freshReserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints);
    const owed = freshReserves.filter((r) => BigInt(r.pendingProtocolFeeShares) > 0n);
    for (const r of owed) {
      try {
        const reservePk = new PublicKey(r.reserve);
        const reserveTokenMint = new PublicKey(r.reserveTokenMint);
        const protocolFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
        const ix = await program.methods
          .collectProtocolFee()
          .accounts({
            protocolConfig: protocolConfigAddress,
            reserve: reservePk,
            reserveTokenMint,
            mintAuthority: findMintAuthority(reservePk, PROGRAM_ID)[0],
            protocolFeeDestinationTokenAccount,
            protocolFeeDestination,
            payer: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        const tx = new Transaction().add(ix);
        tx.feePayer = authority.publicKey;
        const signature = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
        protocolFeeResults.push({ reserveId: r.reserveId, reserve: r.reserve, amount: r.pendingProtocolFeeShares, signature });
      } catch (e) {
        protocolFeeResults.push({ reserveId: r.reserveId, reserve: r.reserve, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    // Best-effort: a failure re-discovering Reserves for the sweep must
    // never fail the whole cron run -- the TVL-accrual results above are
    // still genuinely valid and already reported.
    protocolFeeResults = [{ reserveId: "-", reserve: "-", error: e instanceof Error ? e.message : String(e) }];
  }

  res.status(200).json({
    dryRun: false,
    checkedAt: new Date(now * 1000).toISOString(),
    totalReserves: reserves.length,
    overdueReserveCountBeforeThisRun: overdue.length,
    results,
    protocolFeeSweepCount: protocolFeeResults.length,
    protocolFeeResults,
  });
}
