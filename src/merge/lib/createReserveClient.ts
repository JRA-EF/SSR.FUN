// Browser-side orchestration for real Reserve creation (see
// docs/protocol/FRONTEND_INTEGRATION.md "Create Reserve flow"). A clear,
// multi-step sequence of ordinary single-signer transactions (the connecting
// wallet is simply the new Reserve's manager) plus one server-signed DevNet
// faucet call to seed the manager's wallet with test assets before the final
// seedReserve call.
//
// Signature count (DEC-0031): createReserve and every initializeReserveAsset
// are combined into ONE transaction (they share most of their accounts --
// protocolConfig, reserve, manager, tokenProgram, systemProgram -- so
// Solana's deduplicated account-key table keeps this well under the
// legacy 1232-byte transaction limit for the realistic 1-3 asset case).
// Seeding stays a separate, final transaction: it depends on the funding
// step (the DevNet faucet call, or the creator wrapping their own SOL)
// having already landed, and its remaining_accounts add enough bytes per
// asset that combining it in as well would risk exceeding the size limit
// for a 3-asset Reserve. Net result: 2 wallet approvals, down from 3.
//
// Resumability note: each step is a real, separately-confirmed transaction,
// and onProgress reports exactly which step is in flight so a failure is
// never presented as ambiguous success. A failure any time from
// create-and-register onward now preserves the ORIGINAL Reserve identity --
// see PendingReserveDeploy and resumeReserveDeploymentOnChain below, which
// read real on-chain state (never a cached/local assumption) to detect
// exactly which step is incomplete and continue from there, rather than
// starting a fresh createReserve call that would reserve a brand new
// reserve_id and orphan the original (the previously-documented behavior --
// see git history -- and the confirmed root cause of the "UI tells the user
// to create another Reserve despite one already existing" report).
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  buildInitializeManagerFeeRecipientsInstruction,
  buildAddDelegateInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  fetchReserveOnChain,
  describeOnChainError,
  findMintAuthority,
  findVaultAuthority,
  findProtocolConfig,
  findDelegate,
  validateFeeRecipientInputs,
  validateMetadataUri,
  computeEffectiveFeeSplit,
  validateSeedPlan,
  MIN_SEED_AMOUNT_PER_ASSET,
  DEVNET_FIXTURES,
  WRAPPED_SOL_MINT,
  PROTOCOL_MIN_MINT_FEE_BPS,
  SOL_TEST_PRICE_USD,
  isSupportedAssetMint,
  MAINNET_USDC_MINT,
  type NewReserveAddresses,
  type ReserveAssetAddresses,
  type ReserveOnChain,
  type RecipientInput,
} from "@ssr/sdk";
import { fetchJupiterSwapQuote, executeJupiterSwap } from "./jupiterSwapClient";
import { isRateLimitError, withRateLimitRetry, AmbiguousConfirmationError, confirmSignatureBounded, getCached } from "./rpcResilience";
import {
  computeFundingShortfall,
  computeSwapShortfallPct,
  determineDeploymentResumePoint,
  scaleUsdcBudgetForDeficit,
  isDustDeficit,
  isWithinAcceptableShortfallTolerance,
  type ReserveOnChainStatus,
} from "./createReserveResume";
import { advanceAssetFunding, canEnterSeeding, countReadyToSeed, type AssetFundingStatus, type PersistedAssetFunding } from "./launchFunding";
import { PERMISSION_FLAGS } from "./onChainPermissions";

/**
 * Exactly the capability set CreateDTR.tsx's "Additional Managers" copy
 * promises them at creation time ("They'll be able to rebalance, manage
 * fees, and pause the reserve, but won't be able to manage other
 * delegates -- only the root Manager (you) can do that.") -- granted as a
 * RESTRICTED delegate (never unrestricted; add_delegate.rs only allows the
 * root Manager to grant unrestricted, and the whole point here is "won't be
 * able to manage other delegates," which an unrestricted delegate could).
 * Deliberately excludes UPDATE_METADATA, MANAGE_LIQUIDITY_CONFIG, and both
 * *_RESTRICTED_DELEGATE flags -- none of those are promised by the copy
 * above, so none are granted.
 */
export const ADDITIONAL_MANAGER_PERMISSIONS =
  PERMISSION_FLAGS.UPDATE_TARGETS |
  PERMISSION_FLAGS.INITIATE_REBALANCE |
  PERMISSION_FLAGS.EXECUTE_REBALANCE |
  PERMISSION_FLAGS.MANAGE_FEES |
  PERMISSION_FLAGS.PAUSE_RESERVE |
  PERMISSION_FLAGS.UNPAUSE_RESERVE;

export {
  computeFundingShortfall,
  determineDeploymentResumePoint,
  isWalletRejectionError,
  classifyCreateReserveError,
  isFeeDestinationCollisionError,
  rawToUiAmount,
  scaleUsdcBudgetForDeficit,
  type CreateReserveErrorClass,
  type DeploymentResumePoint,
  type ReserveOnChainStatus,
} from "./createReserveResume";

export type CreateReserveStep = "create-and-register" | "fund-seed-assets" | "seed" | "done";

export interface CreateReserveAssetInput {
  mint: string;
  weightBps: number;
  /** Fraction of the total seed value allocated to this asset, e.g. 0.6 = 60%. */
  seedWeightFraction: number;
  decimals: number;
}

export interface CreateReserveResult {
  reserveId: string;
  reserve: string;
  reserveTokenMint: string;
  mintAuthority: string;
  vaultAuthority: string;
  assets: { mint: string; reserveAsset: string; vault: string; weightBps: number; decimals: number }[];
  /**
   * `createAndRegister`/`seed` are `null` when this result came from
   * `resumeReserveDeploymentOnChain` and that specific step was already
   * confirmed by an EARLIER attempt (this session never submitted it, so
   * there is no signature from this call to show) -- never a placeholder for
   * "unknown," always a genuine "not submitted by this call."
   */
  transactions: { createAndRegister: string | null; fundSeedAssets: string | null; seed: string | null };
}

function isWrappedSol(mint: string): boolean {
  return mint === WRAPPED_SOL_MINT.toBase58();
}

/**
 * Defense-in-depth guard against creating a Reserve that would immediately
 * fail the public eligibility check (packages/sdk's
 * evaluateReserveEligibility) -- CreateDTR.tsx's asset picker is already
 * built exclusively from SUPPORTED_ASSET_MINTS and already blocks duplicate/
 * over-100% selection at the UI layer, but this is the ONE choke point every
 * caller of createReserveOnChain goes through (the real UI today; any future
 * script or API entry point tomorrow), so it re-validates independently
 * rather than trusting caller-side state. Throws with a plain, user-showable
 * message -- never silently drops or auto-corrects a bad asset list.
 */
export function validateCreateReserveAssets(assets: CreateReserveAssetInput[]): void {
  if (assets.length === 0) {
    throw new Error("Select at least one reserve asset.");
  }
  const seenMints = new Set<string>();
  for (const a of assets) {
    if (!isSupportedAssetMint(a.mint)) {
      throw new Error(`Unsupported reserve asset (${a.mint}) -- only SSR.fun's canonical DevNet test assets can be selected.`);
    }
    if (seenMints.has(a.mint)) {
      throw new Error("Duplicate reserve asset selected -- each asset may appear only once.");
    }
    seenMints.add(a.mint);
  }
  const totalWeightBps = assets.reduce((sum, a) => sum + a.weightBps, 0);
  if (totalWeightBps <= 0 || totalWeightBps > 10_000) {
    throw new Error(`Invalid allocation total (${(totalWeightBps / 100).toFixed(2)}%) -- allocations must sum to more than 0% and no more than 100%.`);
  }
}

/** Validates and de-duplicates the "Additional Managers" list before it's turned into real add_delegate instructions -- never trusts caller-side UI state alone. Returns unique, valid wallet addresses excluding `manager` (which is always the root Manager already, and add_delegate.rs has no "grant yourself a delegate" concept). */
export function validateAdditionalManagers(addresses: string[], manager: PublicKey): PublicKey[] {
  const seen = new Set<string>();
  const result: PublicKey[] = [];
  for (const raw of addresses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let pk: PublicKey;
    try {
      pk = new PublicKey(trimmed);
    } catch {
      throw new Error(`"${trimmed}" is not a valid Solana wallet address.`);
    }
    if (pk.equals(manager)) {
      throw new Error("The connected wallet is already the Reserve's root Manager -- it can't also be added as an additional manager.");
    }
    const key = pk.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(pk);
  }
  return result;
}

/**
 * Estimates the NET Reserve Token amount a creator will actually receive
 * from seeding, given a gross seed target and the Reserve's configured Mint
 * Fee percent -- mirrors seed_reserve.rs's own on-chain fee formula exactly
 * (the initial seed is a mint like any other; previously fee-free, a
 * confirmed bug -- see docs/project/DECISION_LOG.md's entry for this fix).
 * Used by CreateDTR.tsx's Review step so "you'll receive X tokens" is
 * accurate instead of overstating by the fee percentage.
 */
export function estimateNetSeedReserveTokens(grossSeedTokens: number, mintFeePct: number): number {
  // Computed in RAW base units (6 decimals, matching handleSubmitReal's own
  // `initialReserveTokens = grossSeedTokens * 1_000_000` and seed_reserve.rs's
  // on-chain math exactly) -- NOT whole-token units. At whole-token
  // granularity, ceil-rounding a small percentage of a small token count
  // (e.g. 2% of 10) rounds the fee up to an entire extra token, understating
  // the real net amount by as much as a full token; raw-unit precision
  // matches what the chain will actually do.
  const RESERVE_TOKEN_RAW_PER_UNIT = 1_000_000n;
  const grossRaw = BigInt(Math.round(grossSeedTokens * Number(RESERVE_TOKEN_RAW_PER_UNIT)));
  const split = computeEffectiveFeeSplit(BigInt(Math.round(mintFeePct * 100)), PROTOCOL_MIN_MINT_FEE_BPS);
  const feeRaw = (grossRaw * split.effectiveTotalBps + 9_999n) / 10_000n; // ceiling division, matching mul_div_ceil
  const netRaw = grossRaw - feeRaw;
  return Number(netRaw) / Number(RESERVE_TOKEN_RAW_PER_UNIT);
}

export interface ReserveMetadataInput {
  name: string;
  ticker: string;
  description: string;
  category: string;
  buyTaxPct: number;
  sellTaxPct: number;
  /** Optional HTTPS URL of the Reserve's profile picture (the reserve-image store's permanent URL -- see reserveImageClient.ts). Omit entirely when the Reserve has none; the server also drops an empty value, keeping pre-existing payloads' content-addressed ids unchanged. */
  imageUrl?: string;
}

/**
 * Uploads a Reserve's off-chain metadata (name/ticker/description/category/
 * buyTaxPct/sellTaxPct) to this app's own permanent store
 * (api/devnet/reserve-metadata.ts or api/mainnet/reserve-metadata.ts,
 * selected by `cluster` -- see those files' headers: same generic,
 * cluster-agnostic backend, kept as two separate routes so a Mainnet
 * Reserve's metadata_uri can never end up minted under the
 * /api/devnet/-prefixed path) and returns the resulting short, permanent
 * HTTPS URL -- what CreateDTR.tsx submits on-chain as Reserve.metadata_uri,
 * NEVER the JSON payload itself. This is the fix for the confirmed root
 * cause of SsrError::MetadataUriTooLong: the previous flow built
 * `data:application/json,${encodeURIComponent(JSON.stringify({ name,
 * ticker, description, category, buyTaxPct, sellTaxPct }))}` and submitted
 * THAT directly on-chain -- routinely 300-600+ bytes for any real
 * name/description, against a 200-byte on-chain limit. See
 * packages/sdk/src/metadataUri.ts's header for the full writeup.
 *
 * The upload itself is idempotent server-side (content-hashed id, `on
 * conflict do nothing` insert -- see lib/reserve-metadata/payload.ts) so
 * calling this again with identical input (e.g. a debounced re-upload after
 * an edit, or a genuine retry after a transient network failure) can never
 * create a duplicate row or a different URL for the same content.
 *
 * Validates the resulting URL against the exact on-chain byte limit before
 * returning it -- defense in depth; by construction (this app's own short,
 * fixed-format URL scheme) this should always be far under the limit, but a
 * caller must never trust that without checking.
 */
