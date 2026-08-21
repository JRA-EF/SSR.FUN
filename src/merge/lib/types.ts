// Core domain types for the SSR.FUN simulation.
// Everything here is fictional -- no real Solana or market data.

export interface DTRAsset {
  symbol: string;
  name: string;
  /** Portfolio weight as a fraction of 1 (e.g. 0.4 = 40%) */
  weight: number;
}

/** Granular powers the root DTR Manager can delegate to another wallet. */
export interface ManagerPermissions {
  manageDelegates: boolean;
  rebalance: boolean;
  feeAdmin: boolean;
  pause: boolean;
  metadata: boolean;
}

export function emptyPermissions(): ManagerPermissions {
  return { manageDelegates: false, rebalance: false, feeAdmin: false, pause: false, metadata: false };
}

export interface Delegate {
  address: string;
  permissions: ManagerPermissions;
  addedAt: number;
}

/** A secondary wallet that receives a slice of total fee revenue instead of the primary fee destination. */
export interface FeeRecipient {
  address: string;
  /** Share of total fee revenue routed to this wallet, as a percent of 100. */
  pct: number;
}

export interface FeeConfig {
  /** Immutable at inception, as a percent (0.5 = 0.5%), charged on new-issuance minting. */
  mintFeePct: number;
  /** Annualized TVL fee, as a percent, accrued to the DTR Manager. */
  tvlFeePct: number;
  /** Optional additional tax set by the DTR Manager on buys, as a percent. */
  managerBuyTaxPct: number;
  /** Optional additional tax set by the DTR Manager on sells, as a percent. */
  managerSellTaxPct: number;
  /** Wallet address that receives the Manager's share of Mint Fee revenue (and any fee revenue not routed to a recipient below). */
  creatorFeeDestination: string;
  /** Additional wallets that split off a percentage of total fee revenue. */
  feeRecipients: FeeRecipient[];
}

export interface PricePoint {
  /** Unix ms timestamp */
  t: number;
  price: number;
}

/** A real executed buy/sell, recorded for the Recent Trades panel. */
export interface Trade {
  id: string;
  /** Unix ms timestamp -- the real transaction time. */
  t: number;
  side: "buy" | "sell";
  /** Execution price this trade settled at, in USDC. */
  price: number;
  /** Net Reserve Token amount transacted. */
  tokenAmount: number;
  /** Gross USDC value of the trade. */
  usdcAmount: number;
}

/** Chart timeframe selector. The day-scale entries (24h/7d/30d/1y/All) are literal
 *  lookback windows; the sub-hour entries (1s/1m/5m/1h/4h) name a resolution and use
 *  a wider, more usable lookback -- see TIMEFRAME_LOOKBACK_MS in calculations.ts. */
export type ChartTimeframe = "1s" | "1m" | "5m" | "1h" | "4h" | "24h" | "7d" | "30d" | "1y" | "All";

export interface OrderBookLevel {
  price: number;
  tokenAmount: number;
  usdcTotal: number;
  /** Cumulative USDC size from the mid price out to (and including) this level. */
  cumulativeUsdc: number;
}

export interface SimulatedOrderBook {
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  midPrice: number;
}

/**
 * Canonical, structured Reserve category list (see CreateDTR.tsx's category
 * dropdown, Discover.tsx's filter, and DTRDetail.tsx's category badge -- all
 * three read from this single shared definition rather than each keeping
 * their own). A Reserve's persisted `category` stays a plain `string`, not
 * this literal union, because existing on-chain Reserves may carry a legacy
 * or missing category value (e.g. "DevNet Fixture", pre-dating this list) --
 * those are displayed exactly as-is, never coerced or overwritten into one
 * of these values without evidence. See normalizeReserveCategory below for
 * the one place "missing" is turned into an honest, disclosed fallback.
 */
