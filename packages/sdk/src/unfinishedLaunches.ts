// DEC-0296: finds a wallet's unfinished Reserve launches straight from the
// chain -- every Reserve whose `manager` is that wallet and whose status is
// still `created` or `assetsInitializing` (create-and-register landed, the
// seed never did). The browser's only record of such a launch used to be one
// localStorage entry (createReserveClient.ts's ssr_pending_reserve_deploy_v1),
// lost on another device, after clearing site data, or by the next launch.
//
// Two layers:
//   1. Pure helpers (offsets, the status filter, the decoded-account mapper)
//      covered offline by tests/phase_onchain_launch_resume.ts.
//   2. discoverUnfinishedLaunchesByScan: one getProgramAccounts memcmp on the
//      Reserve's `manager` field, then one memcmp per matching Reserve on the
//      ReserveAsset `reserve` field. Needs an RPC that allows the scan (the
//      paid Mainnet RPC, server side -- api/mainnet/unfinished-launches.ts;
//      the browser's rpc-proxy does not allow getProgramAccounts).
import { PublicKey, type Connection } from "@solana/web3.js";
import { buildReadOnlyProgram } from "./readOnly";
import { tokenProgramFromKind, type TokenProgramKindDecoded } from "./tokenPrograms";

/**
 * Byte offset of `Reserve.manager`: 8 (Anchor discriminator) + 1
 * (schema_version u8) + 8 (reserve_id u64). See
 * programs/ssr_protocol/src/state/reserve.rs.
 */
export const RESERVE_MANAGER_OFFSET = 8 + 1 + 8;
/** Byte offset of `ReserveAsset.reserve`: right after the 8-byte discriminator (state/reserve_asset.rs). */
export const RESERVE_ASSET_RESERVE_OFFSET = 8;

/** The two statuses a Reserve is in between create_reserve and seed_reserve. */
export const UNFINISHED_RESERVE_STATUSES = ["created", "assetsInitializing"] as const;
export type UnfinishedReserveStatus = (typeof UNFINISHED_RESERVE_STATUSES)[number];

export function isUnfinishedReserveStatus(status: string | null | undefined): status is UnfinishedReserveStatus {
  return status === "created" || status === "assetsInitializing";
}

export interface UnfinishedLaunchAsset {
  mint: string;
  decimals: number;
  weightBps: number;
  /** Base58 id of the token program the asset was registered under. */
  tokenProgram: string;
  orderIndex: number;
}

export interface UnfinishedLaunch {
  reserve: string;
  reserveId: string;
  manager: string;
  status: UnfinishedReserveStatus;
  /** Unix seconds, from `Reserve.created_at`. */
  createdAt: number;
  metadataUri: string;
  /** Configured gross mint fee; the seed pays the effective rate (DEC-0269 floor). */
  mintFeeBps: number;
  /** `Reserve.asset_count` -- what the program says is registered. */
  assetCount: number;
  totalTargetWeightBps: number;
  /** The registered assets that were found, in registration order. */
  assets: UnfinishedLaunchAsset[];
}

/** Minimal decoded shapes (Anchor camelCase) the mapper below needs. */
export interface DecodedReserveLike {
  reserveId: { toString(): string };
  manager: { toBase58(): string };
  status: object;
  assetCount: number;
  totalTargetWeightBps: number;
  createdAt: { toString(): string };
  metadataUri: string;
  feeConfig: { mintFeeBps: number };
}
export interface DecodedReserveAssetLike {
  assetMint: { toBase58(): string };
  decimals: number;
  targetWeightBps: number;
  tokenProgram: unknown;
  orderIndex: number;
}

/** Anchor encodes a unit enum as `{ variantName: {} }`. */
export function decodedStatusName(status: object): string {
  return Object.keys(status)[0] ?? "";
}

/**
 * Pure: turns one decoded Reserve (+ its decoded ReserveAsset accounts) into
 * an UnfinishedLaunch, or null when it is not an unfinished launch of
 * `wallet` (wrong manager, or already Active/Paused/WindDown/Closed). The
 * manager is checked again here even though the scan already filtered on it,
 * so a caller using a different source of accounts gets the same guarantee.
 */
export function toUnfinishedLaunch(
  wallet: string,
  reserveAddress: string,
  reserve: DecodedReserveLike,
  assets: DecodedReserveAssetLike[],
): UnfinishedLaunch | null {
  if (reserve.manager.toBase58() !== wallet) return null;
  const status = decodedStatusName(reserve.status);
  if (!isUnfinishedReserveStatus(status)) return null;
  const mapped = assets
    .map((a) => ({
      mint: a.assetMint.toBase58(),
      decimals: a.decimals,
      weightBps: a.targetWeightBps,
      tokenProgram: tokenProgramFromKind(a.tokenProgram as TokenProgramKindDecoded).toBase58(),
      orderIndex: a.orderIndex,
    }))
    .sort((x, y) => x.orderIndex - y.orderIndex);
  return {
    reserve: reserveAddress,
    reserveId: reserve.reserveId.toString(),
    manager: wallet,
    status,
    createdAt: Number(reserve.createdAt.toString()),
    metadataUri: reserve.metadataUri,
    mintFeeBps: reserve.feeConfig.mintFeeBps,
    assetCount: reserve.assetCount,
    totalTargetWeightBps: reserve.totalTargetWeightBps,
    assets: mapped,
  };
}

/**
 * Every unfinished launch managed by `wallet`, oldest Reserve first. Throws
 * when the scan itself fails (never reports "none" for an RPC error).
 */
export async function discoverUnfinishedLaunchesByScan(connection: Connection, wallet: PublicKey): Promise<UnfinishedLaunch[]> {
  const program = buildReadOnlyProgram(connection) as unknown as {
    account: {
      reserve: { all(filters: unknown[]): Promise<{ publicKey: PublicKey; account: DecodedReserveLike }[]> };
      reserveAsset: { all(filters: unknown[]): Promise<{ publicKey: PublicKey; account: DecodedReserveAssetLike }[]> };
    };
  };
  const reserves = await program.account.reserve.all([{ memcmp: { offset: RESERVE_MANAGER_OFFSET, bytes: wallet.toBase58() } }]);
  const unfinished = reserves.filter((r) => isUnfinishedReserveStatus(decodedStatusName(r.account.status)));
  const out: UnfinishedLaunch[] = [];
  for (const r of unfinished) {
    const assets = await program.account.reserveAsset.all([{ memcmp: { offset: RESERVE_ASSET_RESERVE_OFFSET, bytes: r.publicKey.toBase58() } }]);
    const launch = toUnfinishedLaunch(wallet.toBase58(), r.publicKey.toBase58(), r.account, assets.map((a) => a.account));
    if (launch) out.push(launch);
  }
  return out.sort((a, b) => Number(BigInt(a.reserveId) - BigInt(b.reserveId)));
}
