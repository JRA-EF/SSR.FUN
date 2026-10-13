/**
 * Liquidity Module -- design-preview state shapes and helpers.
 *
 * This is the front-end preview of the creator liquidity feature specced in
 * docs/project/LIQUIDITY_MODULE_SPEC.md: a Reserve's root Manager seeds a
 * DEX pool for their Reserve Token (Raydium on Solana, Uniswap on Robinhood
 * Chain), optionally locks the position, and either collects their creator
 * DEX earnings into their creator treasury or compounds them back into the
 * pool (DEC-0222: locks bind principal, never earnings). "Creator DEX
 * earnings" covers both a native CPMM creator fee (DEC-0223 preferred path)
 * and the creator's share of CLMM LP-position fees (the fallback).
 *
 * Nothing in this file talks to a chain. Every surface rendering from it is
 * explicitly labelled a design preview, consistent with this repo's
 * no-fabricated-success rule (see the removed `buyDTRToken` mock trade in
 * DTRDetail.tsx): preview state is never presented as a confirmed on-chain
 * outcome. When the real integration lands it replaces the four store
 * actions in useAppStore.ts (`addLiquidityPreview`, `lockLiquidityPreview`,
 * `collectLiquidityPreviewFees`, `compoundLiquidityPreviewFees`) behind the
 * liquidity adapter of LIQUIDITY_MODULE_SPEC.md Section 12.4 (DEC-0223:
 * permissioned Raydium CPMM preferred, permissionless full-range CLMM at 0.8%
 * as the committed fallback); the components are written against this
 * module's types so the swap stays contained.
 */

export type ReserveChain = "solana" | "robinhood";

export interface DexInfo {
  chain: ReserveChain;
  /** User-facing DEX name. The ONLY source for it -- components must never hardcode "Raydium"/"Uniswap". */
  name: "Raydium" | "Uniswap";
  /**
   * User-facing pool-type wording. Solana stays architecture-neutral
   * ("liquidity pool") until the live adapter knows which DEC-0223 primitive
   * it is talking to; the adapter owns this label once live.
   */
  poolTypeLabel: "liquidity pool" | "full-range position";
  /** The non-USDC pairing option on this chain, offered only when `altPairAvailable`. */
  altPairSymbol: "SOL" | "ETH";
  /** v1 Solana is USDC-only (DEC-0223; a SOL pair is spec OPEN-2b), so the selector hides SOL. */
  altPairAvailable: boolean;
}

/**
 * Chain-aware DEX rule (LIQUIDITY_MODULE_SPEC.md, Section 5): every DEX
 * reference in the UI derives from the Reserve's home chain -- the chain its
 * Reserve Token is minted on and its vault lives on.
 */
export function dexInfoFor(chain: ReserveChain): DexInfo {
  if (chain === "robinhood") {
    return { chain, name: "Uniswap", poolTypeLabel: "full-range position", altPairSymbol: "ETH", altPairAvailable: true };
  }
  return { chain, name: "Raydium", poolTypeLabel: "liquidity pool", altPairSymbol: "SOL", altPairAvailable: false };
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
  /** Fees already collected to the creator treasury in this preview, USD lifetime total. */
  collectedTotalUsd: number;
  /** Fees compounded back into the position in this preview, USD lifetime total. */
  compoundedTotalUsd: number;
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

/** A NAV the preview can price against: finite and strictly positive. */
export function hasValidNav(navPerToken: number): boolean {
  return Number.isFinite(navPerToken) && navPerToken > 0;
}

/**
 * Compound (DEC-0222): fold `amountUsd` of accrued fees back into the
 * position as balanced liquidity at the current NAV and restart accrual.
 * Returns null -- the caller leaves state untouched -- when there is nothing
 * to compound or the NAV is not usable; it never guesses a $1 NAV.
 */
export function compoundPreviewPool(
  pool: LiquidityPoolPreview,
  amountUsd: number,
  navPerToken: number,
  now: number = Date.now(),
): LiquidityPoolPreview | null {
  if (!(amountUsd > 0) || !hasValidNav(navPerToken)) return null;
  return {
    ...pool,
    baseTokens: pool.baseTokens + amountUsd / 2 / navPerToken,
    quoteUsd: pool.quoteUsd + amountUsd / 2,
    compoundedTotalUsd: (pool.compoundedTotalUsd ?? 0) + amountUsd,
    collectedThroughTs: now,
  };
}

/**
 * Lock precedence: none < timed < permanent; a longer timed lock beats a
 * shorter one. Locks strengthen, never weaken. The preview keeps ONE lock per
 * Reserve; the live design locks per tranche (DEC-0222), with the badge rule
 * for mixed tranches still open (spec OPEN-10).
 */
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