export async function uploadReserveMetadata(origin: string, input: ReserveMetadataInput, cluster: "devnet" | "mainnet" = "devnet"): Promise<string> {
  const path = `/api/${cluster}/reserve-metadata`;
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body && typeof body.error === "string" && body.error) || `Failed to upload Reserve metadata (HTTP ${response.status}).`);
  }
  if (!body || typeof body.id !== "string" || !body.id) {
    throw new Error("Reserve metadata upload did not return a valid id.");
  }
  const uri = `${origin}${path}?id=${body.id}`;
  validateMetadataUri(uri);
  return uri;
}

/**
 * Converts a USD seed-allocation target into the raw token amount to deposit.
 * The DevNet fixture test assets are pegged 1 unit = $1 (see
 * FRONTEND_INTEGRATION.md), so their raw amount is just `usd * 10**decimals`.
 * Wrapped SOL is NOT 1:1 with USD -- it needs a real SOL/USD price to convert
 * correctly. `solPriceUsd` is caller-supplied (DevNet passes the fixed
 * SOL_TEST_PRICE_USD=$20 test peg; Mainnet MUST pass a real, live price) --
 * this function itself has no cluster awareness, so a caller that ever
 * passes the wrong one gets the wrong amount, not a silent DevNet/Mainnet
 * mismatch buried in here. **Real bug, not just a display issue** (2026-08-24,
 * road-to-mainnet MCR-01): before this fix, every Mainnet caller of this
 * function effectively used usdToSolLamports (the DevNet zap's own
 * SOL_TEST_PRICE_USD-based helper) regardless of cluster -- a Mainnet
 * creator including SOL in their Reserve was asked to wrap
 * (real SOL price / $20)x too much or too little real SOL for their stated
 * USD seed allocation, not merely shown a wrong number. Throws rather than
 * silently using a fabricated price if solPriceUsd isn't a real positive
 * number AND the asset is wrapped SOL -- an incorrect amount of real SOL
 * requested is a fund-safety issue, not something to guess through.
 */
export function seedRawAmountForAsset(asset: Pick<CreateReserveAssetInput, "mint" | "decimals">, usd: number, solPriceUsd: number): bigint {
  if (isWrappedSol(asset.mint)) {
    if (!(solPriceUsd > 0)) {
      throw new Error("A real current SOL/USD price is required to compute how much SOL to wrap for this Reserve, but none is available right now. Try again shortly.");
    }
    return BigInt(Math.floor((usd / solPriceUsd) * 1_000_000_000));
  }
  return BigInt(Math.max(1000, Math.floor(usd * 10 ** asset.decimals)));
}

// Real, on-chain-verified account sizes -- see programs/ssr_protocol/src/state
// (Reserve::SPACE, ReserveAsset::SPACE) and the SPL Token program's fixed
// Mint (82 bytes) / TokenAccount (165 bytes) layouts.
const RESERVE_ACCOUNT_BYTES = 377;
const RESERVE_ASSET_ACCOUNT_BYTES = 112;
const SPL_MINT_ACCOUNT_BYTES = 82;
const SPL_TOKEN_ACCOUNT_BYTES = 165;
/** Rough per-transaction network fee estimate (base fee only, no priority fee) -- actual cost may vary slightly. */
const ESTIMATED_TX_FEE_LAMPORTS = 5_000n;
/** A Jupiter swap transaction typically carries a priority fee Jupiter itself recommends (observed ~0.0001 SOL) on top of the base fee -- a plain instruction's 5,000-lamport estimate above would understate it. Used only for the worst-case "this asset might need a swap" count below; never charged for an asset the wallet already holds enough of. */
const ESTIMATED_JUPITER_SWAP_FEE_LAMPORTS = 110_000n;

export interface CreateReserveCostEstimate {
  /** Rent for the new Reserve account itself. */
  reserveRentLamports: bigint;
  /** Rent for the new Reserve Token mint account. */
  reserveTokenMintRentLamports: bigint;
  /** Rent for all ReserveAsset accounts combined (one per selected asset). */
  reserveAssetRentLamports: bigint;
  /** Rent for all per-asset vault token accounts combined. */
  vaultRentLamports: bigint;
  /** Rent for the creator's own Reserve Token ATA (created during seeding). */
  managerReserveTokenAtaRentLamports: bigint;
  /** Real SOL the creator must provide for any wrapped-SOL leg(s) of the initial seed -- 0 if no SOL/wSOL asset is selected. */
  solSeedFundingLamports: bigint;
  /** Sum of all account-creation rent above (does NOT include SOL seed funding or network fees). */
  totalRentLamports: bigint;
  /** Worst-case count of non-USDC/non-wrapped-SOL assets that may need a Jupiter swap to fund (Mainnet only) -- the ACTUAL count at launch time may be lower if the wallet already holds some of them; see fundSeedAssetsIdempotent's jupiterSwap path. */
  jupiterSwapCount: number;
  /** Estimated base network fees across every required transaction (create-and-register, fund-seed-assets, seed, and one per worst-case Jupiter swap above). */
  networkFeeLamportsEstimate: bigint;
  /** Grand total SOL the wallet will actually be asked to spend: rent + SOL seed funding + estimated network fees. This is a WORST-CASE total across every transaction the flow might submit -- Phantom (or any wallet) only ever shows the cost of the ONE transaction it's currently being asked to sign, so it will always show less than this per popup; see CreateDTR.tsx's Wallet Cost Summary copy. */
  totalLamports: bigint;
  numTransactions: number;
}

// --- Rent-constant fetch: cached + deduplicated + retried -----------------
// The 4 `getMinimumBalanceForRentExemption` calls below are for FIXED byte
// sizes -- Solana's rent schedule practically never changes, so these
// numbers are the same every time for a given RPC endpoint. Fetching them
// fresh on every keystroke/slider-drag (this used to run inside a
// same-array-identity-changes-every-tick useEffect in CreateDTR.tsx) was
// the actual root cause of the reported "429: Too many requests" launch
// failure -- 4 concurrent identical requests, repeated many times per
// second while a user adjusted weights, against the public DevNet RPC's
// documented rate limit (see docs/protocol/DEVNET_RUNBOOK.md). Fixed here
// by caching the result (bounded TTL, not forever, in case a rent schedule
// change is ever deployed), deduplicating any concurrent callers onto the
// same in-flight request, and retrying a genuine 429 with bounded
// exponential backoff + jitter rather than the caller's effect just
// refiring the whole burst again.
//
// isRateLimitError/withRateLimitRetry themselves now live in the shared
// rpcResilience.ts (reused by RealReserveSync/DTRDetail/zapClient's own
// resilience pass -- see PROJECT_STATUS.md) -- re-exported here so existing
// importers of this module don't need to change.
export { isRateLimitError, withRateLimitRetry };

const RENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes -- bounded, not indefinite.
interface RentConstants {
  reserveRent: number;
  mintRent: number;
  assetRent: number;
  vaultRent: number;
}
let rentCache: { endpoint: string; value: RentConstants; expiresAt: number } | null = null;
let rentInFlight: { endpoint: string; promise: Promise<RentConstants> } | null = null;

export async function getRentConstants(connection: Connection): Promise<RentConstants> {
  const endpoint = connection.rpcEndpoint;
  const now = Date.now();
  if (rentCache && rentCache.endpoint === endpoint && rentCache.expiresAt > now) {
    return rentCache.value;
  }
  if (rentInFlight && rentInFlight.endpoint === endpoint) {
    return rentInFlight.promise;
  }

  const promise = withRateLimitRetry(async () => {
    const [reserveRent, mintRent, assetRent, vaultRent] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(RESERVE_ACCOUNT_BYTES),
      connection.getMinimumBalanceForRentExemption(SPL_MINT_ACCOUNT_BYTES),
      connection.getMinimumBalanceForRentExemption(RESERVE_ASSET_ACCOUNT_BYTES),
      connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_BYTES),
    ]);
    return { reserveRent, mintRent, assetRent, vaultRent };
  })
    .then((value) => {
      rentCache = { endpoint, value, expiresAt: Date.now() + RENT_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      if (rentInFlight && rentInFlight.endpoint === endpoint) rentInFlight = null;
    });

  rentInFlight = { endpoint, promise };
  return promise;
}

/**
 * Computes a real, on-chain-rent-calculator-backed cost estimate BEFORE any
 * signature is requested -- see CreateDTR.tsx's Review & Deploy step. Never
 * submits a transaction -- a failure here (e.g. rate-limiting) can never
 * mean a launch partially happened.
 *
 * `solPriceUsd` -- see seedRawAmountForAsset's header for why this must be a
 * REAL current price on Mainnet, never a fixed test peg: it determines the
 * actual lamport amount a SOL-including Reserve's creator is asked to wrap,
 * not just a display number.
 */
export async function estimateCreateReserveCost(
  connection: Connection,
  assets: CreateReserveAssetInput[],
  seedTotalUsd: number,
  solPriceUsd: number,
): Promise<CreateReserveCostEstimate> {
  const { reserveRent, mintRent, assetRent, vaultRent } = await getRentConstants(connection);

  const reserveAssetRentLamports = BigInt(assetRent) * BigInt(assets.length);
  const vaultRentLamports = BigInt(vaultRent) * BigInt(assets.length);
  const managerReserveTokenAtaRentLamports = BigInt(vaultRent); // an ATA is a TokenAccount, same size/rent

  const wrapAssets = assets.filter((a) => isWrappedSol(a.mint));
  const solSeedFundingLamports = wrapAssets.reduce((sum, a) => sum + seedRawAmountForAsset(a, seedTotalUsd * a.seedWeightFraction, solPriceUsd), 0n);
  // Wrapping SOL needs its own ATA + rent, paid by the creator, on top of the amount wrapped.
  const wsolAtaRent = wrapAssets.length > 0 ? BigInt(vaultRent) : 0n;

  const totalRentLamports =
    BigInt(reserveRent) + BigInt(mintRent) + reserveAssetRentLamports + vaultRentLamports + managerReserveTokenAtaRentLamports + wsolAtaRent;

  // Worst case: every non-USDC/non-wrapped-SOL asset needs its own Jupiter
  // swap transaction to fund (see fundSeedAssetsIdempotent) -- the real
  // count at launch time may be lower (an asset the wallet already holds
  // enough of needs no swap at all), so this is an upper bound, never an
  // underestimate.
  const jupiterSwapCount = assets.filter((a) => !isWrappedSol(a.mint) && a.mint !== MAINNET_USDC_MINT).length;

  // Registering many assets can now span more than one transaction (see
  // createReserveClient.ts's packInstructionsBySize -- a real 10-asset
  // Reserve produced a 1830-byte transaction against Solana's 1232-byte
  // limit). The exact real count depends on metadata URI length and
  // recipient/delegate instructions this function doesn't have yet, so this
  // is a conservative display-only estimate (never fewer transactions than
  // packInstructionsBySize will actually need for a plain asset list) --
  // the real submission always uses exact, measured packing regardless.
  const ASSETS_PER_REGISTER_BATCH_ESTIMATE = 6;
  const registerBatches = Math.max(1, Math.ceil(assets.length / ASSETS_PER_REGISTER_BATCH_ESTIMATE));
  const numTransactions = 1 /* seed */ + registerBatches + (wrapAssets.length > 0 ? 1 : 0) + jupiterSwapCount;
  const networkFeeLamportsEstimate = ESTIMATED_TX_FEE_LAMPORTS * BigInt(numTransactions - jupiterSwapCount) + ESTIMATED_JUPITER_SWAP_FEE_LAMPORTS * BigInt(jupiterSwapCount);

  return {
    reserveRentLamports: BigInt(reserveRent),
    reserveTokenMintRentLamports: BigInt(mintRent),
    reserveAssetRentLamports,
    vaultRentLamports,
    managerReserveTokenAtaRentLamports,
    solSeedFundingLamports,
    totalRentLamports,
    jupiterSwapCount,
    networkFeeLamportsEstimate,
    totalLamports: totalRentLamports + solSeedFundingLamports + networkFeeLamportsEstimate,
    numTransactions,
  };
}

/**
 * Solana's hard legacy-transaction wire-size ceiling (@solana/web3.js's own
 * `PACKET_DATA_SIZE`, asserted inside `Transaction.serialize()`) -- the exact
 * number a real failure surfaced as "Transaction too large: 1830 > 1232"
 * (2026-08-24, road-to-mainnet MCR-01): creating a Reserve with 10 assets
 * bundled `createReserve` + 10 `initializeReserveAsset` instructions into one
 * transaction, which genuinely cannot fit -- confirmed nothing was created
 * on-chain (the assert throws during signing/serialization, before
 * submission). Re-declared here rather than imported: the library doesn't
 * export the constant, only asserts against it internally.
 */
const SOLANA_MAX_TX_BYTES = 1232;

