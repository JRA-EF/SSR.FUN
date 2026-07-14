// Core domain types for the BYOR simulation.
// Everything here is fictional -- no real Solana or market data.

export interface DTRAsset {
  symbol: string;
  name: string;
  /** Portfolio weight as a fraction of 1 (e.g. 0.4 = 40%) */
  weight: number;
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
  /** Deterministic seed used to render a generated logo mark */
  logoSeed: string;
  dtrAddress: string;
  managerAddress: string;
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
