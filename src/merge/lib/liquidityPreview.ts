/**
 * Liquidity Module -- design-preview state shapes and helpers.
 *
 * This is the front-end preview of the creator liquidity feature specced in
 * docs/project/LIQUIDITY_MODULE_SPEC.md: a Reserve's root Manager seeds a
 * DEX pool for their Reserve Token (Raydium on Solana, Uniswap on Robinhood
 * Chain), optionally locks the position, and collects accrued trading fees
 * into the Reserve treasury.
 *
 * Nothing in this file talks to a chain. Every surface rendering from it is
 * explicitly labelled a design preview, consistent with this repo's
 * no-fabricated-success rule (see the removed `buyDTRToken` mock trade in
 * DTRDetail.tsx): preview state is never presented as a confirmed on-chain
 * outcome. When the real Raydium/Uniswap integration lands it replaces the
 * three store actions in useAppStore.ts (`addLiquidityPreview`,
 * `lockLiquidityPreview`, `collectLiquidityPreviewFees`); the components are
 * written against this module's types so the swap stays contained.
 */

export type ReserveChain = "solana" | "robinhood";

export interface DexInfo {
  chain: ReserveChain;
  /** User-facing DEX name. The ONLY source for it -- components must never hardcode "Raydium"/"Uniswap". */
  name: "Raydium" | "Uniswap";
  poolTypeLabel: "standard pool" | "full-range position";
  /** The non-USDC pairing option offered alongside USDC on this chain. */
  altPairSymbol: "SOL" | "ETH";
}

/**
 * Chain-aware DEX rule (LIQUIDITY_MODULE_SPEC.md, Section 5): every DEX
 * reference in the UI derives from the Reserve's home chain -- the chain its
 * Reserve Token is minted on and its vault lives on.
 */
export function dexInfoFor(chain: ReserveChain): DexInfo {
  if (chain === "robinhood") {
    return { chain, name: "Uniswap", poolTypeLabel: "full-range position", altPairSymbol: "ETH" };
  }
  return { chain, name: "Raydium", poolTypeLabel: "standard pool", altPairSymbol: "SOL" };
}

/**
 * The chain a Reserve's mint and vault live on. Every Reserve the app can
 * show today is on Solana; this exists so a Robinhood Reserve renders
 * Uniswap everywhere the moment one exists, with no per-surface edits.
 */
export function reserveChain(_dtr: { id: string }): ReserveChain {
  return "solana";
}

export type LiquidityLockMode = "none" | "timed" | "permanent";

export interface LiquidityLock {
  mode: LiquidityLockMode;
  /** Lock length in months. Only for mode "timed". */
  months?: number;
  /** Unlock timestamp (ms since epoch). Only for mode "timed". */
  unlockTs?: number;
}

export interface LiquidityPoolPreview {
  /** Deterministic, address-shaped placeholder id -- NOT a real on-chain account. */
  poolAddress: string;
  chain: ReserveChain;
  quoteSymbol: "USDC" | "SOL" | "ETH";
  /** Reserve Tokens deposited into the position. */
  baseTokens: number;
  /** Pairing-asset side of the position, in USD. */
  quoteUsd: number;
  createdTs: number;
  lock: LiquidityLock;
  /** Fees already collected to the Reserve treasury in this preview, USD lifetime total. */
  collectedTotalUsd: number;
  /** Fee accrual restarts from here after each collect. */
  collectedThroughTs: number;
}

export const MIN_LIQUIDITY_USD = 1000;
export const RECOMMENDED_LIQUIDITY_USD = 10000;
export const QUICK_AMOUNTS_USD = [1000, 5000, 10000];
export const LOCK_MONTH_PRESETS = [1, 3, 6, 12];

/**
 * TVL at or above this counts as "deep liquidity" and earns the extra badge
 * on the Reserve page. Placeholder threshold pending a Creator ruling
 * (LIQUIDITY_MODULE_SPEC.md, OPEN-9) -- a live version likely wants this
 * relative to the Reserve's AUM, not one absolute number.
 */
export const DEEP_LIQUIDITY_USD = 100_000;

export function isDeepLiquidity(tvlUsd: number): boolean {
  return tvlUsd >= DEEP_LIQUIDITY_USD;
}

/**
 * Which of the three lock-state badges a pool shows (the canvas "Liquidity
 * trust badge states" artboard). An expired timed lock reads as unlocked --
 * the countdown hit zero, so the position is withdrawable again.
 */
export type LiquidityBadgeKind = "unlocked" | "locked" | "permanent";

export function liquidityBadgeKind(lock: LiquidityLock, now: number = Date.now()): LiquidityBadgeKind {
  if (lock.mode === "permanent") return "permanent";
  if (lock.mode === "timed" && (lock.unlockTs ?? 0) > now) return "locked";
  return "unlocked";
}

export function poolTvlUsd(pool: LiquidityPoolPreview, navPerToken: number): number {
  return pool.baseTokens * navPerToken + pool.quoteUsd;
}

/**
 * Preview-only fee accrual: a deterministic 0.08% of pool TVL per day since
 * the last collect, computed on read (no timers, no invented randomness).
 * Stands in for real swap-fee accrual until the live integration reads it
 * from the pool.
 */
export function accruedFeesUsd(pool: LiquidityPoolPreview, navPerToken: number, now: number = Date.now()): number {
  const days = Math.max(0, (now - pool.collectedThroughTs) / 86_400_000);
  return poolTvlUsd(pool, navPerToken) * 0.0008 * days;
}

/** Stable, base58-alphabet placeholder derived from the Reserve id, so the preview pool address survives reloads. */
export function makePreviewPoolAddress(dtrId: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let h = 0;
  for (let i = 0; i < dtrId.length; i++) h = (h * 31 + dtrId.charCodeAt(i)) >>> 0;
  let x = h || 1;
  let out = "";
  for (let i = 0; i < 44; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

/** Lock precedence: none < timed < permanent; a longer timed lock beats a shorter one. Locks strengthen, never weaken. */
export function strongerLock(a: LiquidityLock, b: LiquidityLock): LiquidityLock {
  if (a.mode === "permanent" || b.mode === "permanent") return { mode: "permanent" };
  if (a.mode === "timed" && b.mode === "timed") {
    return (a.unlockTs ?? 0) >= (b.unlockTs ?? 0) ? a : b;
  }
  if (a.mode === "timed") return a;
  if (b.mode === "timed") return b;
  return { mode: "none" };
}

export function lockRemainingDays(lock: LiquidityLock, now: number = Date.now()): number | null {
  if (lock.mode !== "timed" || !lock.unlockTs) return null;
  return Math.max(0, Math.ceil((lock.unlockTs - now) / 86_400_000));
}

export function lockStatusLabel(lock: LiquidityLock, now: number = Date.now()): string {
  if (lock.mode === "permanent") return "Locked forever";
  if (lock.mode === "timed") {
    const days = lockRemainingDays(lock, now) ?? 0;
    return days > 0 ? `Locked · ${days} day${days === 1 ? "" : "s"} left` : "Lock expired";
  }
  return "Unlocked";
}
