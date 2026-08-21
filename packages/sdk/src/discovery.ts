// Canonical, on-chain-only discovery layer for SSR Protocol Decentralized
// Token Reserves (see docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md
// "Phase A" for the full requirement and design record). This module is the
// single source of truth for "which Reserves genuinely exist on the deployed
// program" -- nothing in the frontend should treat a hardcoded list or
// localStorage as a replacement for it.
//
// KEY ARCHITECTURAL FACT this module exploits: a Reserve PDA is seeded ONLY
// by a monotonic `reserveId` (see programs/ssr_protocol/src/constants.rs and
// packages/sdk/src/pda.ts's `findReserve`), and `ProtocolConfig.reserveCount`
// is a real, live, verifiable upper bound on how many exist. That means every
// Reserve can be enumerated with direct `getAccountInfo`-style reads (one per
// candidate `reserveId`, via the Anchor account client's `fetchNullable`) --
// NO `getProgramAccounts` call is required, which matters because the public
// DevNet RPC endpoint confirmed-blocks that method (403) -- see
// docs/protocol/DEVNET_RUNBOOK.md and packages/sdk/src/readOnly.ts's header
// comment for the same constraint.
//
// DOCUMENTED LIMITATION (do not silently work around): a Reserve's actual
// registered asset mints and delegate wallets are each addressed by a PDA
// seeded from (reserve, mint) or (reserve, wallet) respectively -- neither
// can be derived without already knowing the mint/wallet. `assetCount` and
// `delegateCount` on the Reserve account are real, verified on-chain counts,
// but resolving the actual asset/delegate PUBKEYS still requires either (a)
// a candidate-mint/candidate-wallet hint list (used ONLY as a discovery
// hint here, always followed by a real on-chain fetch -- never trusted on
// its own), or (b) a getProgramAccounts memcmp scan (blocked on the public
// DevNet RPC today), or (c) a protocol-level change to store the mint/wallet
// list directly on the Reserve account. The smallest fix is almost
// certainly (a dedicated/paid DevNet RPC provider that allows a memcmp
// scan) -- an infrastructure change, not a protocol change -- since the
// account model itself already exposes verified counts to detect
// under-resolution honestly (see `resolvedAssetCount`/`assetCount` below).
import { Connection, PublicKey } from "@solana/web3.js";
import { unpackAccount, unpackMint } from "@solana/spl-token";
import { buildReadOnlyProgram } from "./readOnly";
import { findDelegate, findProtocolConfig, findReserve, findReserveAsset, findReserveVault, findSettlementKeeperConfig } from "./pda";
import { withRateLimitRetry } from "./rpcResilience";
import { computeEffectiveFeeSplit, PROTOCOL_MIN_MINT_FEE_BPS, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS } from "./feeMath";

/**
 * Solana's `getMultipleAccounts` accepts up to ~100 pubkeys per call --
 * chunked conservatively under that so a single call never risks a
 * provider-side rejection. Pure and exported so its boundary behavior (0, 1,
 * exactly the chunk size, one more) is directly unit-tested without needing
 * a live Connection -- see tests/phase_discovery_reliability.ts.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const MAX_ACCOUNTS_PER_BATCH = 90;

export interface ProtocolConfigView {
  authority: string;
  paused: boolean;
  maxReserveAssets: number;
  defaultProtocolFeeBps: number;
  defaultProtocolFeeDestination: string;
  /** Also the exclusive upper bound on valid `reserveId`s -- see `discoverAllReserves`. */
  reserveCount: bigint;
}

/** Fetches the singleton ProtocolConfig account. Returns null only if the program has never been initialized. */
export async function fetchProtocolConfig(connection: Connection, programId: PublicKey): Promise<ProtocolConfigView | null> {
  const program = buildReadOnlyProgram(connection);
  const [address] = findProtocolConfig(programId);
  const pc = await program.account.protocolConfig.fetchNullable(address);
  if (!pc) return null;
  return {
    authority: pc.authority.toBase58(),
    paused: pc.paused,
    maxReserveAssets: pc.maxReserveAssets,
    defaultProtocolFeeBps: pc.defaultProtocolFeeBps,
    defaultProtocolFeeDestination: pc.defaultProtocolFeeDestination.toBase58(),
    reserveCount: BigInt(pc.reserveCount.toString()),
  };
}