// --- Priority fees + rebroadcast (2026-08-27 DELTA launch incident) --------
// Root cause, established from Mainnet history: every app-built transaction
// here was submitted with NO priority fee (base 5000 lamports only --
// confirmed on the landed create transaction), exactly ONCE (`maxRetries: 0`,
// `skipPreflight: true`), and never rebroadcast. Under Mainnet fee-market
// load, the 10-asset DELTA seed transaction (and the subsequent Resume's
// lookup-table transactions) were silently dropped -- no ledger record at
// all, surfacing as AmbiguousConfirmationError after the bounded poll. The
// fix is the standard pair: (1) every transaction carries an explicit
// compute-unit price sourced from the RPC's recent-prioritization-fee view,
// and (2) the signed transaction is re-sent every few seconds until the
// chain gives a definitive answer or its blockhash genuinely expires.
// Re-sending the SAME signed bytes is idempotent by construction -- the
// signature IS the dedupe key, so this can never double-execute.

/** Never bid below this (µLamports/CU) -- even a quiet fee market ignores literal-zero bids under load. Cost at the default 200k CU budget: 2,000 lamports (~$0.0004). */
export const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 10_000;
/** Never bid above this -- bounds the worst-case fee for a 1.4M-CU transaction to ~0.0007 SOL, so a manipulated/outlier RPC fee view can't make a launch expensive. */
export const PRIORITY_FEE_CEILING_MICROLAMPORTS = 500_000;
/** Used when the RPC cannot answer getRecentPrioritizationFees at all. */
export const PRIORITY_FEE_FALLBACK_MICROLAMPORTS = 100_000;

/**
 * Picks the compute-unit price to bid from the RPC's recent per-slot
 * prioritization fees: the 75th percentile of the NONZERO observations
 * (zero-fee slots say "there was room", not "zero wins under load"),
 * clamped to [floor, ceiling]. Pure and exported for offline tests.
 */
export function pickPriorityFeeMicroLamports(
  recentFees: number[],
  floor: number = PRIORITY_FEE_FLOOR_MICROLAMPORTS,
  ceiling: number = PRIORITY_FEE_CEILING_MICROLAMPORTS,
): number {
  const nonzero = recentFees.filter((f) => Number.isFinite(f) && f > 0).sort((a, b) => a - b);
  if (nonzero.length === 0) return floor;
  const p75 = nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * 0.75))];
  return Math.min(ceiling, Math.max(floor, p75));
}

/** Cached briefly (per endpoint) so a multi-transaction flow (create batches, lookup-table steps, seed) prices from one consistent read instead of hammering the RPC once per transaction. Exported for managementClient.ts, which applies the same fix to every Manage action. */
export async function fetchPriorityFeeMicroLamports(connection: Connection): Promise<number> {
  return getCached(`priority-fee:${connection.rpcEndpoint}`, 15_000, async () => {
    try {
      const fees = await connection.getRecentPrioritizationFees();
      return pickPriorityFeeMicroLamports(fees.map((f) => f.prioritizationFee));
    } catch {
      return PRIORITY_FEE_FALLBACK_MICROLAMPORTS;
    }
  });
}

/**
 * Wire bytes reserved for the prepended ComputeBudget instructions --
 * setComputeUnitPrice always (program key 32 + header ~4 + 9 data bytes)
 * plus, for transactions that carry one, setComputeUnitLimit (~14 more
 * bytes; the ComputeBudget program key is already in the account list by
 * then). packInstructionsBySize and the over-limit check subtract this so
 * a batch measured near the cap can't overflow once the real instructions
 * are added at signing time.
 */
export const PRIORITY_FEE_IX_RESERVED_BYTES = 64;

/**
 * Explicit compute-unit limit for a seed_reserve transaction of `assetCount`
 * assets. THE DEC-0166 ROOT-CAUSE FIX: seed_reserve was always submitted
 * without a setComputeUnitLimit instruction, so it ran under the runtime's
 * default ~200k budget -- measured real consumption is CU(n) ~= 53k + 16.7k*n
 * (CHARLI 4-asset seed: 119,408 CU; DELTA 10-asset seed, simulation-proven:
 * 219,754 CU), meaning a 10-asset seed can NEVER fit the default and died
 * deterministically at "exceeded CUs meter". This budgets ~2x the measured
 * model (headroom for init_if_needed ATA-creation variance, ~13.5k each),
 * capped at Solana's 1.4M per-transaction maximum. At the program's own
 * 12-asset validation cap this is 580k -- comfortably under the cap, which
 * is what makes 10-asset Reserves supportable with NO program change.
 * Priority-fee cost scales with the requested limit (price x limit), so this
 * stays deliberately proportional rather than a flat 1.4M.
 */
export function seedComputeUnitLimit(assetCount: number): number {
  const count = Math.max(1, Math.ceil(assetCount));
  return Math.min(1_400_000, 100_000 + 40_000 * count);
}

/**
 * Submits already-signed transaction bytes and keeps re-sending them every
 * few seconds while the bounded status poll runs -- the direct fix for the
 * observed silent drops (see the section comment above). The poll window is
 * widened past the blockhash's own lifetime so a dropped transaction
 * resolves as a definitive "expired" (safe to retry from scratch) instead
 * of the ambiguous "may still land".
 */
export async function submitAndConfirmWithRebroadcast(
  connection: Connection,
  serialized: Uint8Array,
  lastValidBlockHeight: number,
): Promise<{ signature: string; outcome: Awaited<ReturnType<typeof confirmSignatureBounded>> }> {
  const signature = await connection.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 });
  const rebroadcast = setInterval(() => {
    void connection.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 }).catch(() => {
      // An "already processed" rejection here means it landed -- the poll
      // below reports that; any other transient send failure just waits for
      // the next tick.
    });
  }, 3_000);
  try {
    const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight, { maxAttempts: 45 });
    return { signature, outcome };
  } finally {
    clearInterval(rebroadcast);
  }
}

/**
 * Greedily packs instructions into the fewest legacy transactions that each
 * stay under SOLANA_MAX_TX_BYTES, WITHOUT ever reordering them (the caller's
 * ordering is meaningful -- e.g. `createReserve` must be instruction 0 of
 * batch 0, since every `initializeReserveAsset` after it depends on the
 * Reserve it creates existing). Sizing is measured via a real, empty
 * `Transaction` (feePayer + a syntactically-valid dummy blockhash -- a
 * blockhash is always exactly 32 bytes regardless of its real value, so this
 * measures the true wire size without a network round trip) plus each
 * candidate instruction added in turn. On-chain, this is exactly what the
 * program's own `Created -> AssetsInitializing -> Active` status machine
 * (see programs/ssr_protocol/src/state/reserve.rs, "Tracks resumable
 * multi-step creation") was already designed to support: `create_reserve`
 * once, then any number of `initialize_reserve_asset` calls, in any number
 * of separate transactions, before `seed_reserve`. The bug this fixes was
 * purely client-side over-bundling, not a protocol limitation.
 *
 * A single instruction that alone exceeds the limit is still returned as its
 * own one-instruction batch (never split further, never dropped) -- not
 * reachable for this app's own instruction shapes, but safer than silently
 * discarding it.
 */
/**
 * The real, measured legacy-transaction wire size for `ixs` if signed by
 * exactly one signer (`feePayer` -- every instruction this app builds only
 * ever needs the connected wallet's own signature). Uses a real `Transaction`
 * + a syntactically-valid dummy blockhash (a blockhash is always exactly 32
 * bytes regardless of its real value, so this needs no network round trip)
 * -- shared by packInstructionsBySize (below) and
 * signAndSendPossiblyOverLimit (this file's Address-Lookup-Table fallback
 * for a single instruction that can't be split, e.g. seed_reserve).
 */
export function estimateSingleSignerTxBytes(feePayer: PublicKey, ixs: TransactionInstruction[]): number {
  const dummyBlockhash = SystemProgram.programId.toBase58(); // any valid base58 pubkey-shaped string is a valid-length (32-byte) stand-in for sizing purposes only.
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = dummyBlockhash;
  tx.add(...ixs);
  // Wire size = compact-array signature count/bytes + the compiled message itself.
  return 1 + 64 + tx.compileMessage().serialize().length;
}

