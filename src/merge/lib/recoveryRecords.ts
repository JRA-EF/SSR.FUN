// Records the /recover page (DEC-0241) reads beyond the mint/redeem flows'
// own pending state: a Reserve creation the user cancelled after its seed
// swaps landed, and a completed mint whose swap buffer left a little of
// each asset behind. A leaf module on purpose -- the buy client and the
// Create page write here, lib/incompleteTransactions.ts reads, and neither
// side has to import the other.
import type { PersistedAssetFunding } from "./launchFunding";

const ABANDONED_CREATE_KEY = "ssr_abandoned_creates_v1";
const MINT_DUST_KEY = "ssr_mint_dust_v1";

/** A cancelled Create: the seed swaps it already ran are what may be converted back. */
export interface AbandonedCreateRecord {
  wallet: string;
  reserve: string;
  /** Program the Reserve lives under -- read once more before converting, so a Reserve that did get seeded is never mistaken for a cancelled one. */
  programId: string;
  name: string;
  startedAt: number;
  assetFunding: Record<string, PersistedAssetFunding>;
}

/** A completed mint: what its swaps acquired, and the mint transaction that consumed most of it. */
export interface MintDustRecord {
  wallet: string;
  reserve: string;
  startedAt: number;
  mintSignature: string;
  reserveTokenMint: string;
  /** Raw amount each batch swap acquired (empty for a single atomic transaction, whose own token deltas carry the leftover). */
  acquiredRaw: Record<string, string>;
}

const mapKey = (wallet: string, reserve: string) => `${wallet}:${reserve}`;

function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Record<string, T>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeEntry<T>(key: string, wallet: string, reserve: string, value: T | null): void {
  try {
    const map = readMap<T>(key);
    if (value === null) delete map[mapKey(wallet, reserve)];
    else map[mapKey(wallet, reserve)] = value;
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Best-effort, like every other pending-state write in this app.
  }
}

function forWallet<T extends { wallet: string; reserve: string }>(key: string, wallet: string): T[] {
  return Object.values(readMap<T>(key)).filter((e) => e && e.wallet === wallet && typeof e.reserve === "string");
}

/** Saved only when at least one seed swap was submitted -- a Create that never swapped left nothing behind. Returns whether it was saved. */
export function recordAbandonedCreate(rec: AbandonedCreateRecord): boolean {
  if (!Object.values(rec.assetFunding ?? {}).some((f) => f.lastSignature)) return false;
  writeEntry(ABANDONED_CREATE_KEY, rec.wallet, rec.reserve, rec);
  return true;
}
export const readAbandonedCreates = (wallet: string) => forWallet<AbandonedCreateRecord>(ABANDONED_CREATE_KEY, wallet);
export const clearAbandonedCreate = (wallet: string, reserve: string) => writeEntry<AbandonedCreateRecord>(ABANDONED_CREATE_KEY, wallet, reserve, null);

export const recordMintDust = (rec: MintDustRecord) => writeEntry(MINT_DUST_KEY, rec.wallet, rec.reserve, rec);
export const readMintDust = (wallet: string) => forWallet<MintDustRecord>(MINT_DUST_KEY, wallet);
export const clearMintDust = (wallet: string, reserve: string) => writeEntry<MintDustRecord>(MINT_DUST_KEY, wallet, reserve, null);
