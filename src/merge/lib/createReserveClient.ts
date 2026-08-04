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
import { Connection, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  buildReadOnlyProgram,
  deriveNewReserveAddresses,
  buildCreateReserveInstruction,
  buildInitializeReserveAssetInstruction,
  deriveReserveAssetAddresses,
  buildSeedReserveInstruction,
  fetchReserveOnChain,
  describeOnChainError,
  findMintAuthority,
  findVaultAuthority,
  findProtocolConfig,
  DEVNET_FIXTURES,
  WRAPPED_SOL_MINT,
  usdToSolLamports,
  type NewReserveAddresses,
  type ReserveAssetAddresses,
  type ReserveOnChain,
} from "@ssr/sdk";
import { isRateLimitError, withRateLimitRetry, AmbiguousConfirmationError, confirmSignatureBounded } from "./rpcResilience";
import { computeFundingShortfall, determineDeploymentResumePoint, type ReserveOnChainStatus } from "./createReserveResume";

export {
  computeFundingShortfall,
  determineDeploymentResumePoint,
  isWalletRejectionError,
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
 * Converts a USD seed-allocation target into the raw token amount to deposit.
 * The DevNet fixture test assets are pegged 1 unit = $1 (see
 * FRONTEND_INTEGRATION.md), so their raw amount is just `usd * 10**decimals`.
 * Wrapped SOL is NOT 1:1 with USD -- it must go through the same
 * SOL_TEST_PRICE_USD conversion the Buy/Sell zap uses (usdToSolLamports),
 * otherwise a creator would be asked to wrap SOL_TEST_PRICE_USD-times too
 * much (or too little) real SOL for their stated USD allocation.
 */
function seedRawAmountForAsset(asset: Pick<CreateReserveAssetInput, "mint" | "decimals">, usd: number): bigint {
  if (isWrappedSol(asset.mint)) return usdToSolLamports(usd);
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
  /** Estimated base network fees across the (currently 2, or 3 if wrapping SOL) required transactions. */
  networkFeeLamportsEstimate: bigint;
  /** Grand total SOL the wallet will actually be asked to spend: rent + SOL seed funding + estimated network fees. */
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

/** Computes a real, on-chain-rent-calculator-backed cost estimate BEFORE any signature is requested -- see CreateDTR.tsx's Review & Deploy step. Never submits a transaction -- a failure here (e.g. rate-limiting) can never mean a launch partially happened. */
export async function estimateCreateReserveCost(
  connection: Connection,
  assets: CreateReserveAssetInput[],
  seedTotalUsd: number,
): Promise<CreateReserveCostEstimate> {
  const { reserveRent, mintRent, assetRent, vaultRent } = await getRentConstants(connection);

  const reserveAssetRentLamports = BigInt(assetRent) * BigInt(assets.length);
  const vaultRentLamports = BigInt(vaultRent) * BigInt(assets.length);
  const managerReserveTokenAtaRentLamports = BigInt(vaultRent); // an ATA is a TokenAccount, same size/rent

  const wrapAssets = assets.filter((a) => isWrappedSol(a.mint));
  const solSeedFundingLamports = wrapAssets.reduce((sum, a) => sum + seedRawAmountForAsset(a, seedTotalUsd * a.seedWeightFraction), 0n);
  // Wrapping SOL needs its own ATA + rent, paid by the creator, on top of the amount wrapped.
  const wsolAtaRent = wrapAssets.length > 0 ? BigInt(vaultRent) : 0n;

  const totalRentLamports =
    BigInt(reserveRent) + BigInt(mintRent) + reserveAssetRentLamports + vaultRentLamports + managerReserveTokenAtaRentLamports + wsolAtaRent;

  const numTransactions = wrapAssets.length > 0 ? 3 : 2;
  const networkFeeLamportsEstimate = ESTIMATED_TX_FEE_LAMPORTS * BigInt(numTransactions);

  return {
    reserveRentLamports: BigInt(reserveRent),
    reserveTokenMintRentLamports: BigInt(mintRent),
    reserveAssetRentLamports,
    vaultRentLamports,
    managerReserveTokenAtaRentLamports,
    solSeedFundingLamports,
    totalRentLamports,
    networkFeeLamportsEstimate,
    totalLamports: totalRentLamports + solSeedFundingLamports + networkFeeLamportsEstimate,
    numTransactions,
  };
}

/**
 * Signs, submits (once -- never auto-retried), and confirms via bounded
 * signature-status polling instead of `connection.confirmTransaction`'s
 * websocket subscription -- see zapClient.ts's signSubmitAndConfirm, which
 * this mirrors. Never resubmits on an ambiguous result; throws
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
async function signAndSend(connection: Connection, wallet: WalletContextState, ixs: TransactionInstruction[]): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected or does not support signing.");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  // A rejection here (the user closed/declined the wallet popup) happens
  // strictly before any submission -- propagated as-is, with its real
  // wallet-adapter name/message intact, so isWalletRejectionError can
  // classify it downstream as "nothing was ever sent," never something
  // requiring on-chain reconciliation.
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
  const outcome = await confirmSignatureBounded(connection, signature, lastValidBlockHeight);
  if (outcome.status === "confirmed") return signature;
  // describeOnChainError decodes a real ssr_protocol custom-error code
  // (e.g. UnexpectedReserveStatus) against the deployed IDL when present, or
  // says plainly that an unrecognized code (like the reported "6400", which
  // is outside this program's entire 6000-6040 custom-error range) is not a
  // genuine ssr_protocol error -- never a guessed meaning either way.
  if (outcome.status === "failed") throw new Error(describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}). Signature: ${signature}.`)));
  if (outcome.status === "expired") throw new Error(`Transaction expired before it could be confirmed (blockhash no longer valid) -- nothing should have moved. Signature: ${signature}.`);
  throw new AmbiguousConfirmationError(signature);
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
 * Funds only the genuine SHORTFALL between each asset's required seed amount
 * and what the wallet already, really holds -- the fix that makes
 * seed-funding idempotent. A first-time call behaves exactly as before
 * (shortfall against a zero balance is the full amount); a retry after a
 * partial success (e.g. the DevNet faucet call landed but the SOL-wrap tx
 * then hit an expired blockhash) tops up only what's still missing instead
 * of re-minting/re-wrapping the full amount again. Never submits anything
 * for an asset whose shortfall is already zero.
 */
async function fundSeedAssetsIdempotent(
  connection: Connection,
  wallet: WalletContextState,
  assets: Pick<CreateReserveAssetInput, "mint" | "decimals">[],
  seedAmounts: bigint[],
): Promise<string | null> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const owner = wallet.publicKey;

  const balances = await Promise.all(assets.map((a) => fetchOwnedBalanceRaw(connection, new PublicKey(a.mint), owner)));
  const shortfalls = assets.map((a, i) => ({ asset: a, amount: computeFundingShortfall(seedAmounts[i], balances[i]) }));

  const faucetAssets = shortfalls.filter(({ asset, amount }) => !isWrappedSol(asset.mint) && amount > 0n);
  const wrapAssets = shortfalls.filter(({ asset, amount }) => isWrappedSol(asset.mint) && amount > 0n);

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
    const wrapSig = await signAndSend(connection, wallet, wrapIxs);
    // If both faucet assets AND a SOL leg needed topping up, report the
    // SOL-wrap signature only when there was no faucet call to report
    // instead -- this return value just needs *a* representative signature.
    sig = sig ?? wrapSig;
  }
  return sig;
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
  constructor(message: string, step: CreateReserveStep, addresses: NewReserveAddresses | null) {
    super(message);
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
  assets: CreateReserveAssetInput[];
  seedTotalUsd: number;
  onProgress: (step: CreateReserveStep) => void;
  /** Fired the instant the target Reserve's addresses are derived (one ProtocolConfig read) -- lets the caller track exactly which Reserve this attempt targets (for reconciliation) without a second, redundant ProtocolConfig fetch of its own. */
  onAddressesResolved?: (addresses: NewReserveAddresses) => void;
}): Promise<CreateReserveResult> {
  const { connection, wallet } = params;
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
  const program = buildReadOnlyProgram(connection) as any;

  params.onProgress("create-and-register");
  const addresses: NewReserveAddresses = await deriveNewReserveAddresses(program, programId);
  params.onAddressesResolved?.(addresses);
  const assetAddresses: ReserveAssetAddresses[] = params.assets.map((a) => deriveReserveAssetAddresses(addresses.reserve, new PublicKey(a.mint), programId));

  let createAndRegisterSig: string;
  try {
    const createIx = await buildCreateReserveInstruction(program, addresses, wallet.publicKey, {
      metadataUri: params.metadataUri,
      mintFeeBps: params.mintFeeBps,
      redemptionFeeBps: 0,
      tvlFeeBps: params.tvlFeeBps,
      managerFeeShareBps: 8000,
      protocolFeeShareBps: 2000,
      feeDestination: params.feeDestination,
    });
    const registerIxs = await Promise.all(
      params.assets.map((a, i) => buildInitializeReserveAssetInstruction(program, addresses, assetAddresses[i], wallet.publicKey!, a.weightBps)),
    );
    createAndRegisterSig = await signAndSend(connection, wallet, [createIx, ...registerIxs]);
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "create-and-register", addresses);
  }

  params.onProgress("fund-seed-assets");
  const seedAmounts = params.assets.map((a) => seedRawAmountForAsset(a, params.seedTotalUsd * a.seedWeightFraction));

  let fundSeedAssetsSig: string | null = null;
  try {
    fundSeedAssetsSig = await fundSeedAssetsIdempotent(connection, wallet, params.assets, seedAmounts);
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "fund-seed-assets", addresses);
  }

  params.onProgress("seed");
  let seedSig: string;
  try {
    const initialReserveTokens = BigInt(Math.max(1, Math.floor(params.seedTotalUsd)) * 1_000_000);
    const seedIx = await buildSeedReserveInstruction(program, addresses, assetAddresses, wallet.publicKey, seedAmounts, initialReserveTokens);
    seedSig = await signAndSend(connection, wallet, [seedIx]);
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "seed", addresses);
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
}): Promise<CreateReserveResult> {
  const { connection, wallet, pending } = params;
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
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

  if (resumePoint.kind === "already-complete") {
    params.onProgress("done");
    return buildResult({ createAndRegister: null, fundSeedAssets: null, seed: null });
  }

  // resume-from-funding: create-and-register already landed with exactly the
  // expected assets registered. Fund any real shortfall, then seed.
  const program = buildReadOnlyProgram(connection) as any;
  const seedAmounts = pending.assets.map((a) => seedRawAmountForAsset(a, pending.seedTotalUsd * a.seedWeightFraction));

  params.onProgress("fund-seed-assets");
  let fundSeedAssetsSig: string | null = null;
  try {
    fundSeedAssetsSig = await fundSeedAssetsIdempotent(connection, wallet, pending.assets, seedAmounts);
  } catch (e) {
    throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "fund-seed-assets", addresses);
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
      const initialReserveTokens = BigInt(Math.max(1, Math.floor(pending.seedTotalUsd)) * 1_000_000);
      const seedIx = await buildSeedReserveInstruction(program, addresses, assetAddresses, wallet.publicKey, seedAmounts, initialReserveTokens);
      seedSig = await signAndSend(connection, wallet, [seedIx]);
    } catch (e) {
      throw new CreateReserveStepError(e instanceof Error ? e.message : String(e), "seed", addresses);
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
  /** Exactly the asset list (and order) create-and-register registered -- required to resume funding/seeding correctly. */
  assets: { mint: string; decimals: number; seedWeightFraction: number }[];
  seedTotalUsd: number;
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