export function packInstructionsBySize(feePayer: PublicKey, ixs: TransactionInstruction[]): TransactionInstruction[][] {
  const batches: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  for (const ix of ixs) {
    const candidate = [...current, ix];
    if (current.length > 0 && estimateSingleSignerTxBytes(feePayer, candidate) > SOLANA_MAX_TX_BYTES - PRIORITY_FEE_IX_RESERVED_BYTES) {
      batches.push(current);
      current = [ix];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Signs, submits, and confirms via bounded signature-status polling instead
 * of `connection.confirmTransaction`'s websocket subscription. Prepends a
 * priority-fee bid and re-sends the SAME signed bytes while polling (see
 * submitAndConfirmWithRebroadcast -- signature-idempotent, never a second
 * distinct transaction). Never re-signs on an ambiguous result; throws
 * AmbiguousConfirmationError (carrying the real signature) instead.
 *
 * Submits with `skipPreflight: true`. A live-observed failure ("Deployment
 * Failed (setup) -- Transaction simulation failed: Blockhash not found",
 * yet the Reserve was created on-chain anyway) traced to preflight
 * simulation running against a DIFFERENT RPC node than the one that served
 * `getLatestBlockhash` (expected with any multi-node provider/proxy, e.g.
 * Helius) -- that node hadn't yet seen the blockhash, so preflight rejected
 * a transaction that the cluster itself would have accepted, and the
 * eventual retry (or the original request landing anyway via a different
 * node) is exactly what produced a duplicate Reserve. `confirmSignatureBounded`
 * below is already this function's sole source of truth for the real
 * outcome (never preflight's simulated one), so preflight was only ever a
 * client-side gate that could reject a transaction the network would have
 * accepted -- removing it trades a same-node-consistency preflight check
 * (redundant with the real confirmation this function already performs) for
 * eliminating that specific, confirmed false-negative failure mode.
 */
/**
 * `clusterLabel` defaults to "DevNet" (matching every pre-existing caller/
 * test unchanged) rather than importing IS_MAINNET from ./solana-config
 * directly -- that module reads import.meta.env (Vite-only syntax) and this
 * file is required directly by tests/phase_reserve_deploy_resumability.ts
 * via ts-mocha's CommonJS loader, which crashes on that syntax (same
 * constraint documented in rpcResilience.ts's txPhaseLabel/
 * AmbiguousConfirmationError). CreateDTR.tsx passes its own real
 * CLUSTER_LABEL down through createReserveOnChain/resumeReserveDeploymentOnChain.
 */
async function signAndSend(
  connection: Connection,
  wallet: WalletContextState,
  ixs: TransactionInstruction[],
  clusterLabel: string = "DevNet",
  // When set, an explicit setComputeUnitLimit is prepended too (DEC-0166:
  // required for seed_reserve, whose real cost exceeds the runtime default
  // beyond ~8 assets). When omitted, the runtime's per-instruction default
  // applies exactly as before -- deliberately unchanged for every other
  // caller, since a blanket high limit would inflate priority-fee cost.
  computeUnitLimit?: number,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const microLamports = await fetchPriorityFeeMicroLamports(connection);
  const budgetIxs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
  if (computeUnitLimit !== undefined) budgetIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  const tx = new Transaction().add(...budgetIxs, ...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  // A rejection here (the user closed/declined the wallet popup) happens
  // strictly before any submission -- propagated as-is, with its real
  // wallet-adapter name/message intact, so isWalletRejectionError can
  // classify it downstream as "nothing was ever sent," never something
  // requiring on-chain reconciliation.
  const signed = await wallet.signTransaction(tx);
  const { signature, outcome } = await submitAndConfirmWithRebroadcast(connection, signed.serialize(), lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  // describeOnChainError decodes a real ssr_protocol custom-error code
  // (e.g. UnexpectedReserveStatus) against the deployed IDL when present, or
  // says plainly that an unrecognized code (like the reported "6400", which
  // is outside this program's entire 6000-6040 custom-error range) is not a
  // genuine ssr_protocol error -- never a guessed meaning either way.
  if (outcome.status === "failed") throw new Error(describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`)));
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature, clusterLabel);
}

/**
 * Signs, submits, and confirms a VersionedTransaction the same way
 * signAndSend does for a legacy one -- same submit/confirm/error-shape
 * contract, just Message v0 + an Address Lookup Table instead of a legacy
 * Message. Mirrors jupiterSwapClient.ts's executeJupiterSwap (the only other
 * place in this app that already signs a VersionedTransaction -- proof
 * Phantom/the wallet-adapter integration here already handles this
 * transaction type, not new wallet-compatibility risk).
 */
async function signSubmitConfirmVersioned(
  connection: Connection,
  wallet: WalletContextState,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  clusterLabel: string = "DevNet",
): Promise<string> {
  if (!wallet.signTransaction) throw new Error("This wallet does not support transaction signing.");
  const signed = await wallet.signTransaction(tx);
  const { signature, outcome } = await submitAndConfirmWithRebroadcast(connection, signed.serialize(), lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  if (outcome.status === "failed") throw new Error(describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`)));
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature, clusterLabel);
}

/**
 * Sends a SINGLE instruction that must stay atomic (never split across
 * transactions -- e.g. seed_reserve, which deposits every asset and mints
 * the initial Reserve Tokens in one on-chain call) even when it alone
 * exceeds Solana's legacy transaction size limit. Confirmed live (2026-08-24,
 * road-to-mainnet MCR-01): seeding a real 6-asset Mainnet Reserve produced a
 * 1432-byte transaction against the 1232-byte limit -- packInstructionsBySize
 * cannot help here (it never splits a single instruction, by design; there's
 * nothing else in this transaction TO split out into an earlier one, unlike
 * the create-and-register step, which bundles many independent instructions
 * together).
 *
 * The real fix: an Address Lookup Table (ALT), the standard Solana mechanism
 * for exactly this -- each of `ix`'s non-signer accounts is registered once
 * in a small on-chain table, and the final transaction references them by a
 * 1-byte table index instead of their full 32-byte pubkey, shrinking the
 * transaction enough to fit regardless of how many assets a Reserve holds.
 * This app's wallet integration already signs VersionedTransactions
 * successfully (see jupiterSwapClient.ts, in production since DEC-0124) --
 * this reuses that same proven capability, not a new one. Only used as a
 * fallback: a `ix` that already fits in a legacy transaction (the common
 * case, 1-5ish assets) is sent exactly as before, no ALT overhead at all.
 *
 * Costs a few extra wallet approvals and a short wait (creating + extending
 * the table, then waiting for it to warm up) ONLY when actually needed.
 */
async function signAndSendPossiblyOverLimit(
  connection: Connection,
  wallet: WalletContextState,
  ix: TransactionInstruction,
  onProgress?: (phase: "creating-lookup-table" | "waiting-for-lookup-table" | "submitting") => void,
  clusterLabel: string = "DevNet",
  // See signAndSend -- threaded to whichever submission shape is used.
  computeUnitLimit?: number,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const feePayer = wallet.publicKey;

  if (estimateSingleSignerTxBytes(feePayer, [ix]) <= SOLANA_MAX_TX_BYTES - PRIORITY_FEE_IX_RESERVED_BYTES) {
    onProgress?.("submitting");
    return signAndSend(connection, wallet, [ix], clusterLabel, computeUnitLimit);
  }

  onProgress?.("creating-lookup-table");
  // Only non-signer accounts can live in a lookup table -- the fee
  // payer/signer must stay directly in the transaction's own account list
  // for signature verification. Deduped: the same account (e.g. the token
  // program) can legitimately appear across several of this instruction's
  // per-asset account groups.
  const lookupAddresses = Array.from(new Set(ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58()))).map((s) => new PublicKey(s));

  const recentSlot = await connection.getSlot("finalized");
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({ authority: feePayer, payer: feePayer, recentSlot });
  await signAndSend(connection, wallet, [createIx], clusterLabel);

  // extendLookupTable's own transaction has the same size ceiling as any
  // other -- chunk conservatively (20 addresses/call fits comfortably; this
  // app's own instructions need at most a few dozen accounts total, so this
  // is at most 1-2 extend calls in practice).
  const EXTEND_CHUNK = 20;
  for (let i = 0; i < lookupAddresses.length; i += EXTEND_CHUNK) {
    const chunk = lookupAddresses.slice(i, i + EXTEND_CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({ lookupTable: lookupTableAddress, authority: feePayer, payer: feePayer, addresses: chunk });
    await signAndSend(connection, wallet, [extendIx], clusterLabel);
  }

  onProgress?.("waiting-for-lookup-table");
  // A lookup table only becomes usable once the CURRENT slot has genuinely
  // advanced past the slot it was derived from -- confirming the create/
  // extend transactions above already guarantees real time has passed, but
  // poll explicitly (bounded, ~15s) rather than assume, since this is a real
  // on-chain precondition (using it too early fails outright).
  const deadline = Date.now() + 15_000;
  let lookupTableAccount = null;
  while (Date.now() < deadline) {
    const currentSlot = await connection.getSlot("confirmed");
    if (currentSlot > recentSlot) {
      const resp = await connection.getAddressLookupTable(lookupTableAddress);
      if (resp.value && resp.value.isActive()) {
        lookupTableAccount = resp.value;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!lookupTableAccount) {
    // The table itself was already created/extended on-chain above (real,
    // confirmed transactions) -- only the warm-up wait timed out, which is
    // extremely unlikely given confirming those transactions already took
    // real time. Retrying re-derives a NEW table rather than reusing this
    // one (its address isn't persisted anywhere) -- a small amount of
    // abandoned rent, not a fund-safety issue; nothing from this attempt is
    // lost or duplicated.
    throw new Error("The address lookup table needed to submit this transaction did not become active in time. Please try again.");
  }

  onProgress?.("submitting");
  const microLamports = await fetchPriorityFeeMicroLamports(connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const budgetIxs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
  // DEC-0166: this versioned path carries the atomic seed -- the exact
  // instruction proven to exceed the runtime's default compute budget at
  // 10 assets ("exceeded CUs meter", consumed 202,850 of 202,850). The
  // explicit limit is what makes it executable at all; the priority-fee
  // bid (DEC-0165) is what makes it land.
  if (computeUnitLimit !== undefined) budgetIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [...budgetIxs, ix],
  }).compileToV0Message([lookupTableAccount]);
  const versionedTx = new VersionedTransaction(message);
  return signSubmitConfirmVersioned(connection, wallet, versionedTx, lastValidBlockHeight, clusterLabel);
}

/** Reads a wallet's real, current raw balance for a mint -- 0 if the ATA doesn't exist yet (never an error in that case, since "no ATA" and "zero balance" mean the same thing for funding purposes). */
async function fetchOwnedBalanceRaw(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const info = await connection.getTokenAccountBalance(ata);
    return BigInt(info.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Re-reads a mint balance after OUR OWN just-confirmed transaction, retrying
 * until it genuinely differs from `balanceBefore` -- a single immediate read
 * right after confirmation can hit an RPC node whose own view of account
 * state hasn't caught up yet (confirmed live: a real Jupiter swap read back
 * as 0 received immediately after confirming, while the wallet's actual
 * on-chain balance -- checked moments later against a fresh RPC query --
 * already correctly held the swapped tokens). Same root cause and same fix
 * shape as DEC-0115's post-redemption balance read (see
 * docs/project/DECISION_LOG.md). Returns whatever the last read saw even if
 * it never changed (never fabricates a change that didn't happen) -- the
 * caller decides what an unchanged/still-short result means.
 */
export async function fetchOwnedBalanceRawSettled(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  balanceBefore: bigint,
  // Overridable only so tests can exercise the real retry-until-changed loop
  // without actually waiting several real seconds -- every production
  // caller relies on the defaults (unchanged from before this was made
  // configurable).
  opts: { maxAttempts?: number; delayMs?: number; maxDelayMs?: number } = {},
): Promise<bigint> {
  const MAX_ATTEMPTS = opts.maxAttempts ?? 7;
  const BASE_DELAY_MS = opts.delayMs ?? 750;
  const MAX_DELAY_MS = opts.maxDelayMs ?? 4_000;
  let balance = balanceBefore;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    balance = await fetchOwnedBalanceRaw(connection, mint, owner);
    if (balance !== balanceBefore) return balance;
    if (attempt < MAX_ATTEMPTS - 1) {
      // Exponential backoff (750ms, 1.5s, 3s, capped at 4s) rather than a
      // fixed interval -- a reasonable timeout/backoff for RPC propagation
      // that's usually near-instant but occasionally takes a few seconds
      // longer under load, without making the common (fast) case wait
      // longer than it needs to.
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return balance;
}

export interface JupiterSwapFundingOptions {
  /** Mainnet only -- lets a non-USDC, non-wrapped-SOL asset be funded by actually swapping part of the creator's USDC into it via Jupiter, instead of requiring the creator to already hold that exact asset. */
  enabled: boolean;
  /** The Reserve's total USD seed value -- combined with each asset's own seedWeightFraction to size that asset's swap. */
  seedTotalUsd: number;
  onSwapStart?: (mint: string) => void;
  /**
   * Fired when a swap's real on-chain result came in meaningfully below the
   * live quote's expected output (beyond ordinary slippage) -- the Reserve
   * is still created/seeded with whatever the swap actually produced
   * (`actualRaw`), never blocked on this; the caller decides whether/how to
   * warn the user. Never fired for a shortfall within SHORTFALL_WARN_PCT.
   */
  onSwapShortfall?: (info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) => void;
}

/** Below this fraction short of the live quote's expected output, a swap's result is treated as ordinary slippage and never warned about -- comfortably above the default/typical slippageBps (150 = 1.5%) so routine execution-price movement never trips it. */
const SHORTFALL_WARN_PCT = 0.05;

/**
 * Below this raw USDC amount, a swap-eligible asset's remaining deficit is
 * treated as dust rather than swapped for -- Jupiter's own quote/slippage
 * computation can reject an amount this small outright (confirmed live,
 * 2026-08-25, a real Mainnet Reserve stuck in Resume across every retry:
 * "Cannot compute other amount threshold, with amount 1 and slippageBps
 * 150" for a scaled-down deficit quote -- scaleUsdcBudgetForDeficit's own
 * "never 0" floor of 1 raw unit is itself still too small for Jupiter to
 * apply a 150bps threshold to), and the swap's own network/priority fee
 * would exceed the value being topped up anyway. Only applies when the
 * wallet already holds SOME real balance for this asset (existingRaw >
 * 0n) -- an asset already this close to its target (from an earlier
 * attempt, or simply already held) is treated as "close enough," never
 * re-swapped for a few cents of remaining headroom. A genuinely EMPTY
 * asset (existingRaw === 0n) still attempts its full swap regardless of
 * size -- skipping that would silently seed with nothing at all, a real
 * gap rather than an acceptable rounding difference.
 */
const DUST_DEFICIT_USDC_RAW = 50_000n; // $0.05

/** True for any asset this app would consider swapping USDC into via Jupiter -- real Circle USDC and wrapped SOL are both funded through their own existing, non-swap paths. */
export function isJupiterSwapEligible(mint: string): boolean {
  return !isWrappedSol(mint) && mint !== MAINNET_USDC_MINT;
}

/**
 * Names WHICH asset is short before validateSeedPlan's generic (mint-
 * agnostic) message would -- most useful for a Jupiter-swapped asset whose
 * final amount is only known after the swap settles, where a genuinely
 * empty/near-empty result (a real swap failure, or an RPC-consistency read
 * that never settled even after fetchOwnedBalanceRawSettled's retries)
 * would otherwise reach buildSeedReserveInstruction and revert on-chain
 * with SsrError::SeedAmountTooLow, wasting a transaction.
 */
export function assertSeedAmountsMeetMinimum(assets: Pick<CreateReserveAssetInput, "mint">[], seedAmounts: bigint[]): void {
  for (let i = 0; i < assets.length; i++) {
    if (seedAmounts[i] < MIN_SEED_AMOUNT_PER_ASSET) {
      throw new Error(
        `${assets[i].mint} would be seeded with only ${seedAmounts[i]} raw units, below the protocol's minimum of ${MIN_SEED_AMOUNT_PER_ASSET} -- refusing to submit a transaction that would definitely revert on-chain. If this asset was just swapped for via Jupiter, wait a few seconds and try again (the wallet's real balance can take a moment to be visible to every RPC node after a swap confirms).`,
      );
    }
  }
}

/**
 * Funds only the genuine SHORTFALL between each asset's required seed amount
 * and what the wallet already, really holds -- the fix that makes
 * seed-funding idempotent. A first-time call behaves exactly as before
 * (shortfall against a zero balance is the full amount); a retry after a
 * partial success (e.g. the DevNet faucet call landed but the SOL-wrap tx
 * then hit an expired blockhash) tops up only what's still missing instead
 * of re-minting/re-wrapping the full amount again. Never submits anything
 * for an asset whose shortfall is already zero.
 *
 * Returns `finalSeedAmounts`, not just the input `seedAmounts` unchanged:
 * when `jupiterSwap.enabled`, a swap-eligible asset's target amount is
 * REPLACED -- with a live Jupiter quote's expected output amount if the
 * wallet already held enough (the caller's own `seedRawAmountForAsset`
 * estimate assumes every asset is pegged to $1, which is only true for
 * USDC itself), or with the REAL resulting balance after actually
 * executing a swap. That real amount is used whether it landed above,
 * within, or below the quote's expectation -- the Reserve is always
 * created with what the wallet genuinely ends up holding, never blocked on
 * a shortfall (see SHORTFALL_WARN_PCT/onSwapShortfall for when a caller is
 * merely notified instead). See docs/project/DECISION_LOG.md's entry for
 * this pass. The caller must pass `finalSeedAmounts`, not its original
 * `seedAmounts`, into buildSeedReserveInstruction.
 */
/** Per-asset funding progress event -- drives the "4 of 10 assets funded" display (see CreateDTR.tsx). `funded` counts assets fully `ready_to_seed`. */
export interface AssetFundingProgressEvent {
  funded: number;
  total: number;
  mint: string;
  stage: AssetFundingStatus;
}

export interface FundSeedAssetsOptions {
  /** Fired on every per-asset stage change (launchFunding.ts's state machine). */
  onAssetProgress?: (event: AssetFundingProgressEvent) => void;
  /** Per-asset funding state persisted by a previous attempt (PendingReserveDeploy.assetFunding) -- any `submitted` signature in here is reconciled against real on-chain status BEFORE any new swap is considered. */
  persistedFunding?: Record<string, PersistedAssetFunding>;
  /** Called with the full updated record on every transition so the caller can persist it (savePendingAssetFunding) -- progress survives refresh/reconnect. */
  onFundingStateChange?: (record: Record<string, PersistedAssetFunding>) => void;
}

async function fundSeedAssetsIdempotent(
  connection: Connection,
  wallet: WalletContextState,
  assets: Pick<CreateReserveAssetInput, "mint" | "decimals" | "seedWeightFraction">[],
  seedAmounts: bigint[],
  // Mainnet has no faucet -- there is no such thing as a server-minted real
  // USDC top-up. When false, any genuine shortfall throws a plain,
  // actionable error (fund the wallet yourself first) instead of calling
  // api/devnet/mint-test-assets, which only ever exists on DevNet, UNLESS
  // jupiterSwap.enabled covers that specific asset instead. Defaults to
  // true so every pre-existing DevNet caller/test behaves unchanged.
  allowFaucet: boolean = true,
  jupiterSwap?: JupiterSwapFundingOptions,
  clusterLabel: string = "DevNet",
  opts: FundSeedAssetsOptions = {},
): Promise<{ signature: string | null; finalSeedAmounts: bigint[]; fundingStates: PersistedAssetFunding[] }> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = wallet.publicKey;

  const balances = await Promise.all(assets.map((a) => fetchOwnedBalanceRaw(connection, new PublicKey(a.mint), owner)));
  const finalSeedAmounts = [...seedAmounts];

  // Per-asset funding state machine (launchFunding.ts, DEC-0151): every
  // asset starts from its persisted state (or not_started) and only ever
  // moves forward through
  // not_started -> quoted -> awaiting_signature -> submitted -> confirmed
  //   -> balance_verified -> ready_to_seed.
  // Seeding is gated on EVERY asset reaching ready_to_seed -- completion is
  // never inferred from a wallet approval, a submitted transaction, or a
  // timeout, only from an authoritatively verified balance.
  let funding: Record<string, PersistedAssetFunding> = { ...(opts.persistedFunding ?? {}) };
  const advance = (mint: string, to: AssetFundingStatus, extra?: Partial<Pick<PersistedAssetFunding, "lastSignature" | "verifiedBalanceRaw" | "targetRaw">>) => {
    funding = advanceAssetFunding(funding, mint, to, extra);
    opts.onFundingStateChange?.(funding);
    opts.onAssetProgress?.({ funded: countReadyToSeed(assets.map((a) => funding[a.mint] ?? { mint: a.mint, status: "not_started" })), total: assets.length, mint, stage: to });
  };
  const resetForRetry = (mint: string) => {
    funding = advanceAssetFunding(funding, mint, "not_started");
    opts.onFundingStateChange?.(funding);
  };

  let jupiterSwapSig: string | null = null;
  if (jupiterSwap?.enabled) {
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (!isJupiterSwapEligible(asset.mint)) continue;

      // Reconcile a previously-submitted swap signature BEFORE anything
      // else -- a prior attempt may have submitted a swap whose
      // confirmation this client never saw (refresh, RPC timeout). Its
      // real on-chain status decides what happens next: confirmed means
      // the tokens are (or will be, once read settles) already in the
      // wallet -- never re-swapped; failed/expired/not-found means the
      // attempt genuinely didn't land and this asset restarts cleanly.
      const persisted = funding[asset.mint];
      if (persisted?.lastSignature && (persisted.status === "submitted" || persisted.status === "awaiting_signature")) {
        const { value } = await withRateLimitRetry(() => connection.getSignatureStatuses([persisted.lastSignature!], { searchTransactionHistory: true }), 3, 500);
        const st = value[0];
        if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          advance(asset.mint, "confirmed");
          balances[i] = await fetchOwnedBalanceRawSettled(connection, new PublicKey(asset.mint), owner, balances[i]);
        } else {
          resetForRetry(asset.mint);
        }
      }

      const usdBudget = jupiterSwap.seedTotalUsd * asset.seedWeightFraction;
      if (usdBudget <= 0) {
        finalSeedAmounts[i] = 0n;
        advance(asset.mint, "ready_to_seed", { verifiedBalanceRaw: "0" });
        continue;
      }
      const usdcBudgetRaw = BigInt(Math.round(usdBudget * 1_000_000));
      // The price-aware TARGET amount for this asset, replacing the $1-peg
      // placeholder seedAmounts[i] was computed with (only ever correct for
      // real USDC itself). Source, in preference order:
      //
      // 1. An asset a previous attempt already verified as ready_to_seed
      //    reuses its PERSISTED target -- no Jupiter call at all. The asset
      //    was authoritatively balance-verified against that exact target;
      //    re-quoting it on every Resume only re-answers an
      //    already-answered question, and (confirmed live, 10-asset Mainnet
      //    Reserve "DELTA", 2026-08-25 and again 2026-08-27) the resulting
      //    burst of one quote per asset in quick succession is precisely
      //    what trips Jupiter's per-key rate limit and fails the Resume
      //    before it reaches the assets that genuinely need work. Reusing
      //    the persisted target also stops a verified asset from flapping
      //    back to "needs funding" just because the live price moved since
      //    it was funded. The wallet's REAL current balance is still
      //    re-read fresh (top of this function) and still gates
      //    ready_to_seed below -- if the tokens actually left the wallet,
      //    this asset falls through to a live re-quote and re-swap.
      // 2. Otherwise a live quote for the FULL budget. This does not mean
      //    the full budget gets SWAPPED below -- see the deficit
      //    calculation immediately after. Cached (getCached, keyed by
      //    mint+budget) so rapid Resume clicks within the TTL don't re-ask;
      //    ONLY used to determine targetRaw for the already-holds-enough/
      //    dust/tolerance checks below, never as the actual swap quote
      //    executed (that's a fresh, uncached call further down), so a
      //    cached value is safe -- target drift within the TTL is exactly
      //    what the shortfall-tolerance machinery already absorbs.
      const persistedTarget = funding[asset.mint];
      let targetRaw: bigint;
      if (persistedTarget?.status === "ready_to_seed" && persistedTarget.targetRaw) {
        targetRaw = BigInt(persistedTarget.targetRaw);
      } else {
        const fullQuote = await getCached(`jupiter-full-quote:${asset.mint}:${usdcBudgetRaw.toString()}`, 60_000, () =>
          fetchJupiterSwapQuote(asset.mint, usdcBudgetRaw, owner.toBase58()),
        );
        targetRaw = fullQuote.outAmount;
      }
      finalSeedAmounts[i] = targetRaw;

      const existingRaw = balances[i]; // real balance already read at the top of this function, BEFORE any swap this call performs -- may already include tokens from an earlier attempt/session, not just this one.
      if (existingRaw >= targetRaw) {
        // Already holds enough (from a prior confirmed swap, an earlier
        // attempt, or simply already owned) -- verified against the real
        // balance, so straight to ready. No swap, no fee spent.
        advance(asset.mint, "ready_to_seed", { verifiedBalanceRaw: existingRaw.toString(), targetRaw: targetRaw.toString() });
        continue;
      }

      // Swap only the genuine DEFICIT, never the full target -- an asset
      // already partially funded (by an earlier attempt, or simply already
      // held by the creator before ever starting this deployment) must
      // never be topped up as if it held nothing. Confirmed live incident
      // (2026-08-20, see docs/project/DECISION_LOG.md): a creator who
      // already held ~9x the required amount still had the FULL budget
      // re-swapped on every retry. Reuses fullQuote directly when nothing
      // is held yet (the deficit IS the full target) -- no wasted second
      // Jupiter API call for the common first-attempt case.
      const deficitRaw = computeFundingShortfall(targetRaw, existingRaw);
      const scaledDeficitUsdcRaw = scaleUsdcBudgetForDeficit(usdcBudgetRaw, deficitRaw, targetRaw);

      if (
        isDustDeficit(existingRaw, scaledDeficitUsdcRaw, DUST_DEFICIT_USDC_RAW) ||
        isWithinAcceptableShortfallTolerance(existingRaw, targetRaw, SHORTFALL_WARN_PCT)
      ) {
        // Either an absolute-dollar dust deficit (DUST_DEFICIT_USDC_RAW's
        // own header) or a real, already-adequate balance that only looks
        // short because the live-quoted target moved with the market since
        // it was acquired (isWithinAcceptableShortfallTolerance's own
        // header) -- neither is worth (or, for the dust case, often even
        // possible to) swap for. Seed with the real balance already held
        // instead of attempting a swap the Creator would rightly find
        // confusing ("I already have this"), and report the gap through
        // the same onSwapShortfall path a real post-swap shortfall uses --
        // never silently understating what the Reserve actually ends up
        // holding.
        finalSeedAmounts[i] = existingRaw;
        advance(asset.mint, "ready_to_seed", { verifiedBalanceRaw: existingRaw.toString(), targetRaw: targetRaw.toString() });
        const dustShortfallPct = computeSwapShortfallPct(targetRaw, existingRaw);
        if (dustShortfallPct > SHORTFALL_WARN_PCT) {
          jupiterSwap.onSwapShortfall?.({ mint: asset.mint, targetRaw, actualRaw: existingRaw, shortfallPct: dustShortfallPct });
        }
        continue;
      }

      // USDC preflight, per swap, IMMEDIATELY before requesting a signature
      // -- the direct guard against the confirmed live disaster (2026-08-25,
      // Reserve 11's USD1 swap: wallet held 0.490579 USDC against a ~$2
      // required input, producing Jupiter error 6024 InsufficientFunds five
      // consecutive times over 34 minutes with a UI that kept implying
      // retry could help). Jupiter's own documented handling for 6024 is
      // exactly this: show the current balance and the required balance.
      // A small buffer covers the swap's own fee/rounding headroom.
      const usdcHeldRaw = await fetchOwnedBalanceRaw(connection, new PublicKey(MAINNET_USDC_MINT), owner);
      const usdcRequiredWithBufferRaw = (scaledDeficitUsdcRaw * 102n) / 100n;
      if (usdcHeldRaw < usdcRequiredWithBufferRaw) {
        throw new Error(
          `This wallet holds ${(Number(usdcHeldRaw) / 1e6).toFixed(2)} USDC, but the next funding swap (${asset.mint}) needs ~${(Number(usdcRequiredWithBufferRaw) / 1e6).toFixed(2)} USDC -- and later assets in this launch still need funding after it. Send this wallet more USDC, then resume: everything already funded is verified and will never be re-bought.`,
        );
      }

      // A FRESH execution quote, always -- the cached fullQuote above is
      // used strictly to determine the live-priced target, never as the
      // quote a real swap transaction is built from (a cached quote's
      // route/amounts can be up to 20s stale, exactly the staleness class
      // the "fresh quote immediately before each swap" invariant exists to
      // prevent).
      advance(asset.mint, "quoted", { targetRaw: targetRaw.toString() });
      const quote = await fetchJupiterSwapQuote(asset.mint, existingRaw <= 0n ? usdcBudgetRaw : scaledDeficitUsdcRaw, owner.toBase58());

      jupiterSwap.onSwapStart?.(asset.mint);
      advance(asset.mint, "awaiting_signature");
      jupiterSwapSig = await executeJupiterSwap(connection, wallet, quote, (submittedSig) => advance(asset.mint, "submitted", { lastSignature: submittedSig }));
      advance(asset.mint, "confirmed");
      // Use whatever the swap actually produced -- Jupiter's on-chain swap
      // instruction already enforces its own worst-case slippage floor
      // (otherAmountThreshold), so a real result below the quote's
      // OPTIMISTIC outAmount is expected/routine, not a failure to block
      // on. The Reserve is seeded with the real balance either way; only a
      // shortfall beyond ordinary slippage gets reported (never thrown) via
      // onSwapShortfall. fetchOwnedBalanceRawSettled (not a single
      // immediate read) -- see its own header for why: a read right after
      // OUR OWN confirmation can still hit an RPC node that hasn't caught
      // up yet.
      const newBalance = await fetchOwnedBalanceRawSettled(connection, new PublicKey(asset.mint), owner, existingRaw);
      finalSeedAmounts[i] = newBalance;
      advance(asset.mint, "balance_verified", { verifiedBalanceRaw: newBalance.toString() });
      // Shortfall is always measured against the FULL target (targetRaw),
      // not the smaller deficit-only quote -- newBalance is the creator's
      // real TOTAL holding (existing + just-acquired), so comparing it
      // against anything less than the full target would systematically
      // under-report a genuine shortfall.
      const shortfallPct = computeSwapShortfallPct(targetRaw, newBalance);
      if (shortfallPct > SHORTFALL_WARN_PCT) {
        jupiterSwap.onSwapShortfall?.({ mint: asset.mint, targetRaw, actualRaw: newBalance, shortfallPct });
      }
      advance(asset.mint, "ready_to_seed");
    }
  }

  const shortfalls = assets.map((a, i) => ({ asset: a, amount: computeFundingShortfall(finalSeedAmounts[i], balances[i]) }));

  // Assets fully handled by the Jupiter-swap loop above (funded just now, or
  // already held) are excluded here even if `balances` (captured before that
  // loop ran) makes them look short -- the loop already verified each one's
  // real post-swap balance meets its target.
  const faucetAssets = shortfalls.filter(({ asset, amount }) => !isWrappedSol(asset.mint) && amount > 0n && !(jupiterSwap?.enabled && isJupiterSwapEligible(asset.mint)));
  const wrapAssets = shortfalls.filter(({ asset, amount }) => isWrappedSol(asset.mint) && amount > 0n);

  if (!allowFaucet && faucetAssets.length > 0) {
    const shortfallDescriptions = faucetAssets
      .map(({ asset, amount }) => `${(Number(amount) / 10 ** asset.decimals).toLocaleString()} more of ${asset.mint}`)
      .join(", ");
    throw new Error(`This wallet doesn't hold enough of the seed asset yet -- send it ${shortfallDescriptions} and try again. There is no faucet on Mainnet.`);
  }

  let sig: string | null = null;
  if (faucetAssets.length > 0) {
    const mintRes = await fetch("/api/devnet/mint-test-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userPubkey: owner.toBase58(),
        mints: faucetAssets.map(({ asset, amount }) => ({ mint: asset.mint, rawAmount: amount.toString() })),
      }),
    });
    const mintJson = await mintRes.json();
    if (!mintRes.ok) throw new Error(mintJson.error || "Failed to mint DevNet seed test assets.");
    sig = mintJson.signature;
  }
  if (wrapAssets.length > 0) {
    // Real SOL, genuinely the creator's own -- no faucet involved. Wrap it
    // themselves: idempotent-create their WSOL ATA, transfer only the
    // shortfall in, syncNative so the SPL balance reflects it.
    const wsolMint = new PublicKey(WRAPPED_SOL_MINT);
    const wsolAta = getAssociatedTokenAddressSync(wsolMint, owner);
    const totalLamports = wrapAssets.reduce((sum, { amount }) => sum + amount, 0n);
    const wrapIxs = [
      createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, wsolMint),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: totalLamports }),
      createSyncNativeInstruction(wsolAta),
    ];
    const wrapSig = await signAndSend(connection, wallet, wrapIxs, clusterLabel);
    // If more than one of faucet/wrap/swap needed topping up, report
    // whichever signature isn't already set -- this return value just needs
    // *a* representative signature.
    sig = sig ?? wrapSig;
  }
  sig = sig ?? jupiterSwapSig;

  // Every non-swap-funded asset (the USDC leg, wrapped SOL, DevNet
  // faucet-funded test assets) reaches this line only if its
  // shortfall-funding phase above either found it already sufficient or
  // genuinely funded it (a shortfall that couldn't be funded threw before
  // here) -- mark each ready_to_seed with its verified amount so the
  // canEnterSeeding gate covers EVERY asset uniformly, not just the
  // Jupiter-swapped ones.
  for (let i = 0; i < assets.length; i++) {
    const st = funding[assets[i].mint];
    if (!st || st.status !== "ready_to_seed") {
      advance(assets[i].mint, "ready_to_seed", { verifiedBalanceRaw: finalSeedAmounts[i].toString() });
    }
  }
  const fundingStates = assets.map((a) => funding[a.mint] ?? { mint: a.mint, status: "not_started" as AssetFundingStatus });
  return { signature: sig, finalSeedAmounts, fundingStates };
}