export const RESERVE_CATEGORIES = [
  "DeFi",
  "Layer 1",
  "Layer 2",
  "AI",
  "DePIN",
  "Gaming",
  "Meme",
  "RWA",
  "Stablecoins",
  "Infrastructure",
  "Privacy",
  "Social",
  "Ecosystem",
  "Index",
  "Custom",
] as const;
export type ReserveCategory = (typeof RESERVE_CATEGORIES)[number];
export const DEFAULT_RESERVE_CATEGORY: ReserveCategory = "Custom";

/**
 * Normalizes a Reserve's category for display: an empty/missing value (a
 * legacy Reserve created before category tracking existed) shows an honest
 * "Uncategorized" label rather than a fabricated guess; any other value --
 * canonical or not -- is returned completely unchanged, since a legacy
 * non-canonical category (e.g. "DevNet Fixture") is real, evidenced data,
 * not something this function is entitled to overwrite.
 */
export function normalizeReserveCategory(category: string | null | undefined): string {
  return category && category.trim().length > 0 ? category : "Uncategorized";
}

export interface DTR {
  id: string;
  name: string;
  ticker: string;
  description: string;
  category: string;
  tags: string[];
  /** Deterministic seed used to render a generated logo mark */
  logoSeed: string;
  /** Optional imported logo image path; falls back to ticker-initial avatar when absent. */
  logoUrl?: string;
  dtrAddress: string;
  /** Root DTR Manager wallet address -- ultimate authority over this DTR. */
  managerAddress: string;
  delegates: Delegate[];
  feeConfig: FeeConfig;
  /** Current fictional secondary-market price of one DTR Token, in USDC */
  tokenPrice: number;
  /** Net asset value per DTR Token, in USDC */
  nav: number;
  /** AUM in USDC */
  aum: number;
  /** Virtual USDC depth backing the secondary-market trading curve; deeper pools resist price impact. */
  liquidityUsdc: number;
  /** 24h token price change, percent (e.g. 3.2 = +3.2%) */
  change24h: number;
  /** 7d token price change, percent */
  change7d: number;
  /** Number of fictional holders */
  holders: number;
  composition: DTRAsset[];
  /** Unallocated portion of the target basket, held as USDC Reserve, fraction of 1. */
  unallocatedPct: number;
  /** True for DTRs deployed by the connected wallet during this session. */
  isUserCreated: boolean;
  /** Flat, chronologically ordered, strictly-increasing-timestamp price series. */
  priceHistory: PricePoint[];
  /** Real executed trades this session -- starts empty for every Reserve; never backfilled with invented history. */
  trades: Trade[];
  /** Present only for a Reserve backed by a real deployed SSR Protocol account on Solana DevNet -- see src/merge/lib/onChainReserve.ts. Absent for the fully-simulated seed DTRs. */
  onChain?: OnChainReserveMeta;
  /**
   * Live-fetch status for `onChain` Reserves only (undefined for
   * fully-simulated DTRs, which have no chain fetch to track). "loading"
   * covers both "never fetched yet" and "a fetch is in flight" so the UI
   * can show an honest loading state instead of stale placeholder numbers.
   * "error" means the most recent fetch failed -- the UI must disclose
   * this, never silently keep showing old data as if it were current.
   */
  chainStatus?: "loading" | "ready" | "error";
  /** Only set when chainStatus is "error" -- a short, user-showable reason (e.g. "DevNet RPC request failed"). */
  chainError?: string;
}

/**
 * Lightweight record of a genuinely-existing on-chain Reserve that failed
 * the canonical public eligibility check (packages/sdk's
 * evaluateReserveEligibility) -- deliberately NOT a full DTR, so it can
 * never carry a fabricated price/AUM/NAV. Kept so a direct link to the
 * Reserve's address (DTRDetail) or a wallet's real token balance in it
 * (Portfolio) can be labeled honestly instead of looking like the Reserve
 * never existed.
 */
export interface QuarantinedReserveInfo {
  id: string;
  reserve: string;
  reserveId: string;
  name: string;
  ticker: string;
  reason: string;
}

