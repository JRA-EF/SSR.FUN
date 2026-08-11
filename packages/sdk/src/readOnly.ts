// Read-only access to deployed SSR Protocol accounts -- usable from the
// browser (no wallet needed for reads) and from Node scripts alike. Avoids
// getProgramAccounts entirely (confirmed blocked/403 on the public DevNet RPC,
// see docs/protocol/DEVNET_RUNBOOK.md) by always deriving PDAs directly from
// already-known inputs (reserve address + asset mint list) rather than
// scanning.
import { AnchorProvider, EventParser, Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../idl/ssr_protocol.json";
import type { SsrProtocol } from "../idl/ssr_protocol";
import { findReserveAsset, findReserveVault } from "./pda";

/**
 * A transient RPC failure (429/timeout) while reading token supply must
 * never be silently reported as "supply is actually zero" -- that's
 * indistinguishable downstream from a genuinely brand-new, not-yet-seeded
 * Reserve, and was observed live to make a real Buy against a real, fully
 * seeded Reserve fail with a misleading "Reserve must be seeded first"
 * error purely because one RPC call hit a 429 under congestion (see
 * docs/project/PROJECT_STATUS.md's Buy/confirmation RPC-resilience pass).
 * Bounded retry here (mirroring src/merge/lib/rpcResilience.ts's
 * withRateLimitRetry, duplicated rather than imported since packages/sdk
 * has no dependency on the frontend app) makes that misread far less
 * likely under ordinary congestion without changing the function's
 * null-safety contract for a genuinely unreadable/nonexistent mint.
 */
export function isRateLimitLikeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

export async function getTokenSupplyWithRetry(connection: Connection, mint: PublicKey, maxRetries = 3, baseDelayMs = 500) {
  let attempt = 0;
  for (;;) {
    try {
      return await connection.getTokenSupply(mint);
    } catch (e) {
      if (!isRateLimitLikeError(e) || attempt >= maxRetries) return null;
      const backoff = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * baseDelayMs));
      attempt += 1;
    }
  }
}

/**
 * Generic bounded rate-limit-only retry (mirroring src/merge/lib/rpcResilience.ts's
 * withRateLimitRetry, duplicated here for the same cross-boundary reason as
 * getTokenSupplyWithRetry above). Used by the landing-stats reads below,
 * which make several RPC calls per Reserve -- without this, a single
 * transient 429 anywhere in that chain would silently zero out that whole
 * Reserve's contribution to the aggregate (observed live: a real, in-window
 * trade was dropped from the 24h volume total this way before this retry
 * was added). Rethrows (never returns a fabricated fallback value) once
 * retries are exhausted or the error isn't rate-limit-shaped.
 */
export async function withRateLimitRetryGeneric<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 500): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimitLikeError(e) || attempt >= maxRetries) throw e;
      const backoff = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * baseDelayMs));
      attempt += 1;
    }
  }
}

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error("read-only provider cannot sign transactions");
  },
  signAllTransactions: async () => {
    throw new Error("read-only provider cannot sign transactions");
  },
};

export function buildReadOnlyProgram(connection: Connection): Program<SsrProtocol> {
  const provider = new AnchorProvider(connection, READ_ONLY_WALLET as unknown as AnchorProvider["wallet"], {
    commitment: "confirmed",
  });
  return new Program(idl as SsrProtocol, provider);
}

export interface ReserveAssetOnChain {
  assetMint: string;
  reserveAsset: string;
  vault: string;
  decimals: number;
  targetWeightBps: number;
  enabled: boolean;
  orderIndex: number;
  vaultBalanceRaw: string;
}