/**
 * Reads the derived Reserve PDA directly to check whether it now exists
 * on-chain, regardless of what the client believes happened -- the
 * authoritative reconciliation check for the create-and-register step (see
 * CreateReserveStepError below). A basic getAccountInfo/owner check, not a
 * full Anchor deserialization -- existence + correct program ownership is
 * all that's needed to distinguish "genuinely never submitted" from
 * "landed on-chain despite a client-side error."
 */
export async function reserveAccountExistsOnChain(connection: Connection, reserveAddress: PublicKey, programId: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(reserveAddress, "confirmed");
  return info !== null && info.owner.equals(programId);
}

/**
 * Thrown by createReserveOnChain on any failure from create-and-register
 * onward, carrying the exact step that failed and (once known) the derived
 * addresses for THIS specific attempt -- so the caller can reconcile
 * against the real, specific Reserve PDA this attempt was building, rather
 * than inferring from a fuzzier signal like ProtocolConfig.reserveCount
 * (which a concurrent Reserve creation by a different wallet could also
 * move). Carrying `step` directly on the error also sidesteps a real stale-
 * closure bug this replaces: CreateDTR.tsx previously read the `createStep`
 * React state var from inside an async function's catch block, which
 * always saw the value from BEFORE the submission started (React state
 * updates never mutate a running closure's local binding) -- so a failure
 * at any step always reported as "(setup)" and never triggered the
 * "already created on-chain, don't retry" warning.
 */
