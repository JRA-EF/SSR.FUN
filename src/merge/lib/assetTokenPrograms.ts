// Which token program owns each Reserve Asset mint, resolved from the chain
// for the Manager Dashboard's composition actions (src/merge/lib/
// managementClient.ts: Submit Rebalance, Fund, Remove). Pure where it can
// be, so tests cover the decisions without an RPC.
//
// Why the chain and not the catalogue: the Rebalance tab acts on a
// Reserve's EXISTING assets too, and those came from wherever the Reserve
// was composed -- possibly before the catalogue carried a token program at
// all. The mint's own account owner is the authority the program itself
// consults, it cannot be stale, and it costs one batched read. Mirrors
// createReserveClient.ts's fetchOwnedBalanceRaw fallback and
// assertSelectedMintsAreSupported, which established the same policy for
// Create Reserve.
import { Connection, PublicKey } from "@solana/web3.js";
import { assessMintAccount, describeIncompatibleAsset, tokenProgramFromMintOwner, TOKEN_PROGRAM_ID } from "@ssr/sdk";

export type MintAccountLike = { data: Buffer; owner: PublicKey } | null | undefined;

export interface ResolvedAssetProgram {
  mint: PublicKey;
  /** The program the vault and every ATA for this asset must be derived under. */
  tokenProgram: PublicKey;
}

/**
 * Pure. One resolved program per mint, in order. A missing account (or a
 * skipped read, `infos === null`) resolves to classic SPL Token -- the
 * transaction then fails the way it always did for a Token-2022 asset rather
 * than this lookup blocking an action that would have worked for the
 * classic-token majority.
 */
export function resolveAssetTokenPrograms(mints: PublicKey[], infos: MintAccountLike[] | null): ResolvedAssetProgram[] {
  return mints.map((mint, i) => ({
    mint,
    tokenProgram: infos ? tokenProgramFromMintOwner(infos[i]?.owner) : TOKEN_PROGRAM_ID,
  }));
}

/**
 * Pure. The reasons a mint about to be REGISTERED on a live Reserve must be
 * refused, or an empty list. Same rules as Create Reserve
 * (assessMintAccount: a transfer hook, a confidential-transfer mint that
 * auto-approves, ...), applied here because add_reserve_asset_active is the
 * first instruction of a Submit Rebalance transaction -- refusing before the
 * wallet opens is what saves the Manager a paid failure. A skipped read
 * (`infos === null`) blocks nothing, for the same reason as above.
 */
export function describeUnsupportedNewAssets(
  assets: { mint: PublicKey; symbol?: string }[],
  infos: MintAccountLike[] | null,
): string[] {
  if (!infos) return [];
  const blocked: string[] = [];
  assets.forEach((a, i) => {
    const compat = assessMintAccount(a.mint, infos[i]);
    if (!compat.supported) blocked.push(describeIncompatibleAsset(a.symbol ?? a.mint.toBase58(), compat));
  });
  return blocked;
}

/** The raw mint accounts, or null when the read fails -- callers treat null as "unknown", never as "unsupported". */
export async function fetchMintAccounts(connection: Connection, mints: PublicKey[]): Promise<MintAccountLike[] | null> {
  if (mints.length === 0) return [];
  try {
    return (await connection.getMultipleAccountsInfo(mints)) as MintAccountLike[];
  } catch {
    return null;
  }
}