export interface OnChainAssetMeta {
  mint: string;
  symbol: string;
  decimals: number;
  weightBps: number;
  reserveAsset: string;
  vault: string;
  /** Reserve.asset_count-relative registration order (ReserveAsset.order_index) -- used to determine remove_reserve_asset eligibility (only the last-registered asset can be removed). -1 if not yet resolved from a live fetch. */
  orderIndex: number;
}

/** A delegate verified live on-chain (see packages/sdk/src/discovery.ts's discoverDelegatesForReserve) -- distinct from the fully-local `Delegate` type above, which backs the simulated/non-onchain sandbox only. `permissions` is the raw on-chain bitmask (see permission_flags in programs/ssr_protocol/src/state/delegate.rs), not the local ManagerPermissions shape. */
export interface OnChainDelegateMeta {
  wallet: string;
  delegateAccount: string;
  permissions: number;
  restricted: boolean;
  addedAt: number;
}

/** Real, live-fetched on-chain state for a Reserve backed by the deployed SSR Protocol program. */
export interface OnChainReserveMeta {
  programId: string;
  reserveId: string;
  reserve: string;
  reserveTokenMint: string;
  mintAuthority: string;
  vaultAuthority: string;
  manager: string;
  assets: OnChainAssetMeta[];
  /** "active" | "paused" | "created" | "assetsInitializing" | "windDown" | "closed" -- mirrors programs/ssr_protocol's ReserveStatus. */
  status: string;
  totalTargetWeightBps: number;
  reserveTokenSupplyRaw: string;
  vaultBalancesRaw: Record<string, string>;
  /** Verified on-chain count of registered assets (Reserve.assetCount) -- may exceed assets.length if the discovery pass's candidate-mint hints couldn't resolve every one; see assetsResolvedFully. */
  assetCount?: number;
  /** False when assets.length < assetCount -- i.e. this Reserve holds at least one asset this discovery pass could not resolve. Never hide this; surface it honestly in the UI. */
  assetsResolvedFully?: boolean;
  /** Verified on-chain count of granted delegates (Reserve.delegateCount). */
  delegateCountOnChain?: number;
  /** Delegates actually resolved on-chain via candidate-wallet discovery -- may be a subset of delegateCountOnChain; see docs/protocol/FRONTEND_INTEGRATION.md "Canonical discovery" for the limitation. */
  delegatesOnChain?: OnChainDelegateMeta[];
  /** Redemption fee in bps, read live from Reserve.feeConfig.redemptionFeeBps -- used for honest in-kind Sell estimates (see computeRedemptionEntitlements). */
  redemptionFeeBps?: number;
  /** The Manager's configured fee-payout wallet, read live from Reserve.feeConfig.feeDestination -- required (not derivable) for a real collect_fees call. */
  feeDestination?: string;
  /** Manager's share of every collected fee, in bps of the fee itself -- read live from Reserve.feeConfig.managerFeeShareBps. Sums with protocolFeeShareBps to exactly 10000. */
  managerFeeShareBps?: number;
  /** Protocol's share of every collected fee, in bps of the fee itself -- read live from Reserve.feeConfig.protocolFeeShareBps. */
  protocolFeeShareBps?: number;
  /** Pending Manager-share Reserve Token units accrued but not yet paid out -- read live from Reserve.feeConfig.pendingManagerFeeShares. Raw base units (RESERVE_TOKEN_DECIMALS), not human-formatted. */
  pendingManagerFeeShares?: string;
  /** Pending protocol-share Reserve Token units accrued but not yet paid out -- read live from Reserve.feeConfig.pendingProtocolFeeShares. Raw base units. */
  pendingProtocolFeeShares?: string;
  /** Configured (manager-set) gross Mint fee, in bps, read live from Reserve.feeConfig.mintFeeBps. */
  mintFeeBps?: number;
  /** Configured (manager-set) gross Annualized TVL fee, in bps, read live from Reserve.feeConfig.annualTvlFeeBps. */
  tvlFeeBps?: number;
  /**
   * DEC-0094: effective Protocol/Manager split for the Mint fee and the
   * Annualized TVL fee, computed fresh client-side via the same SSR.fun fee
   * formula the on-chain program applies at every mint/accrual (see
   * packages/sdk/src/feeMath.ts) -- always live/authoritative, unlike
   * managerFeeShareBps/protocolFeeShareBps above (now just informational
   * "last effective mint-fee split applied" telemetry).
   */
  effectiveMintFeeProtocolBps?: number;
  effectiveMintFeeManagerBps?: number;
  effectiveMintFeeTotalBps?: number;
  effectiveTvlFeeProtocolBps?: number;
  effectiveTvlFeeManagerBps?: number;
  effectiveTvlFeeTotalBps?: number;
  /**
   * Where AUM/tokenPrice's USD valuation came from this pass -- "pyth" |
   * "jupiter" when every materially-held asset (nonzero vault balance)
   * priced from that one source, "mixed" when different assets priced from
   * different sources, "none" when the Reserve genuinely holds nothing yet
   * (not a pricing failure), "unavailable" when at least one materially-held
   * asset could not be priced at all this pass -- see
   * onChainReserve.ts's computeAumFromPrices, the one place this is decided.
   * Undefined only for a DevNet Reserve (which still uses the fixed
   * TEST_ASSET_PRICES_USD test table, never this pipeline).
   */
  priceSource?: "pyth" | "jupiter" | "mixed" | "none" | "unavailable";
  /** Unix ms of the least-recent contributing price quote, or null when priceSource is "none"/"unavailable". Never a fabricated "just now". */
  priceAsOf?: number | null;
  /** Mints of every materially-held (nonzero vault balance) asset that could not be priced this pass -- empty unless priceSource === "unavailable". */
  unpricedAssetMints?: string[];
}