export class CreateReserveStepError extends Error {
  readonly step: CreateReserveStep;
  readonly addresses: NewReserveAddresses | null;
  constructor(message: string, step: CreateReserveStep, addresses: NewReserveAddresses | null, cause?: unknown) {
    // `cause` (standard Error option, ES2022+) preserves the ORIGINAL
    // thrown value's identity -- critically, whether it was a genuine
    // AmbiguousConfirmationError (a transaction WAS submitted; outcome
    // unknown) rather than a real failure. Every catch site below used to
    // discard this by re-stringifying to `e.message` alone, which meant
    // classifyCreateReserveError (createReserveResume.ts) could never see
    // `e instanceof AmbiguousConfirmationError` once the error reached this
    // class -- an ambiguous RPC-confirmation timeout on Resume fell through
    // every other classification rule to "deterministic" (the conservative
    // default for an error classifyCreateReserveError can't positively
    // identify as transient), which told the Creator "this specific
    // failure will not resolve itself on a plain retry" for an outcome that
    // was, in fact, exactly the kind of thing a plain Resume click (which
    // always re-reads on-chain state first) safely resolves. Confirmed live
    // (2026-08-25, real Mainnet Reserve "CHARLIE", signature
    // 5ZXVDEFL34cK9gQ69sn4c3n2LWi28wsfqCjw8NqNxY3iiwKXFBEbcFkiUMcu9WZaFv76FSeYoAcLpHqHr25iJ9eC
    // -- verified via direct Mainnet RPC read to have never landed on-chain
    // at all, ordinary transient network behavior).
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "CreateReserveStepError";
    this.step = step;
    this.addresses = addresses;
  }
}

