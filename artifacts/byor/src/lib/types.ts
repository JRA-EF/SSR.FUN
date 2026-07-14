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

export interface FeeConfig {
  /** Immutable at inception, in basis points, charged on new-issuance minting. */
  mintFeeBps: number;
  /** Annualized TVL fee, in basis points, accrued to the DTR Manager. */
  tvlFeeBps: number;
  /** Optional additional buy/sell tax set by the DTR Manager, in basis points. */
  managerTaxBps: number;
  /** Wallet address that receives the Manager's share of Mint Fee revenue. */
  creatorFeeDestination: string;
}

export interface PricePoint {
  /** Unix ms timestamp */
  t: number;
  price: number;
}

export type PriceRange = "24H" | "7D" | "30D" | "All";

export interface DTR {
  id: string;
  name: string;
  ticker: string;
  description: string;
  category: string;
  tags: string[];
  /** Deterministic seed used to render a generated logo mark */
  logoSeed: string;
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
  priceHistory: Record<PriceRange, PricePoint[]>;
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
  mintFeeBps: number;
  tvlFeeBps: number;
  managerTaxBps: number;
  creatorFeeDestination: string;
}

export type RebalanceEdits = Record<string, number>;