export interface ReserveOnChain {
  reserveId: string;
  manager: string;
  reserveTokenMint: string;
  status: string;
  /** Verified on-chain count of registered assets -- may exceed assets.length if candidateAssetMints didn't cover every one. */
  assetCount: number;
  totalTargetWeightBps: number;
  /** Redemption fee in bps, read live from Reserve.feeConfig -- used for honest in-kind Sell estimates (see computeRedemptionEntitlements). */
  redemptionFeeBps: number;
  /** Mint fee in bps, read live from Reserve.feeConfig. */
  mintFeeBps: number;
  /** Annualized TVL fee in bps, read live from Reserve.feeConfig. */
  tvlFeeBps: number;
  /** Fee destination wallet, read live from Reserve.feeConfig. */
  feeDestination: string;
  /** Pending Manager-share Reserve Token units accrued but not yet paid out, read live from Reserve.feeConfig -- raw base units. */
  pendingManagerFeeShares: string;
  /** Pending protocol-share Reserve Token units accrued but not yet paid out, read live from Reserve.feeConfig -- raw base units. */
  pendingProtocolFeeShares: string;
  metadataUri: string;
  reserveTokenSupplyRaw: string;
  assets: ReserveAssetOnChain[];
}

/**
 * Fetches full Reserve state given a reserve address and the (already known)
 * list of candidate asset mints -- typically from the fixture registry
 * (packages/sdk/src/fixtures.ts) or from the mints a client itself just
 * registered while creating a Reserve. Assets not actually registered on this
 * Reserve are silently skipped (their ReserveAsset PDA simply won't exist).
 */
export async function fetchReserveOnChain(
  connection: Connection,
  programId: PublicKey,
  reserveAddress: PublicKey,
  candidateAssetMints: PublicKey[],
): Promise<ReserveOnChain | null> {
  const program = buildReadOnlyProgram(connection);
  // Retried (mirroring discovery.ts's batched-and-retried reserve reads):
  // this single-Reserve fetch backs the post-launch redirect, resumability
  // reconciliation, and direct-link lookups -- an unretried transient 429
  // here was a direct contributor to a freshly-created or freshly-resumed
  // Reserve intermittently reading back as "doesn't exist" immediately after
  // its own transaction confirmed.
  const reserveAccount = await withRateLimitRetryGeneric(() => program.account.reserve.fetchNullable(reserveAddress));
  if (!reserveAccount) return null;

  const assets: ReserveAssetOnChain[] = [];
  for (const mint of candidateAssetMints) {
    const [reserveAssetPda] = findReserveAsset(reserveAddress, mint, programId);
    const [vaultPda] = findReserveVault(reserveAddress, mint, programId);
    const reserveAsset = await withRateLimitRetryGeneric(() => program.account.reserveAsset.fetchNullable(reserveAssetPda));
    if (!reserveAsset) continue;
    const vaultInfo = await withRateLimitRetryGeneric(() => getAccount(connection, vaultPda)).catch(() => null);
    assets.push({
      assetMint: mint.toBase58(),
      reserveAsset: reserveAssetPda.toBase58(),
      vault: vaultPda.toBase58(),
      decimals: reserveAsset.decimals,
      targetWeightBps: reserveAsset.targetWeightBps,
      enabled: reserveAsset.enabled,
      orderIndex: reserveAsset.orderIndex,
      vaultBalanceRaw: vaultInfo ? vaultInfo.amount.toString() : "0",
    });
  }
  assets.sort((a, b) => a.orderIndex - b.orderIndex);

  const supply = await getTokenSupplyWithRetry(connection, reserveAccount.reserveTokenMint);

  return {
    reserveId: reserveAccount.reserveId.toString(),
    manager: reserveAccount.manager.toBase58(),
    reserveTokenMint: reserveAccount.reserveTokenMint.toBase58(),
    status: Object.keys(reserveAccount.status as object)[0],
    assetCount: reserveAccount.assetCount,
    totalTargetWeightBps: reserveAccount.totalTargetWeightBps,
    redemptionFeeBps: reserveAccount.feeConfig.redemptionFeeBps,
    mintFeeBps: reserveAccount.feeConfig.mintFeeBps,
    tvlFeeBps: reserveAccount.feeConfig.annualTvlFeeBps,
    feeDestination: reserveAccount.feeConfig.feeDestination.toBase58(),
    pendingManagerFeeShares: reserveAccount.feeConfig.pendingManagerFeeShares.toString(),
    pendingProtocolFeeShares: reserveAccount.feeConfig.pendingProtocolFeeShares.toString(),
    metadataUri: reserveAccount.metadataUri,
    reserveTokenSupplyRaw: supply ? supply.value.amount : "0",
    assets,
  };
}

