// POST /api/devnet/swap-sign -- the DevNet-only swap-adapter co-signer for
// SSR.fun's Buy/Sell "zap" (see docs/protocol/FRONTEND_INTEGRATION.md "Buy/Sell
// zap architecture"). The deployed protocol has no oracle/AMM of its own; Buy
// and Sell are single atomic, two-signer transactions combining a SOL leg
// with the real mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind
// call. This endpoint holds the DevNet-only swap-authority keypair
// server-side (DEVNET_SWAP_AUTHORITY_SECRET_KEY, never sent to the browser)
// and:
//   1) independently re-fetches live on-chain Reserve state (never trusts
//      client-supplied balances/supply/fees/addresses for the actual math --
//      see "Dynamic Reserve validation" below),
//   2) builds the exact instruction list via packages/sdk/src/zapInstructions.ts
//      (the same builders used by scripts/verify_zap.ts against live DevNet),
//   3) partially signs the assembled transaction with the swap-authority key,
//   4) returns it (base64, requireAllSignatures=false) for the client to
//      complete with the user's own wallet signature and submit.
//
// Dynamic Reserve validation (DEC-0029): earlier versions of this endpoint
// only recognized a hard-coded list of Reserve addresses (the 2 Gate-9
// fixtures), so a Reserve created live through the frontend could never be
// bought or sold. There is NO hard-coded Reserve list anymore. Any real
// on-chain Reserve is supported automatically, as long as EVERY one of its
// registered Reserve Assets is a mint the swap authority actually controls
// (ALLOWED_ASSET_MINTS below). The client only ever supplies the Reserve
// address and which asset mints it believes are registered -- every other
// address (protocolConfig, reserveTokenMint, mintAuthority, vaultAuthority,
// each ReserveAsset/vault PDA) is independently re-derived from the Reserve
// address itself, and each ReserveAsset is fetched and checked (exists,
// enabled, actually belongs to this Reserve) before being trusted. This
// avoids getProgramAccounts entirely (confirmed blocked/403 on the public
// DevNet RPC, see DEVNET_RUNBOOK.md) while still never trusting unverified
// client input for anything that moves funds.
//
// Blast-radius notes: the swap authority only ever mints the pre-approved
// DevNet test asset mints (ALLOWED_ASSET_MINTS below) and only ever spends
// its own SOL balance by an amount it computes itself from live on-chain
// state -- a malicious client cannot get more out than the SOL/tokens they
// actually put in, since the underlying protocol instruction still enforces
// its own accounting atomically in the same transaction. A Reserve whose
// assets are NOT all in ALLOWED_ASSET_MINTS is rejected with a specific
// "asset mint not supported" error, not a generic "unknown Reserve" error.

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildReadOnlyProgram,
  fetchReserveOnChain,
  buildBuyZapInstructions,
  buildBuyZapInstructionsDevUsdc,
  buildSellZapInstructions,
  findProtocolConfig,
  findReserveTokenMint,
  findMintAuthority,
  findVaultAuthority,
  DEVNET_FIXTURES,
  WRAPPED_SOL_MINT,
  DEVUSDC,
  DEVUSDC_MINT,
} from "../../packages/sdk/src";
import { loadDevnetAuthority } from "./_lib/authority";
import { resolveRpcUrl } from "./_lib/rpc";
import { isRateLimitError, withRateLimitRetry } from "../../src/merge/lib/rpcResilience";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

const RPC_URL = resolveRpcUrl();
const PROGRAM_ID = new PublicKey(DEVNET_FIXTURES.programId);

// Conservative buffer (in lamports) added on top of a computed swap-authority
// SOL requirement: covers the wrapped-SOL ATA's rent-exempt minimum if it
// doesn't already exist (~2,039,280 lamports for a standard 165-byte SPL
// token account) plus a small safety margin -- never exact-to-the-lamport,
// deliberately generous so a near-miss still fails closed with an honest
// error here rather than a confusing Phantom simulation failure later.
const SWAP_AUTHORITY_SOL_BUFFER_LAMPORTS = 5_000_000n;