/**
 * USDC fee-settlement pipeline (2026-08-21 pass): the configured keeper
 * wallet, from its own separate, protocol-wide singleton PDA (deliberately
 * NOT a ProtocolConfig field -- see state/protocol_config.rs's header).
 * Returns null if never configured (SettlementKeeperConfig doesn't exist
 * yet) -- every keeper-gated instruction requires a real, configured keeper
 * first.
 */
export async function fetchSettlementKeeperConfig(connection: Connection, programId: PublicKey): Promise<{ keeper: string } | null> {
  const program = buildReadOnlyProgram(connection);
  const [address] = findSettlementKeeperConfig(programId);
  const config = await program.account.settlementKeeperConfig.fetchNullable(address);
  if (!config) return null;
  return { keeper: config.keeper.toBase58() };
}

export interface DiscoveredReserveAsset {
  assetMint: string;
  reserveAsset: string;
  vault: string;
  decimals: number;
  targetWeightBps: number;
  enabled: boolean;
  orderIndex: number;
  vaultBalanceRaw: string;
}

export interface DiscoveredReserve {
  reserveId: string;
  reserve: string;
  manager: string;
  reserveTokenMint: string;
  /** "active" | "paused" | "created" | "assetsInitializing" -- mirrors ReserveStatus. */
  status: string;
  /** Verified on-chain count of registered assets -- may exceed `assets.length`, see `resolvedAssetCount`. */
  assetCount: number;
  /** How many of `assetCount` this pass actually resolved, given its candidate-mint hints. Honest signal for the UI: assets.length === resolvedAssetCount always; compare against assetCount to detect under-resolution. */
  resolvedAssetCount: number;
  totalTargetWeightBps: number;
  mintFeeBps: number;
  redemptionFeeBps: number;
  annualTvlFeeBps: number;
  managerFeeShareBps: number;
  protocolFeeShareBps: number;
  feeDestination: string;
  pendingManagerFeeShares: string;
  pendingProtocolFeeShares: string;
  /** Unix seconds of the last accrue_fees checkpoint -- used by api/devnet/accrue-fees-cron.ts to find dormant Reserves needing a TVL-fee catch-up. */
  lastFeeAccrualTs: string;
  /** DEC-0094: effective Protocol/Manager split, computed fresh via feeMath.computeEffectiveFeeSplit -- see ReserveOnChain's identical fields in readOnly.ts for the full explanation. */
  effectiveMintFeeProtocolBps: number;
  effectiveMintFeeManagerBps: number;
  effectiveMintFeeTotalBps: number;
  effectiveTvlFeeProtocolBps: number;
  effectiveTvlFeeManagerBps: number;
  effectiveTvlFeeTotalBps: number;
  metadataUri: string;
  reserveTokenSupplyRaw: string;
  /** Verified on-chain count of granted delegates -- see `discoverDelegatesForReserve` for resolving actual wallets. */
  delegateCount: number;
  assets: DiscoveredReserveAsset[];
}

/**
 * Enumerates EVERY Reserve that exists on the deployed program -- fixtures,
 * a Reserve like "TestLo", or any other dynamically created Reserve -- using
 * only direct account reads (no getProgramAccounts). This is the canonical,
 * on-chain source of "which Reserves exist."
 *
 * `candidateAssetMints` is used only as a discovery HINT to resolve as many
 * of each Reserve's `assetCount` assets as possible -- never as canonical
 * identity. An asset whose mint isn't in this list is invisible to this
 * pass; that's reflected honestly via `resolvedAssetCount < assetCount`,
 * never silently hidden or fabricated.
 */
export interface DiscoveryIssue {
  reserveId: string;
  scope: "reserve" | "asset" | "vault" | "supply";
  detail: string;
  message: string;
}