/** Fetches a wallet's Reserve Token balance for a given mint; returns "0" if the ATA doesn't exist yet. */
export async function fetchTokenBalanceRaw(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<string> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const info = await getAccount(connection, ata).catch(() => null);
  return info ? info.amount.toString() : "0";
}

// --- Landing-page KPI reads: real Reserve Token holder counts + real 24h volume ---
// Both of these are genuinely new capabilities, not present when this file's
// header comment ("avoids getProgramAccounts entirely") was written -- that
// avoidance was specifically about the public DevNet RPC's confirmed 403
// block on getProgramAccounts (see DEVNET_RUNBOOK.md). A dedicated provider
// (Helius) does NOT have that restriction (confirmed live), so
// getProgramAccounts is used here deliberately, scoped to a single call site
// each, server-side only (api/devnet/landing-stats.ts), never from the
// browser directly. Both functions degrade honestly: a failure propagates as
// a real thrown error rather than a fabricated 0, so the landing page can
// show "unavailable" instead of a false stat.

export interface AssetPricing {
  decimals: number;
  priceUsd: number;
}

/** Pure money-math, no I/O: values a set of asset legs (as emitted by ReserveTokensMinted/ReserveTokensRedeemed) at fixed DevNet test prices. An unpriced mint contributes 0 -- never a fabricated guess. */
export function valueAssetLegsUsd(mints: string[], amountsRaw: (string | bigint)[], pricing: Record<string, AssetPricing>): number {
  let total = 0;
  for (let i = 0; i < mints.length; i++) {
    const info = pricing[mints[i]];
    if (!info) continue;
    const raw = typeof amountsRaw[i] === "bigint" ? (amountsRaw[i] as bigint) : BigInt(amountsRaw[i]);
    total += (Number(raw) / 10 ** info.decimals) * info.priceUsd;
  }
  return total;
}

export interface ParsedTokenAccountLike {
  parsed?: { info?: { owner?: string; tokenAmount?: { uiAmount?: number | null } } };
}

/** Pure: counts entries with a genuine non-zero balance -- a closed/emptied token account (uiAmount 0 or missing) is never counted as a holder. */
export function countHoldersFromParsedAccounts(accounts: ParsedTokenAccountLike[]): number {
  let holders = 0;
  for (const account of accounts) {
    if ((account.parsed?.info?.tokenAmount?.uiAmount ?? 0) > 0) holders += 1;
  }
  return holders;
}

/**
 * Pure: the SET of distinct owner wallet addresses holding a genuine
 * non-zero balance -- the single source of truth every holder count in this
 * app (per-Reserve or global) is built from, so two different call sites can
 * never silently disagree. Returning owners (not just a count) is what makes
 * cross-Reserve deduplication possible: a wallet holding three different
 * Reserves' tokens must count once globally, which requires knowing WHICH
 * wallet, not just how many token accounts exist. A closed/emptied token
 * account (uiAmount 0 or missing) is never included, matching
 * countHoldersFromParsedAccounts's same rule.
 */
export function collectHolderOwners(accounts: ParsedTokenAccountLike[]): Set<string> {
  const owners = new Set<string>();
  for (const account of accounts) {
    const owner = account.parsed?.info?.owner;
    const uiAmount = account.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    if (owner && uiAmount > 0) owners.add(owner);
  }
  return owners;
}

/**
 * Real distinct owner set for a Reserve Token mint. The Reserve Token mint
 * itself is always classic SPL Token, never Token-2022 (seed_reserve/
 * create_reserve always build it via the anchor_spl::token::Token program,
 * fixed at 6 decimals, no freeze authority -- see DEC-0011 and
 * docs/protocol/ACCOUNT_MODEL.md) -- only a Reserve's underlying Reserve
 * Assets can ever be Token-2022, so a single TOKEN_PROGRAM_ID scan here is
 * complete, not a simplification that misses accounts. Requires a provider
 * with getProgramAccounts support (Helius; NOT the public DevNet endpoint,
 * which 403s this call).
 */