export async function createReserveOnChain(params: {
  connection: Connection;
  wallet: WalletContextState;
  metadataUri: string;
  mintFeeBps: number;
  tvlFeeBps: number;
  feeDestination: PublicKey;
  /**
   * Manager fee recipients beyond the Primary Fee Destination (DEC-0094).
   * When omitted or containing only the Primary at 100%, no extra
   * instruction is needed -- `feeDestination` alone already covers that
   * case. When >1 entries, `initializeManagerFeeRecipients` is bundled into
   * the SAME create-and-register transaction. If provided, MUST include the
   * Primary (`feeDestination`) as one entry and allocations must sum to
   * exactly 100%.
   */
  feeRecipients?: RecipientInput[];
  /**
   * Wallets to grant as restricted delegates (see ADDITIONAL_MANAGER_PERMISSIONS
   * above) in the SAME create-and-register transaction -- CreateDTR.tsx's
   * "Additional Managers" step. Bundled here, not as separate post-creation
   * transactions, for the same reason feeRecipients is (DEC-0031): it shares
   * the reserve/signer/systemProgram accounts already in this transaction,
   * so no extra wallet approval is needed. Was previously collected by the
   * UI and silently discarded -- confirmed root cause of "add delegate on
   * reserve creation doesn't do anything" (a delegate added via ManageDTR.tsx
   * after creation worked correctly; one entered during CreateDTR.tsx never
   * reached the chain at all).
   */
  additionalManagers?: string[];
  assets: CreateReserveAssetInput[];
  seedTotalUsd: number;
  onProgress: (step: CreateReserveStep) => void;
  /** Fired the instant the target Reserve's addresses are derived (one ProtocolConfig read) -- lets the caller track exactly which Reserve this attempt targets (for reconciliation) without a second, redundant ProtocolConfig fetch of its own. */
  onAddressesResolved?: (addresses: NewReserveAddresses) => void;
  /** Cluster-aware program to deploy against -- defaults to the DevNet program (DEVNET_FIXTURES.programId) so every pre-existing caller/test is unaffected. CreateDTR.tsx passes SSR_PROGRAM_ID (cluster-aware) explicitly. */
  programId?: PublicKey;
  /** See fundSeedAssetsIdempotent's own header -- false on Mainnet (no faucet exists there). Defaults to true, matching every pre-existing DevNet caller. */
  allowFaucet?: boolean;
  /** See JupiterSwapFundingOptions -- Mainnet only, undefined/disabled everywhere else. */
  jupiterSwap?: JupiterSwapFundingOptions;
  /** See seedRawAmountForAsset's header -- REQUIRED to be a real, live SOL/USD price on Mainnet if `assets` includes wrapped SOL (never the DevNet test peg there); defaults to SOL_TEST_PRICE_USD so every pre-existing DevNet caller/test is unaffected. */
  solPriceUsd?: number;
  /** See signAndSend's header -- shown in an AmbiguousConfirmationError if RPC confirmation times out. Defaults to "DevNet" so every pre-existing caller/test is unaffected; CreateDTR.tsx passes its own real CLUSTER_LABEL. */
  clusterLabel?: string;
  /** Per-asset funding progress -- see FundSeedAssetsOptions (launchFunding.ts's state machine, DEC-0151). */
  onAssetProgress?: (event: AssetFundingProgressEvent) => void;
  /** Persist per-asset funding state on every transition (see savePendingAssetFunding) so progress survives refresh/reconnect. */
  onFundingStateChange?: (record: Record<string, PersistedAssetFunding>) => void;
}): Promise<CreateReserveResult> {
  const { connection, wallet } = params;
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  validateCreateReserveAssets(params.assets);
  // The ONE choke point every caller of createReserveOnChain goes through
  // for metadataUri, same rationale as validateCreateReserveAssets above --
  // this is what makes "blocked before Phantom opens" true even if a future
  // caller (a script, a different UI path) somehow skips CreateDTR.tsx's own
  // upload-then-validate flow. See packages/sdk/src/metadataUri.ts's header
  // for the full MetadataUriTooLong root-cause writeup this guards against:
  // a data:/blob: URI, an unsupported scheme, or anything over the on-chain
  // byte limit throws HERE, before deriveNewReserveAddresses or any signing.
  validateMetadataUri(params.metadataUri);
  // Same single-choke-point rationale as above -- validated here regardless
  // of whether CreateDTR.tsx already validated its own input.
  const additionalManagerWallets = validateAdditionalManagers(params.additionalManagers ?? [], wallet.publicKey);
  const programId = params.programId ?? new PublicKey(DEVNET_FIXTURES.programId);
  const allowFaucet = params.allowFaucet ?? true;
  const solPriceUsd = params.solPriceUsd ?? SOL_TEST_PRICE_USD;
  const clusterLabel = params.clusterLabel ?? "DevNet";
  const program = buildReadOnlyProgram(connection) as any;

  params.onProgress("create-and-register");
  const addresses: NewReserveAddresses = await deriveNewReserveAddresses(program, programId);
  params.onAddressesResolved?.(addresses);
  const assetAddresses: ReserveAssetAddresses[] = params.assets.map((a) => deriveReserveAssetAddresses(addresses.reserve, new PublicKey(a.mint), programId));

  let createAndRegisterSig: string;
  try {
    // DEC-0094: the Protocol/Manager fee split is no longer set here -- it's
    // always derived on-chain, fresh at every mint/accrual, from
    // mintFeeBps/tvlFeeBps alone (see packages/sdk/src/feeMath.ts and
    // fee_math.rs). feeDestination is the Primary Fee Destination, the sole
    // implicit Manager fee recipient unless additional recipients are
    // configured below.
    const createIx = await buildCreateReserveInstruction(program, addresses, wallet.publicKey, {
      metadataUri: params.metadataUri,
      mintFeeBps: params.mintFeeBps,
      redemptionFeeBps: 0,
      tvlFeeBps: params.tvlFeeBps,
      feeDestination: params.feeDestination,
    });
    const registerIxs = await Promise.all(
      params.assets.map((a, i) => buildInitializeReserveAssetInstruction(program, addresses, assetAddresses[i], wallet.publicKey!, a.weightBps)),
    );

    const ixs: TransactionInstruction[] = [createIx, ...registerIxs];
    const recipients = params.feeRecipients;
    if (recipients && recipients.length > 1) {
      validateFeeRecipientInputs(recipients);
      const [delegate] = findDelegate(addresses.reserve, wallet.publicKey, programId);
      const initRecipientsIx = await buildInitializeManagerFeeRecipientsInstruction(
        program,
        programId,
        addresses.reserve,
        wallet.publicKey,
        delegate,
        wallet.publicKey,
        recipients,
      );
      ixs.push(initRecipientsIx);
    }

    if (additionalManagerWallets.length > 0) {
      // The signer IS reserve.manager as soon as createIx (batch 0's first
      // instruction, see packInstructionsBySize below) confirms -- possibly
      // in an EARLIER transaction than this one now that registration can
      // span several. add_delegate.rs's permission check short-circuits on
      // require_root_manager/require_reserve_permission without ever
      // reading actingDelegate (this self-referential PDA doesn't need to
      // exist on-chain for that check), so this remains correct regardless
      // of which batch it ends up in. Restricted=true always, matching
      // ADDITIONAL_MANAGER_PERMISSIONS's "can't manage other delegates" promise.
      const [actingDelegate] = findDelegate(addresses.reserve, wallet.publicKey, programId);
      const addDelegateIxs = await Promise.all(
        additionalManagerWallets.map((delegateWallet) =>
          buildAddDelegateInstruction(program, programId, addresses.reserve, wallet.publicKey!, actingDelegate, delegateWallet, ADDITIONAL_MANAGER_PERMISSIONS, true),
        ),
      );
      ixs.push(...addDelegateIxs);
    }

    // createReserve + one initializeReserveAsset per asset (+ optional
    // recipients/delegate instructions) no longer fit in a single legacy
    // transaction once a Reserve has more than a handful of assets --
    // confirmed live: 10 assets produced a real 1830-byte transaction
    // against Solana's 1232-byte hard limit ("Transaction too large: 1830 >
    // 1232"), and nothing was created on-chain (2026-08-24, road-to-mainnet
    // MCR-01). packInstructionsBySize splits into as many transactions as
    // actually needed, in the same order (createIx always first/alone in
    // batch 0), each requiring its own wallet approval -- exactly what the
    // on-chain Created -> AssetsInitializing status machine was already
    // designed to support (see packInstructionsBySize's own header).
    const batches = packInstructionsBySize(wallet.publicKey, ixs);
    const batchSigs: string[] = [];
    for (const batch of batches) {
      batchSigs.push(await signAndSend(connection, wallet, batch, clusterLabel));
    }
    createAndRegisterSig = batchSigs[0];
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "create-and-register", addresses, e);
  }

  params.onProgress("fund-seed-assets");
  const seedAmounts = params.assets.map((a) => seedRawAmountForAsset(a, params.seedTotalUsd * a.seedWeightFraction, solPriceUsd));

  let fundSeedAssetsSig: string | null = null;
  let finalSeedAmounts = seedAmounts;
  let fundingStates: PersistedAssetFunding[] = [];
  try {
    const fundResult = await fundSeedAssetsIdempotent(connection, wallet, params.assets, seedAmounts, allowFaucet, params.jupiterSwap, clusterLabel, {
      onAssetProgress: params.onAssetProgress,
      onFundingStateChange: params.onFundingStateChange,
    });
    fundSeedAssetsSig = fundResult.signature;
    finalSeedAmounts = fundResult.finalSeedAmounts;
    fundingStates = fundResult.fundingStates;
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "fund-seed-assets", addresses, e);
  }

  params.onProgress("seed");
  let seedSig: string;
  try {
    // THE seeding gate (launchFunding.ts, DEC-0151): every asset must be
    // authoritatively ready_to_seed. Structurally, fundSeedAssetsIdempotent
    // throwing on any failure already prevents reaching here early -- this
    // asserts it explicitly so no future code path can ever seed a Reserve
    // whose assets weren't all verified.
    if (!canEnterSeeding(fundingStates)) {
      throw new Error(`Refusing to seed: only ${countReadyToSeed(fundingStates)} of ${fundingStates.length} assets are verified as fully funded.`);
    }
    const initialReserveTokens = BigInt(Math.max(1, Math.floor(params.seedTotalUsd)) * 1_000_000);
    // Fail fast, client-side, before ever asking for a signature -- the
    // program rejects any per-asset seed amount below its own real floor
    // (SsrError::SeedAmountTooLow) and submitting anyway just wastes a
    // transaction on a guaranteed revert. Named per-asset here (mint +
    // decimals-aware amount) since validateSeedPlan's own message doesn't
    // know which asset is which.
    assertSeedAmountsMeetMinimum(params.assets, finalSeedAmounts);
    validateSeedPlan(finalSeedAmounts, initialReserveTokens);
    const seedIx = await buildSeedReserveInstruction(program, addresses, assetAddresses, wallet.publicKey, finalSeedAmounts, initialReserveTokens);
    seedSig = await signAndSendPossiblyOverLimit(connection, wallet, seedIx, undefined, clusterLabel, seedComputeUnitLimit(params.assets.length));
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "seed", addresses, e);
  }

  params.onProgress("done");

  return {
    reserveId: addresses.reserveId.toString(),
    reserve: addresses.reserve.toBase58(),
    reserveTokenMint: addresses.reserveTokenMint.toBase58(),
    mintAuthority: addresses.mintAuthority.toBase58(),
    vaultAuthority: addresses.vaultAuthority.toBase58(),
    assets: params.assets.map((a, i) => ({
      mint: a.mint,
      reserveAsset: assetAddresses[i].reserveAsset.toBase58(),
      vault: assetAddresses[i].vault.toBase58(),
      weightBps: a.weightBps,
      decimals: a.decimals,
    })),
    transactions: { createAndRegister: createAndRegisterSig, fundSeedAssets: fundSeedAssetsSig, seed: seedSig },
  };
}

/**
 * Strictly READ-ONLY: checks whether a pending deployment's Reserve is
 * genuinely already fully seeded on-chain (status past AssetsInitializing),
 * and if so, returns the same CreateReserveResult shape
 * resumeReserveDeploymentOnChain's own "already-complete" branch would.
 * Never funds, swaps, or seeds anything -- returns null for every other
 * case (including a genuinely incomplete Reserve) rather than attempting
 * to advance it. This exists specifically so a caller that just caught a
 * fund-seed-assets/seed failure can determine the TRUE current state
 * before deciding whether to report failure -- the UI must never conclude
 * "incomplete" from a thrown exception alone when the seed transaction (or
 * an earlier/concurrent attempt) may have actually succeeded; see
 * docs/project/DECISION_LOG.md's entry for this pass. A caller that wants
 * to actually ADVANCE an incomplete deployment must still call
 * resumeReserveDeploymentOnChain -- this function deliberately cannot do
 * that, so it can never be the thing that double-submits.
 */
export async function checkReserveGenuinelyComplete(
  connection: Connection,
  programId: PublicKey,
  pending: Pick<PendingReserveDeploy, "reserve" | "reserveId" | "assets">,
): Promise<CreateReserveResult | null> {
  const reserveAddress = new PublicKey(pending.reserve);
  const candidateMints = pending.assets.map((a) => new PublicKey(a.mint));
  const onChain: ReserveOnChain | null = await fetchReserveOnChain(connection, programId, reserveAddress, candidateMints);
  const resumePoint = determineDeploymentResumePoint({
    reserveExists: onChain !== null,
    reserveStatus: (onChain?.status as ReserveOnChainStatus) ?? null,
    onChainAssetCount: onChain?.assetCount ?? 0,
    expectedAssetCount: pending.assets.length,
  });
  if (resumePoint.kind !== "already-complete" || !onChain) return null;

  const assetAddresses: ReserveAssetAddresses[] = pending.assets.map((a) => deriveReserveAssetAddresses(reserveAddress, new PublicKey(a.mint), programId));
  return {
    reserveId: pending.reserveId,
    reserve: pending.reserve,
    reserveTokenMint: onChain.reserveTokenMint,
    mintAuthority: findMintAuthority(reserveAddress, programId)[0].toBase58(),
    vaultAuthority: findVaultAuthority(reserveAddress, programId)[0].toBase58(),
    assets: pending.assets.map((a, i) => {
      const onChainAsset = onChain.assets.find((oa) => oa.assetMint === a.mint);
      return {
        mint: a.mint,
        reserveAsset: assetAddresses[i].reserveAsset.toBase58(),
        vault: assetAddresses[i].vault.toBase58(),
        weightBps: onChainAsset?.targetWeightBps ?? 0,
        decimals: a.decimals,
      };
    }),
    transactions: { createAndRegister: null, fundSeedAssets: null, seed: null },
  };
}

/**
 * Resumes a deployment whose create-and-register transaction already landed
 * on-chain (or is already fully complete) -- the counterpart to
 * createReserveOnChain for every step from fund-seed-assets onward. Reads
 * REAL on-chain state before doing anything else, via
 * determineDeploymentResumePoint (see createReserveResume.ts): a Reserve
 * that's already Active/Paused/WindDown/Closed is reported as already
 * complete without submitting anything; a Reserve whose real registered
 * asset count doesn't match what this pending deployment expected refuses
 * to proceed automatically at all (never guesses at how to reconcile a
 * mismatch); otherwise resumes funding (idempotent -- only the real
 * shortfall is topped up) and seeding, re-reading status immediately before
 * seeding so an earlier ambiguous-but-actually-successful attempt is never
 * blindly resubmitted, and re-reading it again immediately after to confirm
 * Active before ever reporting success.
 */