export async function discoverAllReserves(
  connection: Connection,
  programId: PublicKey,
  candidateAssetMints: PublicKey[],
): Promise<{ reserves: DiscoveredReserve[]; protocolConfig: ProtocolConfigView | null; issues: DiscoveryIssue[] }> {
  const protocolConfig = await fetchProtocolConfig(connection, programId);
  if (!protocolConfig) return { reserves: [], protocolConfig: null, issues: [] };

  const program = buildReadOnlyProgram(connection);
  const issues: DiscoveryIssue[] = [];

  // --- Pass 1: batch-fetch every candidate Reserve account -----------------
  // Previously one sequential, UNRETRIED fetchNullable per reserveId -- at
  // the current ~30 Reserves (and growing) that's 30 unretried round trips
  // just for this pass, and a single transient hiccup on any one of them
  // silently dropped that Reserve for the whole poll cycle with no retry at
  // all (unlike the per-asset reads below, which already retried). Batched
  // via Anchor's fetchMultiple (one getMultipleAccounts call per chunk,
  // chunked under Solana's ~100-account limit) and retried per chunk -- a
  // chunk that fails even after retry records an issue for every reserveId
  // in it (never silently drops a whole chunk without a trace) but still
  // lets every OTHER chunk resolve normally.
  interface ReserveCandidate {
    id: bigint;
    address: PublicKey;
  }
  const candidates: ReserveCandidate[] = [];
  for (let id = 0n; id < protocolConfig.reserveCount; id++) {
    candidates.push({ id, address: findReserve(id, programId)[0] });
  }

  type ReserveAccountDecoded = Awaited<ReturnType<typeof program.account.reserve.fetchNullable>>;
  const reserveAccountByAddress = new Map<string, NonNullable<ReserveAccountDecoded>>();
  for (const batch of chunkArray(candidates, MAX_ACCOUNTS_PER_BATCH)) {
    try {
      const results = await withRateLimitRetry(() => program.account.reserve.fetchMultiple(batch.map((c) => c.address)));
      results.forEach((account, i) => {
        // A gap here would mean create_reserve succeeded without
        // incrementing reserve_count, which the program's own invariants
        // don't allow -- but never assume; skip honestly rather than throw
        // the whole enumeration away.
        if (account) reserveAccountByAddress.set(batch[i].address.toBase58(), account);
      });
    } catch (e) {
      for (const c of batch) {
        issues.push({ reserveId: c.id.toString(), scope: "reserve", detail: c.address.toBase58(), message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  const resolvedReserves = candidates.filter((c) => reserveAccountByAddress.has(c.address.toBase58()));

  // --- Pass 2: batch-fetch every candidate (reserve, asset) PDA ------------
  // Previously up to `candidateAssetMints.length` sequential reads PER
  // reserve (already retried individually, but still one round trip each).
  // Flattened across every resolved Reserve and batched the same way.
  interface AssetCandidate {
    id: bigint;
    reserveAddress: PublicKey;
    mint: PublicKey;
    reserveAssetPda: PublicKey;
    vaultPda: PublicKey;
  }
  const assetCandidates: AssetCandidate[] = [];
  for (const { id, address: reserveAddress } of resolvedReserves) {
    for (const mint of candidateAssetMints) {
      const [reserveAssetPda] = findReserveAsset(reserveAddress, mint, programId);
      const [vaultPda] = findReserveVault(reserveAddress, mint, programId);
      assetCandidates.push({ id, reserveAddress, mint, reserveAssetPda, vaultPda });
    }
  }

  type ReserveAssetDecoded = Awaited<ReturnType<typeof program.account.reserveAsset.fetchNullable>>;
  const reserveAssetByPda = new Map<string, NonNullable<ReserveAssetDecoded>>();
  for (const batch of chunkArray(assetCandidates, MAX_ACCOUNTS_PER_BATCH)) {
    try {
      const results = await withRateLimitRetry(() => program.account.reserveAsset.fetchMultiple(batch.map((c) => c.reserveAssetPda)));
      results.forEach((account, i) => {
        if (account) reserveAssetByPda.set(batch[i].reserveAssetPda.toBase58(), account);
      });
    } catch (e) {
      for (const c of batch) {
        issues.push({
          reserveId: c.id.toString(),
          scope: "asset",
          detail: `${c.mint.toBase58()} (${c.reserveAssetPda.toBase58()})`,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Vaults are raw SPL token accounts (not Anchor-decoded) -- batch the same
  // way via connection.getMultipleAccountsInfo, only for assets that
  // genuinely resolved above (a vault for a never-registered asset doesn't
  // exist and was never fetched individually either).
  const resolvedAssetCandidates = assetCandidates.filter((c) => reserveAssetByPda.has(c.reserveAssetPda.toBase58()));
  const vaultBalanceByPda = new Map<string, string>();
  for (const batch of chunkArray(resolvedAssetCandidates, MAX_ACCOUNTS_PER_BATCH)) {
    try {
      const infos = await withRateLimitRetry(() => connection.getMultipleAccountsInfo(batch.map((c) => c.vaultPda)));
      infos.forEach((info, i) => {
        try {
          vaultBalanceByPda.set(batch[i].vaultPda.toBase58(), unpackAccount(batch[i].vaultPda, info).amount.toString());
        } catch (e) {
          issues.push({ reserveId: batch[i].id.toString(), scope: "vault", detail: batch[i].vaultPda.toBase58(), message: e instanceof Error ? e.message : String(e) });
        }
      });
    } catch (e) {
      for (const c of batch) {
        issues.push({ reserveId: c.id.toString(), scope: "vault", detail: c.vaultPda.toBase58(), message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // --- Pass 3: batch-fetch every resolved Reserve's token-supply mint ------
  // Previously one sequential, UNRETRIED connection.getTokenSupply per
  // resolved Reserve. Batched via getMultipleAccountsInfo + unpackMint
  // (decoding the raw Mint layout ourselves, since there's no batched
  // get-token-supply RPC method) and retried per chunk, same as passes 1-2.
  const supplyByMint = new Map<string, string>();
  for (const batch of chunkArray(resolvedReserves, MAX_ACCOUNTS_PER_BATCH)) {
    const mints = batch.map((c) => reserveAccountByAddress.get(c.address.toBase58())!.reserveTokenMint);
    try {
      const infos = await withRateLimitRetry(() => connection.getMultipleAccountsInfo(mints));
      infos.forEach((info, i) => {
        try {
          supplyByMint.set(mints[i].toBase58(), unpackMint(mints[i], info).supply.toString());
        } catch (e) {
          issues.push({ reserveId: batch[i].id.toString(), scope: "supply", detail: mints[i].toBase58(), message: e instanceof Error ? e.message : String(e) });
        }
      });
    } catch (e) {
      batch.forEach((c, i) => {
        issues.push({ reserveId: c.id.toString(), scope: "supply", detail: mints[i].toBase58(), message: e instanceof Error ? e.message : String(e) });
      });
    }
  }

  // --- Assemble ---------------------------------------------------------
  const reserves: DiscoveredReserve[] = resolvedReserves.map(({ address: reserveAddress }) => {
    const reserveAccount = reserveAccountByAddress.get(reserveAddress.toBase58())!;
    const assets: DiscoveredReserveAsset[] = assetCandidates
      .filter((c) => c.reserveAddress.equals(reserveAddress))
      .map((c) => reserveAssetByPda.has(c.reserveAssetPda.toBase58()) ? { c, reserveAsset: reserveAssetByPda.get(c.reserveAssetPda.toBase58())! } : null)
      .filter((x): x is { c: AssetCandidate; reserveAsset: NonNullable<ReserveAssetDecoded> } => x !== null)
      .map(({ c, reserveAsset }) => ({
        assetMint: c.mint.toBase58(),
        reserveAsset: c.reserveAssetPda.toBase58(),
        vault: c.vaultPda.toBase58(),
        decimals: reserveAsset.decimals,
        targetWeightBps: reserveAsset.targetWeightBps,
        enabled: reserveAsset.enabled,
        orderIndex: reserveAsset.orderIndex,
        vaultBalanceRaw: vaultBalanceByPda.get(c.vaultPda.toBase58()) ?? "0",
      }))
      .sort((a, b) => a.orderIndex - b.orderIndex);

    return {
      reserveId: reserveAccount.reserveId.toString(),
      reserve: reserveAddress.toBase58(),
      manager: reserveAccount.manager.toBase58(),
      reserveTokenMint: reserveAccount.reserveTokenMint.toBase58(),
      status: Object.keys(reserveAccount.status as object)[0],
      assetCount: reserveAccount.assetCount,
      resolvedAssetCount: assets.length,
      totalTargetWeightBps: reserveAccount.totalTargetWeightBps,
      mintFeeBps: reserveAccount.feeConfig.mintFeeBps,
      redemptionFeeBps: reserveAccount.feeConfig.redemptionFeeBps,
      annualTvlFeeBps: reserveAccount.feeConfig.annualTvlFeeBps,
      managerFeeShareBps: reserveAccount.feeConfig.managerFeeShareBps,
      protocolFeeShareBps: reserveAccount.feeConfig.protocolFeeShareBps,
      feeDestination: reserveAccount.feeConfig.feeDestination.toBase58(),
      pendingManagerFeeShares: reserveAccount.feeConfig.pendingManagerFeeShares.toString(),
      pendingProtocolFeeShares: reserveAccount.feeConfig.pendingProtocolFeeShares.toString(),
      lastFeeAccrualTs: reserveAccount.feeConfig.lastFeeAccrualTs.toString(),
      effectiveMintFeeProtocolBps: Number(computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS).protocolBps),
      effectiveMintFeeManagerBps: Number(computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS).managerBps),
      effectiveMintFeeTotalBps: Number(computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS).effectiveTotalBps),
      effectiveTvlFeeProtocolBps: Number(computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.annualTvlFeeBps), PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS).protocolBps),
      effectiveTvlFeeManagerBps: Number(computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.annualTvlFeeBps), PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS).managerBps),
      effectiveTvlFeeTotalBps: Number(computeEffectiveFeeSplit(BigInt(reserveAccount.feeConfig.annualTvlFeeBps), PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS).effectiveTotalBps),
      metadataUri: reserveAccount.metadataUri,
      reserveTokenSupplyRaw: supplyByMint.get(reserveAccount.reserveTokenMint.toBase58()) ?? "0",
      delegateCount: reserveAccount.delegateCount,
      assets,
    };
  });

  return { reserves, protocolConfig, issues };
}

export interface DiscoveredDelegate {
  wallet: string;
  delegateAccount: string;
  permissions: number;
  restricted: boolean;
  addedAt: number;
}

/**
 * Best-effort delegate discovery for one Reserve, given known candidate
 * wallets (the connected wallet, the Reserve's manager, or wallets already
 * on record from local delegate labels -- see delegateLabels.ts). Cannot
 * enumerate ALL of a Reserve's `delegateCount` delegates without a
 * getProgramAccounts memcmp scan (blocked on the public DevNet RPC) or a
 * full candidate list -- this is a documented limitation, not silently
 * worked around. Returns only delegates that genuinely verify on-chain.
 */
export async function discoverDelegatesForReserve(
  connection: Connection,
  programId: PublicKey,
  reserve: PublicKey,
  candidateWallets: PublicKey[],
): Promise<DiscoveredDelegate[]> {
  const program = buildReadOnlyProgram(connection);
  const seen = new Set<string>();
  const results: DiscoveredDelegate[] = [];
  for (const wallet of candidateWallets) {
    const key = wallet.toBase58();
    // A duplicate candidate wallet (e.g. the manager also appearing in a
    // caller-supplied hint list) must resolve once, not be reported twice.
    if (seen.has(key)) continue;
    seen.add(key);
    const [delegatePda] = findDelegate(reserve, wallet, programId);
    let account: Awaited<ReturnType<typeof program.account.delegate.fetchNullable>>;
    try {
      account = await program.account.delegate.fetchNullable(delegatePda);
    } catch {
      // A malformed/undecodable candidate delegate account must not abort
      // resolution of every OTHER candidate -- skip it honestly.
      continue;
    }
    if (!account) continue;
    // Defense in depth: the PDA derivation already ties this account to
    // (reserve, wallet), but explicitly confirm the decoded fields agree
    // with what was requested rather than trusting the address alone --
    // guards against a future PDA-seed change silently mismatching data.
    if (account.reserve.toBase58() !== reserve.toBase58() || account.wallet.toBase58() !== key) continue;
    results.push({
      wallet: key,
      delegateAccount: delegatePda.toBase58(),
      permissions: account.permissions,
      restricted: account.restricted,
      addedAt: Number(account.addedAt.toString()),
    });
  }
  return results;
}

export interface ParsedReserveMetadata {
  name: string;
  ticker: string;
  description: string;
  category: string;
  /**
   * Manager-configured secondary-market Buy/Sell tax, as a percent (e.g. 0.5
   * = 0.5%). Forward-looking configuration only -- there is no secondary
   * market (DEX/AMM) for the Reserve Token today, and neither
   * mint_reserve_tokens_in_kind nor redeem_reserve_tokens_in_kind enforces
   * this value; it is not a mint or redemption fee. Defaults to 0 when
   * absent (every Reserve created before this field existed).
   */
  buyTaxPct: number;
  sellTaxPct: number;
}

/** Shared by parseReserveMetadataUri (inline data: URI) and resolveReserveMetadata (a fetched HTTPS payload) -- the ONE place a raw JSON value becomes a ParsedReserveMetadata, so the two never drift. Returns null -- never a fabricated guess -- when neither name nor ticker is present. */
function metadataFromJson(json: unknown): ParsedReserveMetadata | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const name = typeof j.name === "string" ? j.name : "";
  const ticker = typeof j.ticker === "string" ? j.ticker : "";
  if (!name && !ticker) return null;
  return {
    name,
    ticker,
    description: typeof j.description === "string" ? j.description : "",
    category: typeof j.category === "string" ? j.category : "",
    buyTaxPct: typeof j.buyTaxPct === "number" && Number.isFinite(j.buyTaxPct) ? j.buyTaxPct : 0,
    sellTaxPct: typeof j.sellTaxPct === "number" && Number.isFinite(j.sellTaxPct) ? j.sellTaxPct : 0,
  };
}

/**
 * Recovers a Reserve's name/ticker/description/category directly from its
 * on-chain `metadataUri` field, when that field was populated as a
 * `data:application/json,...` URI (the ORIGINAL real-deployment convention
 * -- superseded by resolveReserveMetadata below once metadataUri became a
 * short permanent URL instead, see docs/project/DECISION_LOG.md's
 * MetadataUriTooLong fix, but still the correct/only way to read a Reserve
 * created before that fix, and the 2 committed fixtures never used either
 * scheme). Returns null -- never a fabricated guess -- for any Reserve whose
 * metadataUri isn't in this exact shape, so callers can fall back to an
 * honest "Unnamed Reserve" state instead of inventing a name. Purely
 * synchronous, no network I/O -- kept this way so every existing caller
 * that doesn't need the URL case keeps working unchanged.
 */
export function parseReserveMetadataUri(metadataUri: string): ParsedReserveMetadata | null {
  const prefix = "data:application/json,";
  if (!metadataUri.startsWith(prefix)) return null;
  try {
    return metadataFromJson(JSON.parse(decodeURIComponent(metadataUri.slice(prefix.length))));
  } catch {
    return null;
  }
}

/**
 * Async superset of parseReserveMetadataUri: additionally resolves a real
 * permanent HTTPS URL by fetching it -- this app's own
 * api/devnet/reserve-metadata.ts (what CreateDTR.tsx's uploadReserveMetadata
 * actually produces since the MetadataUriTooLong fix), or any other
 * JSON-serving HTTPS URL (a gateway-fronted IPFS/Arweave link is still
 * https://, so it's covered the same way -- see metadataUri.ts's header for
 * why raw ipfs://ar:// URIs are accepted on-chain but this app's own
 * pipeline never produces them). Tries the synchronous data: URI case
 * FIRST (no network round trip needed for a Reserve created before this
 * fix, or a committed fixture) -- only attempts a fetch when that returns
 * null AND the URI is genuinely http(s). Bounded by `timeoutMs` so one slow
 * or hanging Reserve's metadata host can never stall an entire discovery
 * pass. Returns null -- never throws, never a fabricated guess -- for
 * anything unresolvable (network failure, 404, non-JSON body, timeout,
 * unsupported scheme).
 */
export async function resolveReserveMetadata(metadataUri: string, timeoutMs = 5000): Promise<ParsedReserveMetadata | null> {
  const inline = parseReserveMetadataUri(metadataUri);
  if (inline) return inline;
  if (!/^https?:\/\//i.test(metadataUri)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(metadataUri, { signal: controller.signal });
    if (!response.ok) return null;
    return metadataFromJson(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