export async function fetchReserveTokenHolderOwners(connection: Connection, mint: PublicKey): Promise<Set<string>> {
  const accounts = await withRateLimitRetryGeneric(() =>
    connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
    }),
  );
  return collectHolderOwners(accounts.map(({ account }) => account.data as unknown as ParsedTokenAccountLike));
}

/** Counts distinct non-zero-balance token accounts for a given mint -- a genuine Reserve Token holder count. Requires a provider with getProgramAccounts support (Helius; NOT the public DevNet endpoint, which 403s this call). Thin wrapper over fetchReserveTokenHolderOwners so any single-Reserve caller that only needs a count doesn't have to build the full owner set itself. */
export async function fetchReserveTokenHolderCount(connection: Connection, mint: PublicKey): Promise<number> {
  return (await fetchReserveTokenHolderOwners(connection, mint)).size;
}

const VOLUME_MAX_SIGNATURE_PAGES = 5;
const VOLUME_SIGNATURES_PER_PAGE = 50;

/**
 * Real rolling-window trade volume for one Reserve, valued in USD at fixed
 * DevNet test prices (same honesty convention as TVL elsewhere -- see
 * TEST_ASSET_PRICES_USD-style tables). Pages getSignaturesForAddress
 * backwards from now, stopping as soon as a signature's blockTime falls
 * before `sinceUnixSec` (signatures are returned newest-first) or a bounded
 * page/signature cap is hit -- this is a real transaction-history walk, not
 * an estimate, but deliberately bounded so one very active Reserve can never
 * make this call unbounded-expensive.
 */
export async function fetchReserve24hVolumeUsd(
  connection: Connection,
  program: Program<SsrProtocol>,
  reserveAddress: PublicKey,
  pricing: Record<string, AssetPricing>,
  sinceUnixSec: number,
): Promise<number> {
  const eventParser = new EventParser(program.programId, program.coder);
  let volume = 0;
  let before: string | undefined;

  for (let page = 0; page < VOLUME_MAX_SIGNATURE_PAGES; page++) {
    const sigInfos = await withRateLimitRetryGeneric(() => connection.getSignaturesForAddress(reserveAddress, { limit: VOLUME_SIGNATURES_PER_PAGE, before }));
    if (sigInfos.length === 0) break;

    for (const sigInfo of sigInfos) {
      if (typeof sigInfo.blockTime === "number" && sigInfo.blockTime < sinceUnixSec) {
        return volume; // past the window; newest-first order means everything after this is even older
      }
      if (sigInfo.err) continue; // a failed transaction moved nothing

      const tx = await withRateLimitRetryGeneric(() => connection.getTransaction(sigInfo.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;

      // Anchor's EventParser reports event names camelCased with a lowercase
      // first letter (e.g. "reserveTokensMinted"), NOT the IDL's declared
      // PascalCase ("ReserveTokensMinted") -- confirmed live by decoding a
      // known real transaction's logs. Matching the IDL's casing here would
      // silently match nothing and this function would always report 0,
      // exactly as observed before this fix.
      for (const event of eventParser.parseLogs(logs)) {
        if (event.name === "reserveTokensMinted") {
          const data = event.data as { assetMints: PublicKey[]; assetAmountsIn: { toString(): string }[] };
          volume += valueAssetLegsUsd(
            data.assetMints.map((m) => m.toBase58()),
            data.assetAmountsIn.map((a) => a.toString()),
            pricing,
          );
        } else if (event.name === "reserveTokensRedeemed") {
          const data = event.data as { assetMints: PublicKey[]; assetAmountsOut: { toString(): string }[] };
          volume += valueAssetLegsUsd(
            data.assetMints.map((m) => m.toBase58()),
            data.assetAmountsOut.map((a) => a.toString()),
            pricing,
          );
        }
      }
    }

    if (sigInfos.length < VOLUME_SIGNATURES_PER_PAGE) break;
    before = sigInfos[sigInfos.length - 1].signature;
  }

  return volume;
}
