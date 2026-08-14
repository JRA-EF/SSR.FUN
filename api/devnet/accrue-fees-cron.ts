// GET /api/devnet/accrue-fees-cron -- DEC-0094's permissionless weekly
// keeper for the Annualized TVL fee's cadence requirement ("settled weekly
// where practical, and at least once every 30 days"). Real mint/redeem
// transactions already checkpoint the TVL fee for free (see
// programs/ssr_protocol/src/instructions/accrue_fees.rs's checkpoint_tvl_fee,
// called from mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind) --
// this is only the fallback for a Reserve with no organic activity to
// piggyback on.
//
// Also sweeps every Reserve's Protocol pending fee share to the Protocol
// treasury (see the collect_protocol_fee step below) -- the mechanism that
// makes the Protocol a genuinely passive claimant: nobody ever manually
// collects its fees, this keeper does it on a fixed schedule. See
// docs/project/DECISION_LOG.md's entry for this pass.
//
// Triggered by vercel.json's `crons` entry -- scheduled `0 0 * * 1` (00:00
// UTC every Monday), the closest fixed-UTC approximation to "00:00 UK time
// every Monday": Vercel Cron has no timezone support (UTC only), and the
// UK observes DST (BST, UTC+1) roughly late March-late October -- this
// lands exactly on UK midnight during GMT months and 1 hour after UK
// midnight during BST months. Using Vercel's own documented cron-security
// pattern: a real request from Vercel's scheduler carries `Authorization:
// Bearer $CRON_SECRET`. `?dryRun=true` skips that check entirely and NEVER
// sends a transaction -- it only reports which Reserves are stale, safe for
// anyone to call for manual inspection (the underlying data is all public
// on-chain state anyway).
//
// accrue_fees and collect_protocol_fee are both genuinely permissionless,
// zero-discretion instructions (see their own header comments) -- this
// endpoint pays the transaction fee via the same shared DevNet-only
// authority keypair already reused by swap-sign.ts/faucet-devusdc.ts
// (api/devnet/_lib/authority.ts), not because privilege is required, but
// because SOMEONE has to be the payer.
import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DEVNET_FIXTURES,
  DEVUSDC_MINT,
  WRAPPED_SOL_MINT,
  discoverAllReserves,
  findManagerFeeRecipients,
  findMintAuthority,
  findProtocolConfig,
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

// Trigger threshold intentionally well inside the 30-day hard requirement --
// this endpoint is scheduled weekly, so a ~25-day threshold gives multiple
// scheduled runs of margin even if one run is skipped/fails.
const STALE_THRESHOLD_SECONDS = 25 * 24 * 60 * 60;

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
  const stale = reserves.filter((r) => now - Number(r.lastFeeAccrualTs) >= STALE_THRESHOLD_SECONDS);

  if (dryRun) {
    res.status(200).json({
      dryRun: true,
      checkedAt: new Date(now * 1000).toISOString(),
      totalReserves: reserves.length,
      staleReserves: stale.map((r) => ({
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

  const program = buildReadOnlyProgram(connection) as any;
  const results: { reserveId: string; reserve: string; signature?: string; error?: string }[] = [];
  for (const r of stale) {
    try {
      const reservePk = new PublicKey(r.reserve);
      const [managerFeeRecipients] = findManagerFeeRecipients(reservePk, PROGRAM_ID);
      // Detect migration: an uninitialized ManagerFeeRecipients account
      // means the legacy fallback sentinel (the program ID itself) must be
      // passed instead -- see state/manager_fee_recipients.rs.
      const recipientsAccount = await program.account.managerFeeRecipients.fetchNullable(managerFeeRecipients);
      const ix = await program.methods
        .accrueFees()
        .accounts({
          reserve: reservePk,
          reserveTokenMint: new PublicKey(r.reserveTokenMint),
          managerFeeRecipients: recipientsAccount ? managerFeeRecipients : PROGRAM_ID,
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

  // Sweeps every Reserve's Protocol pending fee share to the Protocol
  // treasury -- the actual mechanism behind "the Protocol never has to
  // manually claim its fees" (see collect_protocol_fee.rs's header and
  // docs/project/DECISION_LOG.md's entry for this pass). Manager's pending
  // balance is deliberately left untouched (collect_protocol_fee only ever
  // moves the Protocol's share) -- the Manager keeps choosing when to
  // collect their own, exactly as before. Re-fetches discovery fresh
  // (rather than reusing `reserves` from above, which would be stale for
  // any Reserve whose TVL fee was just checkpointed in the accrual loop
  // above) so this only ever attempts a collection where one is genuinely
  // owed.
  let protocolFeeResults: { reserveId: string; reserve: string; amount?: string; signature?: string; error?: string }[] = [];
  try {
    const { reserves: freshReserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints);
    const owed = freshReserves.filter((r) => BigInt(r.pendingProtocolFeeShares) > 0n);
    const protocolConfig = await fetchProtocolConfig(connection, PROGRAM_ID);
    if (protocolConfig) {
      const protocolFeeDestination = new PublicKey(protocolConfig.defaultProtocolFeeDestination);
      for (const r of owed) {
        try {
          const reservePk = new PublicKey(r.reserve);
          const reserveTokenMint = new PublicKey(r.reserveTokenMint);
          const protocolFeeDestinationTokenAccount = getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination);
          const ix = await program.methods
            .collectProtocolFee()
            .accounts({
              protocolConfig: findProtocolConfig(PROGRAM_ID)[0],
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
    } else {
      protocolFeeResults = [{ reserveId: "-", reserve: "-", error: "ProtocolConfig not found -- skipped Protocol fee sweep." }];
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
    staleReserveCount: stale.length,
    results,
    protocolFeeSweepCount: protocolFeeResults.length,
    protocolFeeResults,
  });
}