/** A distinguishable, non-500 failure so the client can tell "the DevNet swap adapter itself is out of SOL" apart from "your wallet lacks SOL" or "RPC congestion" -- never conflated into one generic message. */
export class SwapAuthorityLowSolError extends Error {
  code = "swap_authority_low_sol" as const;
  constructor(requiredLamports: bigint, availableLamports: bigint) {
    super(
      `The DevNet swap adapter's own SOL balance (${(Number(availableLamports) / 1e9).toFixed(4)} SOL) is too low to fund this transaction's wrapped-SOL/settlement leg (needs at least ${(Number(requiredLamports) / 1e9).toFixed(4)} SOL). This is not a problem with your wallet -- please try again shortly or use a smaller amount.`,
    );
    this.name = "SwapAuthorityLowSolError";
  }
}

/** Sums the required lamport amount for any leg that is wrapped SOL -- that's the only part of a Buy the swap authority itself funds in real SOL (every other leg is a token mint/transfer). `assetAmountsRaw` is index-aligned with `assets`, both ordered identically to onChain.assets. */
export function sumWrappedSolLegLamports(assets: { mint: string }[], assetAmountsRaw: bigint[]): bigint {
  let total = 0n;
  for (let i = 0; i < assets.length; i++) {
    if (assets[i].mint === WRAPPED_SOL_MINT.toBase58()) total += assetAmountsRaw[i];
  }
  return total;
}

/** Live SOL-sufficiency check for the swap authority BEFORE handing a transaction back to the client -- avoids ever returning a transaction Phantom's own preflight simulation would reject for a signer other than the connected wallet (which Phantom's generic UI can misreport as "insufficient SOL" against the wrong account). */
async function assertSwapAuthorityHasSol(connection: Connection, swapAuthority: PublicKey, requiredLamports: bigint): Promise<void> {
  if (requiredLamports <= 0n) return;
  const balance = BigInt(await withRateLimitRetry(() => connection.getBalance(swapAuthority, "confirmed"), 3, 500));
  const required = requiredLamports + SWAP_AUTHORITY_SOL_BUFFER_LAMPORTS;
  if (balance < required) {
    throw new SwapAuthorityLowSolError(required, balance);
  }
}

type MintMeta = { address: string; decimals: number; symbol: string };
// Wrapped SOL is allowed here for READS/entitlement math only -- the swap
// authority has no mint authority over it (nobody does; it's the canonical
// SPL wrapped-SOL mint) so a Buy/Sell leg involving it is handled specially
// (wrap/unwrap real SOL instead of mintTo) inside zapInstructions.ts.
const ALLOWED_ASSET_MINTS = new Set([
  ...Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => m.address),
  WRAPPED_SOL_MINT.toBase58(),
  DEVUSDC.mint, // Phase C: the swap authority is also devUSDC's mint authority, same as mintX/Y/Z.
]);
const ASSET_TEST_PRICES_USD: Record<string, number> = {
  ...Object.fromEntries(Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => [m.address, 1])),
  [WRAPPED_SOL_MINT.toBase58()]: 20, // matches SOL_TEST_PRICE_USD -- wrapped SOL IS SOL
  [DEVUSDC.mint]: 1, // devUSDC is pegged to $1 by design (it's a test USD stand-in)
};