export type WalletProviderId = "phantom" | "solflare" | "backpack";

export interface WalletState {
  connected: boolean;
  connecting: boolean;
  provider: WalletProviderId | null;
  address: string | null;
  usdc: number;
  ssr: number;
  sol: number;
}

export interface Holding {
  dtrId: string;
  /** Total DTR Tokens held */
  tokenBalance: number;
  /** Volume-weighted average purchase price, in USDC */
  avgPurchasePrice: number;
}

export interface TradeQuote {
  grossAmount: number;
  fee: number;
  netAmount: number;
  /** Token price after this trade settles against the DTR's liquidity pool. */
  newPrice: number;
  /** Signed percent move in tokenPrice this trade causes (e.g. 2.4 = +2.4%). */
  priceImpactPct: number;
}

export interface CreateDTRAssetInput {
  symbol: string;
  name: string;
  /** Target weight as a fraction of 1 */
  weight: number;
}

export interface CreateDTRInput {
  name: string;
  ticker: string;
  description: string;
  category: string;
  tags: string[];
  composition: CreateDTRAssetInput[];
  /** Initial USDC used to seed the reserve; also determines starting AUM. */
  initialSeedUsdc: number;
  mintFeePct: number;
  tvlFeePct: number;
  managerBuyTaxPct: number;
  managerSellTaxPct: number;
  creatorFeeDestination: string;
  /** Additional wallets that split off a percentage of total fee revenue. */
  feeRecipients: FeeRecipient[];
  /** Wallet addresses to add as delegate managers on the newly-deployed DTR. */
  additionalManagers: string[];
}

/** Social handles/links a user can attach to their profile. All optional and freeform. */
export interface ProfileSocials {
  twitter?: string;
  discord?: string;
  telegram?: string;
  website?: string;
}

/** A lightweight user profile keyed by wallet address -- no real identity/auth, purely simulation flavor. */
export interface UserProfile {
  address: string;
  displayName: string;
  bio: string;
  avatarUrl?: string;
  socials: ProfileSocials;
  createdAt: number;
  updatedAt: number;
}

export type RebalanceEdits = Record<string, number>;