export async function resumeReserveDeploymentOnChain(params: {
  connection: Connection;
  wallet: WalletContextState;
  pending: PendingReserveDeploy;
  onProgress: (step: CreateReserveStep) => void;
  /** Same meaning as createReserveOnChain's own `programId` -- must match whatever program the original create-and-register attempt actually targeted. */
  programId?: PublicKey;
  /** Same meaning as createReserveOnChain's own `allowFaucet`. */
  allowFaucet?: boolean;
  /** Same meaning as createReserveOnChain's own `jupiterSwap`. */
  jupiterSwap?: JupiterSwapFundingOptions;
  /** Same meaning as createReserveOnChain's own `solPriceUsd`. */
  solPriceUsd?: number;
  /** Same meaning as createReserveOnChain's own `clusterLabel`. */
  clusterLabel?: string;
  /** Same meaning as createReserveOnChain's own `onAssetProgress`. */
  onAssetProgress?: (event: AssetFundingProgressEvent) => void;
}): Promise<CreateReserveResult> {
  const { connection, wallet, pending } = params;
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const programId = params.programId ?? new PublicKey(DEVNET_FIXTURES.programId);
  const allowFaucet = params.allowFaucet ?? true;
  const solPriceUsd = params.solPriceUsd ?? SOL_TEST_PRICE_USD;
  const clusterLabel = params.clusterLabel ?? "DevNet";
  const reserveAddress = new PublicKey(pending.reserve);
  const candidateMints = pending.assets.map((a) => new PublicKey(a.mint));

  const onChain: ReserveOnChain | null = await fetchReserveOnChain(connection, programId, reserveAddress, candidateMints);
  const resumePoint = determineDeploymentResumePoint({
    reserveExists: onChain !== null,
    reserveStatus: (onChain?.status as ReserveOnChainStatus) ?? null,
    onChainAssetCount: onChain?.assetCount ?? 0,
    expectedAssetCount: pending.assets.length,
  });

  if (resumePoint.kind === "start-fresh") {
    throw new Error(`No Reserve was found on-chain at ${pending.reserve} -- the original create-and-register attempt never actually landed. Start a fresh deployment instead of resuming.`);
  }
  if (resumePoint.kind === "asset-count-mismatch") {
    throw new Error(
      `On-chain Reserve ${pending.reserve} has ${resumePoint.onChainAssetCount} registered asset(s), but this pending deployment expected ${resumePoint.expectedAssetCount}. Refusing to resume automatically -- verify this Reserve's real composition on Explorer before taking any further action.`,
    );
  }

  // onChain is guaranteed non-null past this point (both remaining
  // resumePoint kinds require reserveExists === true).
  const addresses: NewReserveAddresses = {
    reserveId: BigInt(pending.reserveId),
    reserve: reserveAddress,
    reserveTokenMint: new PublicKey(onChain!.reserveTokenMint),
    mintAuthority: findMintAuthority(reserveAddress, programId)[0],
    vaultAuthority: findVaultAuthority(reserveAddress, programId)[0],
    protocolConfig: findProtocolConfig(programId)[0],
  };
  const assetAddresses: ReserveAssetAddresses[] = pending.assets.map((a) => deriveReserveAssetAddresses(reserveAddress, new PublicKey(a.mint), programId));

  const buildResult = (transactions: CreateReserveResult["transactions"]): CreateReserveResult => ({
    reserveId: addresses.reserveId.toString(),
    reserve: addresses.reserve.toBase58(),
    reserveTokenMint: addresses.reserveTokenMint.toBase58(),
    mintAuthority: addresses.mintAuthority.toBase58(),
    vaultAuthority: addresses.vaultAuthority.toBase58(),
    assets: pending.assets.map((a, i) => {
      const onChainAsset = onChain?.assets.find((oa) => oa.assetMint === a.mint);
      return {
        mint: a.mint,
        reserveAsset: assetAddresses[i].reserveAsset.toBase58(),
        vault: assetAddresses[i].vault.toBase58(),
        weightBps: onChainAsset?.targetWeightBps ?? 0,
        decimals: a.decimals,
      };
    }),
    transactions,
  });

  const program = buildReadOnlyProgram(connection) as any;

  if (resumePoint.kind === "already-complete") {
    params.onProgress("done");
    return buildResult({ createAndRegister: null, fundSeedAssets: null, seed: null });
  }

  if (resumePoint.kind === "resume-from-registration") {
    // createReserve landed, but not every initializeReserveAsset has (see
    // packInstructionsBySize's header) -- register exactly the assets not
    // yet on-chain, in the SAME order registration always uses, so the
    // first onChainAssetCount entries of pending.assets are guaranteed to
    // already be the ones actually registered.
    params.onProgress("create-and-register");
    const remainingAssets = pending.assets.slice(resumePoint.onChainAssetCount);
    const remainingAddresses = assetAddresses.slice(resumePoint.onChainAssetCount);
    try {
      const registerIxs = await Promise.all(
        remainingAssets.map((a, i) => buildInitializeReserveAssetInstruction(program, addresses, remainingAddresses[i], wallet.publicKey!, a.weightBps)),
      );
      for (const batch of packInstructionsBySize(wallet.publicKey, registerIxs)) {
        await signAndSend(connection, wallet, batch, clusterLabel);
      }
    } catch (e) {
      throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "create-and-register", addresses, e);
    }
    // Falls through to the resume-from-funding logic below -- registration
    // is now complete (or this function already threw), so funding/seeding
    // proceeds exactly as it would for a deployment that registered
    // everything in its first attempt. Manager Fee Recipients / Additional
    // Managers configured on the ORIGINAL attempt are not persisted in
    // PendingReserveDeploy and are not retried here if the transaction that
    // carried them didn't land -- the Reserve itself is never blocked on
    // this; both can be added afterward via Manage Reserve.
  }

  // create-and-register (including any catch-up above) landed with exactly
  // the expected assets registered. Fund any real shortfall, then seed.
  const seedAmounts = pending.assets.map((a) => seedRawAmountForAsset(a, pending.seedTotalUsd * a.seedWeightFraction, solPriceUsd));

  // DEC-0166: re-read the AUTHORITATIVE Reserve status immediately before
  // funding begins, not only before seeding. The resumePoint decision above
  // was made from an earlier read -- if a prior attempt's seed actually
  // landed in the meantime (or that read hit a lagging RPC node), the wallet
  // balances are already deposited (near zero) and re-running funding here
  // would compute false deficits and buy the whole basket AGAIN, then fail
  // seeding on tiny amounts (the observed SeedAmountTooLow-after-success
  // class). An already-Active Reserve is a completed deployment, full stop.
  const statusBeforeFunding = await fetchReserveOnChain(connection, programId, reserveAddress, candidateMints);
  if (statusBeforeFunding && statusBeforeFunding.status !== "assetsInitializing") {
    params.onProgress("done");
    return buildResult({ createAndRegister: null, fundSeedAssets: null, seed: null });
  }

  params.onProgress("fund-seed-assets");
  let fundSeedAssetsSig: string | null = null;
  let finalSeedAmounts = seedAmounts;
  let fundingStates: PersistedAssetFunding[] = [];
  try {
    const fundResult = await fundSeedAssetsIdempotent(connection, wallet, pending.assets, seedAmounts, allowFaucet, params.jupiterSwap, clusterLabel, {
      onAssetProgress: params.onAssetProgress,
      // A previous attempt's per-asset progress -- lets this resume
      // reconcile any previously-submitted swap signature against real
      // on-chain status before ever considering a new swap, and skip
      // (never repeat) already-verified assets.
      persistedFunding: pending.assetFunding,
      onFundingStateChange: (record) => savePendingAssetFunding(pending.wallet, record),
    });
    fundSeedAssetsSig = fundResult.signature;
    finalSeedAmounts = fundResult.finalSeedAmounts;
    fundingStates = fundResult.fundingStates;
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "fund-seed-assets", addresses, e);
  }

  params.onProgress("seed");
  // Re-read status immediately before seeding -- an earlier attempt's
  // ambiguous confirmation may have actually landed since the last read
  // above, and seed_reserve must never be resubmitted once a Reserve is
  // genuinely already Active (the program itself would reject it with
  // UnexpectedReserveStatus, but this check avoids even attempting that).
  const freshBeforeSeed = await fetchReserveOnChain(connection, programId, reserveAddress, candidateMints);
  let seedSig: string | null = null;
  if (freshBeforeSeed?.status === "assetsInitializing") {
    try {
      // Same explicit seeding gate as createReserveOnChain -- see its own
      // comment (launchFunding.ts, DEC-0151).
      if (!canEnterSeeding(fundingStates)) {
        throw new Error(`Refusing to seed: only ${countReadyToSeed(fundingStates)} of ${fundingStates.length} assets are verified as fully funded.`);
      }
      const initialReserveTokens = BigInt(Math.max(1, Math.floor(pending.seedTotalUsd)) * 1_000_000);
      assertSeedAmountsMeetMinimum(pending.assets, finalSeedAmounts);
      validateSeedPlan(finalSeedAmounts, initialReserveTokens);
      const seedIx = await buildSeedReserveInstruction(program, addresses, assetAddresses, wallet.publicKey, finalSeedAmounts, initialReserveTokens);
      seedSig = await signAndSendPossiblyOverLimit(connection, wallet, seedIx, undefined, clusterLabel, seedComputeUnitLimit(pending.assets.length));
    } catch (e) {
      throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "seed", addresses, e);
    }
  }

  // Never report success without a final, fresh, authoritative on-chain
  // read confirming the Reserve genuinely reached Active.
  const finalState = await fetchReserveOnChain(connection, programId, reserveAddress, candidateMints);
  if (!finalState || finalState.status === "assetsInitializing") {
    throw new CreateReserveStepError(
      "Seeding did not result in an Active Reserve on re-check -- refusing to report success. Try Resume again once DevNet congestion clears.",
      "seed",
      addresses,
    );
  }

  params.onProgress("done");
  return buildResult({ createAndRegister: null, fundSeedAssets: fundSeedAssetsSig, seed: seedSig });
}

// --- Deployment-in-progress persistence (survives a reload, a closed tab, or
// --- an abandoned session) --------------------------------------------------
// Written the instant this attempt's Reserve addresses are known (right
// after the one ProtocolConfig read), and now carries everything
// resumeReserveDeploymentOnChain needs to finish the deployment: the exact
// asset list (mint/decimals/seedWeightFraction, in the same order used to
// register them) and seedTotalUsd, not just enough to detect existence.
// Cleared only on a genuinely terminal outcome: full success, or a
// definitive "create-and-register itself never landed" failure (verified via
// reserveAccountExistsOnChain) -- NEVER on a fund-seed-assets/seed failure,
// since that's exactly the case a Resume needs this marker for.
//
// Deliberately has NO time-based expiry for resumability: a real,
// half-built Reserve on-chain remains just as real and just as safe to
// resume an hour (or a week) later as it was a minute later -- the
// reconciliation this marker enables reads authoritative on-chain state
// every time (see resumeReserveDeploymentOnChain), so staleness of the
// LOCAL marker itself was never the thing keeping this safe. (An earlier
// version of this file DID expire the marker after 10 minutes -- that was
// specifically about not showing a "recovering..." spinner forever after a
// same-session reload, but it also meant any failure past 10 minutes old
// silently lost its only path back to resuming, which is exactly the
// reported "UI tells the user to create another Reserve" failure mode this
// pass fixes. isPendingDeployStale is kept in createReserveResume.ts, pure
// and unit-tested, for a caller that wants a staleness signal for DISPLAY
// purposes -- it no longer gates whether the marker can be read/resumed.)
const PENDING_DEPLOY_KEY = "ssr_pending_reserve_deploy_v1";

export interface PendingReserveDeploy {
  wallet: string;
  reserve: string;
  reserveId: string;
  name: string;
  ticker: string;
  startedAt: number;
  /** Exactly the asset list (and order) create-and-register registered -- required to resume funding/seeding correctly, and (weightBps) to resume registering any assets a later transaction in that step hadn't reached yet. */
  assets: { mint: string; decimals: number; seedWeightFraction: number; weightBps: number }[];
  seedTotalUsd: number;
  /**
   * Per-asset funding progress (launchFunding.ts's explicit state machine,
   * DEC-0151) -- persisted on every state change so a refresh/reconnect
   * resumes from the first genuinely unresolved asset, reconciling any
   * previously-submitted swap signature against real on-chain status
   * instead of blindly re-swapping. Optional: a marker written by an older
   * version of this app simply resumes with a fresh (all not_started)
   * record, which is safe -- the funding loop re-derives everything from
   * real balances anyway.
   */
  assetFunding?: Record<string, PersistedAssetFunding>;
}

/** Merges an updated per-asset funding record into the persisted pending-deploy marker (best-effort, like every other localStorage write here) -- called on every state-machine transition so progress survives refresh/reconnect. */
export function savePendingAssetFunding(walletAddress: string, assetFunding: Record<string, PersistedAssetFunding>): void {
  const pending = readPendingReserveDeploy(walletAddress);
  if (!pending) return;
  savePendingReserveDeploy({ ...pending, assetFunding });
}

export function savePendingReserveDeploy(deploy: PendingReserveDeploy): void {
  try {
    localStorage.setItem(PENDING_DEPLOY_KEY, JSON.stringify(deploy));
  } catch {
    // Best-effort only -- localStorage being unavailable never blocks deployment itself.
  }
}

export { isPendingDeployStale } from "./createReserveResume";

export function readPendingReserveDeploy(walletAddress: string): PendingReserveDeploy | null {
  try {
    const raw = localStorage.getItem(PENDING_DEPLOY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingReserveDeploy;
    if (parsed.wallet !== walletAddress) return null;
    if (!Array.isArray(parsed.assets)) return null; // written by a pre-resumability version of this app -- not enough to resume, treat as absent.
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingReserveDeploy(): void {
  try {
    localStorage.removeItem(PENDING_DEPLOY_KEY);
  } catch {
    // Best-effort.
  }
}