function parseBody(req: ApiRequest): Record<string, unknown> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let swapAuthority: Keypair;
  try {
    swapAuthority = loadDevnetAuthority();
  } catch {
    res.status(500).json({ error: "DevNet swap adapter is not configured on this deployment." });
    return;
  }

  const body = parseBody(req);
  const action = body.action;
  const reserveAddress = typeof body.reserve === "string" ? body.reserve : "";
  const userPubkeyStr = typeof body.userPubkey === "string" ? body.userPubkey : "";
  const candidateMintStrs = Array.isArray(body.assetMints) ? (body.assetMints as unknown[]).filter((m): m is string => typeof m === "string") : [];

  if (action !== "buy" && action !== "buy-devusdc" && action !== "sell") {
    res.status(400).json({ error: "action must be 'buy', 'buy-devusdc', or 'sell'" });
    return;
  }
  let reserve: PublicKey;
  try {
    reserve = new PublicKey(reserveAddress);
  } catch {
    res.status(400).json({ error: "Invalid reserve address." });
    return;
  }
  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(userPubkeyStr);
  } catch {
    res.status(400).json({ error: "Invalid userPubkey." });
    return;
  }
  if (candidateMintStrs.length === 0) {
    res.status(400).json({ error: "assetMints must be a non-empty array of the Reserve's registered asset mints." });
    return;
  }
  let candidateMints: PublicKey[];
  try {
    candidateMints = candidateMintStrs.map((m) => new PublicKey(m));
  } catch {
    res.status(400).json({ error: "assetMints contains an invalid pubkey." });
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");

  // --- Dynamic Reserve validation: no hard-coded Reserve list. ---
  // Every address below is independently re-derived from `reserve` itself,
  // then verified against live on-chain state -- nothing here trusts the
  // client beyond "this is the Reserve I mean" and "these are its assets."
  const protocolConfig = findProtocolConfig(PROGRAM_ID)[0];
  const [reserveTokenMint] = findReserveTokenMint(reserve, PROGRAM_ID);
  const [mintAuthority] = findMintAuthority(reserve, PROGRAM_ID);
  const [vaultAuthority] = findVaultAuthority(reserve, PROGRAM_ID);

  try {
    // Every genuine RPC read in this handler (this one included) is wrapped
    // in the same bounded rate-limit retry the frontend already uses --
    // AND, critically, now lives inside this try block, so a 429 that
    // survives the retry is caught and formatted as a normal JSON error
    // below instead of escaping as an unhandled platform-level exception
    // (which is how a raw "429 Connection rate limits exceeded" string was
    // reaching the client verbatim before this fix).
    const onChain = await withRateLimitRetry(() => fetchReserveOnChain(connection, PROGRAM_ID, reserve, candidateMints), 3, 500);
    if (!onChain) {
      res.status(404).json({ error: "Reserve not found on-chain (not a real SSR Protocol Reserve account)." });
      return;
    }
    if (onChain.assets.length !== candidateMints.length || onChain.assets.length !== onChain.assetCount) {
      res.status(400).json({
        error: `Reserve has ${onChain.assetCount} registered asset(s), but ${onChain.assets.length} of the ${candidateMints.length} supplied mint(s) matched a real, registered Reserve Asset. Supply the exact registered asset mint list.`,
      });
      return;
    }
    const unsupportedMints = onChain.assets.filter((a) => !ALLOWED_ASSET_MINTS.has(a.assetMint)).map((a) => a.assetMint);
    if (unsupportedMints.length > 0) {
      res.status(400).json({
        error: `The DevNet swap adapter is not authorized to zap the following Reserve asset mint(s): ${unsupportedMints.join(", ")}. Only the DevNet fixture test assets and wrapped SOL are supported.`,
      });
      return;
    }
    if (onChain.status !== "active") {
      res.status(409).json({ error: `Reserve is not Active (status: ${onChain.status}) -- Buy/Sell unavailable.` });
      return;
    }

    const zapAssets = onChain.assets.map((a) => ({
      mint: a.assetMint,
      decimals: a.decimals,
      reserveAsset: a.reserveAsset,
      vault: a.vault,
      vaultBalanceRaw: a.vaultBalanceRaw,
    }));

    const program = buildReadOnlyProgram(connection) as unknown as import("@anchor-lang/core").Program<import("@anchor-lang/core").Idl>;

    if (action === "buy") {
      const solLamportsRaw = typeof body.solLamports === "string" ? body.solLamports : "";
      const solLamports = BigInt(solLamportsRaw);
      if (solLamports <= 0n) {
        res.status(400).json({ error: "solLamports must be a positive integer string." });
        return;
      }

      const result = await buildBuyZapInstructions({
        program,
        protocolConfig,
        reserve,
        reserveTokenMint,
        mintAuthority,
        user: userPubkey,
        swapAuthority: swapAuthority.publicKey,
        assets: zapAssets,
        reserveTokenSupplyRaw: onChain.reserveTokenSupplyRaw,
        solLamports,
        assetTestPricesUsd: ASSET_TEST_PRICES_USD,
      });

      await assertSwapAuthorityHasSol(connection, swapAuthority.publicKey, sumWrappedSolLegLamports(zapAssets, result.assetAmountsRaw));

      const tx = new Transaction();
      tx.add(...result.instructions);
      tx.feePayer = userPubkey;
      const { blockhash, lastValidBlockHeight } = await withRateLimitRetry(() => connection.getLatestBlockhash("confirmed"), 3, 500);
      tx.recentBlockhash = blockhash;
      tx.partialSign(swapAuthority);

      res.status(200).json({
        transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
        lastValidBlockHeight,
        quote: {
          reserveTokensRequested: result.reserveTokensRequested?.toString(),
          assetAmountsRaw: result.assetAmountsRaw.map((a) => a.toString()),
        },
      });
      return;
    }

    if (action === "buy-devusdc") {
      const devUsdcAmountRawStr = typeof body.devUsdcAmountRaw === "string" ? body.devUsdcAmountRaw : "";
      const devUsdcAmountRaw = BigInt(devUsdcAmountRawStr);
      if (devUsdcAmountRaw <= 0n) {
        res.status(400).json({ error: "devUsdcAmountRaw must be a positive integer string." });
        return;
      }

      const result = await buildBuyZapInstructionsDevUsdc({
        program,
        protocolConfig,
        reserve,
        reserveTokenMint,
        mintAuthority,
        user: userPubkey,
        swapAuthority: swapAuthority.publicKey,
        assets: zapAssets,
        reserveTokenSupplyRaw: onChain.reserveTokenSupplyRaw,
        devUsdcMint: DEVUSDC_MINT,
        devUsdcDecimals: DEVUSDC.decimals,
        devUsdcAmountRaw,
        assetTestPricesUsd: ASSET_TEST_PRICES_USD,
      });

      await assertSwapAuthorityHasSol(connection, swapAuthority.publicKey, sumWrappedSolLegLamports(zapAssets, result.assetAmountsRaw));

      const tx = new Transaction();
      tx.add(...result.instructions);
      tx.feePayer = userPubkey;
      const { blockhash, lastValidBlockHeight } = await withRateLimitRetry(() => connection.getLatestBlockhash("confirmed"), 3, 500);
      tx.recentBlockhash = blockhash;
      tx.partialSign(swapAuthority);

      res.status(200).json({
        transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
        lastValidBlockHeight,
        quote: {
          reserveTokensRequested: result.reserveTokensRequested?.toString(),
          assetAmountsRaw: result.assetAmountsRaw.map((a) => a.toString()),
          legSources: result.legSources,
        },
      });
      return;
    }

    // sell
    const reserveTokensToRedeemRaw = typeof body.reserveTokensToRedeem === "string" ? body.reserveTokensToRedeem : "";
    const reserveTokensToRedeem = BigInt(reserveTokensToRedeemRaw);
    if (reserveTokensToRedeem <= 0n) {
      res.status(400).json({ error: "reserveTokensToRedeem must be a positive integer string." });
      return;
    }

    const reserveAccount: any = await withRateLimitRetry(() => (program.account as any).reserve.fetch(reserve), 3, 500);
    const redemptionFeeBps = BigInt(reserveAccount.feeConfig.redemptionFeeBps);

    const result = await buildSellZapInstructions({
      program,
      reserve,
      reserveTokenMint,
      vaultAuthority,
      user: userPubkey,
      swapAuthority: swapAuthority.publicKey,
      assets: zapAssets,
      reserveTokenSupplyRaw: onChain.reserveTokenSupplyRaw,
      redemptionFeeBps,
      reserveTokensToRedeem,
      assetTestPricesUsd: ASSET_TEST_PRICES_USD,
    });

    // Sell always pays the user out of the swap authority's own SOL balance
    // (see zapInstructions.ts's buildSellZapInstructions) -- unlike the Buy
    // legs, this is the FULL sale proceeds, not just a wrapped-SOL leg.
    await assertSwapAuthorityHasSol(connection, swapAuthority.publicKey, result.solLamportsOut);

    const tx = new Transaction();
    tx.add(...result.instructions);
    tx.feePayer = userPubkey;
    const { blockhash, lastValidBlockHeight } = await withRateLimitRetry(() => connection.getLatestBlockhash("confirmed"), 3, 500);
    tx.recentBlockhash = blockhash;
    tx.partialSign(swapAuthority);

    res.status(200).json({
      transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      lastValidBlockHeight,
      quote: {
        assetAmountsRaw: result.assetAmountsRaw.map((a) => a.toString()),
        solLamportsOut: result.solLamportsOut.toString(),
      },
    });
  } catch (e) {
    if (e instanceof SwapAuthorityLowSolError) {
      res.status(503).json({ error: e.message, code: e.code });
      return;
    }
    if (isRateLimitError(e)) {
      res.status(503).json({
        error: "Solana DevNet RPC is temporarily congested. Please try again in a few seconds.",
        code: "rpc_congested",
      });
      return;
    }
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to build the DevNet swap transaction.", code: "build_failed" });
  }
}
