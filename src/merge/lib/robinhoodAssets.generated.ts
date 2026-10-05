// The two quote assets of Robinhood Chain, as the Launch form's constant
// fallback. Everything else a Reserve can hold there comes from the live
// catalogue (api/robinhood/asset-catalogue, lib/robinhood/catalogue.ts),
// which discovers tokens from Uniswap v3 pools and proves a Robinhood stock
// token by its code -- the hand-generated 281-token list this file used to
// carry (scripts/generate-robinhood-assets.mts, by name suffix) let copycats
// through and is gone.
import type { AssetRef } from "./evmChain";

export const ROBINHOOD_ASSETS: AssetRef[] = [
  { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, note: "Global Dollar — the cash leg" },
  { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18, note: "Wrapped Ether" },
];
