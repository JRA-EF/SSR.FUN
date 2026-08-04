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
import { getAccount } from "@solana/spl-token";
import { buildReadOnlyProgram } from "./readOnly";
import { findDelegate, findProtocolConfig, findReserve, findReserveAsset, findReserveVault } from "./pda";
import { withRateLimitRetry } from "./rpcResilience";

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
  const reserves: DiscoveredReserve[] = [];
  const issues: DiscoveryIssue[] = [];

  for (let id = 0n; id < protocolConfig.reserveCount; id++) {
    const [reserveAddress] = findReserve(id, programId);
    let reserveAccount: Awaited<ReturnType<typeof program.account.reserve.fetchNullable>>;
    try {
      reserveAccount = await program.account.reserve.fetchNullable(reserveAddress);
    } catch (e) {
      // A malformed/undecodable account at this id must not abort discovery
      // of every OTHER Reserve -- record it honestly and move on.
      issues.push({
        reserveId: id.toString(),
        scope: "reserve",
        detail: reserveAddress.toBase58(),
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    // A gap here would mean create_reserve succeeded without incrementing
    // reserve_count, which the program's own invariants don't allow -- but
    // never assume; skip honestly rather than throw the whole enumeration away.
    if (!reserveAccount) continue;

    const assets: DiscoveredReserveAsset[] = [];
    for (const mint of candidateAssetMints) {
      const [reserveAssetPda] = findReserveAsset(reserveAddress, mint, programId);
      const [vaultPda] = findReserveVault(reserveAddress, mint, programId);
      let reserveAsset: Awaited<ReturnType<typeof program.account.reserveAsset.fetchNullable>>;
      try {
        // Retried: a transient RPC 429/error on even one of the (up to 4)
        // legitimate candidate-asset reads must not permanently under-report
        // resolvedAssetCount for an otherwise fully-supported Reserve -- that
        // false positive is exactly what surfaced the "N registered, only M
        // resolved" banner under ordinary RPC congestion.
        reserveAsset = await withRateLimitRetry(() => program.account.reserveAsset.fetchNullable(reserveAssetPda));
      } catch (e) {
        issues.push({
          reserveId: id.toString(),
          scope: "asset",
          detail: `${mint.toBase58()} (${reserveAssetPda.toBase58()})`,
          message: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (!reserveAsset) continue;
      const vaultInfo = await withRateLimitRetry(() => getAccount(connection, vaultPda)).catch((e) => {
        issues.push({
          reserveId: id.toString(),
          scope: "vault",
          detail: vaultPda.toBase58(),
          message: e instanceof Error ? e.message : String(e),
        });
        return null;
      });
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

    const supply = await connection.getTokenSupply(reserveAccount.reserveTokenMint).catch((e) => {
      issues.push({
        reserveId: id.toString(),
        scope: "supply",
        detail: reserveAccount!.reserveTokenMint.toBase58(),
        message: e instanceof Error ? e.message : String(e),
      });
      return null;
    });

    reserves.push({
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
      metadataUri: reserveAccount.metadataUri,
      reserveTokenSupplyRaw: supply ? supply.value.amount : "0",
      delegateCount: reserveAccount.delegateCount,
      assets,
    });
  }

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
}

/**
 * Recovers a Decentralized Token Reserve's name/ticker/description/category
 * directly from its on-chain `metadataUri` field, when that field was
 * populated as a `data:application/json,...` URI (the real-deployment path
 * in src/merge/pages/CreateDTR.tsx does this). Returns null -- never a
 * fabricated guess -- for any Reserve whose metadataUri isn't in this exact
 * shape (e.g. the committed fixtures, seeded before this convention
 * existed), so callers can fall back to an honest "Unnamed Reserve" state
 * instead of inventing a name.
 */
export function parseReserveMetadataUri(metadataUri: string): ParsedReserveMetadata | null {
  const prefix = "data:application/json,";
  if (!metadataUri.startsWith(prefix)) return null;
  try {
    const json = JSON.parse(decodeURIComponent(metadataUri.slice(prefix.length))) as Record<string, unknown>;
    const name = typeof json.name === "string" ? json.name : "";
    const ticker = typeof json.ticker === "string" ? json.ticker : "";
    if (!name && !ticker) return null;
    return {
      name,
      ticker,
      description: typeof json.description === "string" ? json.description : "",
      category: typeof json.category === "string" ? json.category : "",
    };
  } catch {
    return null;
  }
}
