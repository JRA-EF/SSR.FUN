// Fetches the Robinhood Chain asset catalogue (api/robinhood/asset-catalogue,
// built by lib/robinhood/catalogue.ts) for the Launch form's Basket
// Composition step -- the counterpart of useMainnetAssetCatalogue.ts on the
// Solana side. A read failure surfaces honestly as "unavailable"; the form
// keeps USDG (the cash leg, a constant it already knows) selectable
// regardless.
//
// viem-free on purpose: the token type is re-declared here so this hook can
// sit in the main bundle without pulling the EVM stack in.
import { useEffect, useState } from "react";

export interface RobinhoodAsset {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** "robinhood" when the token's code proves it is an official Robinhood stock token; null for every other token. */
  issuer: "robinhood" | null;
  /** The Uniswap v3 pool the Launch flow buys through; null only for USDG. */
  pool: { address: `0x${string}`; fee: number; quote: "USDG" | "WETH" } | null;
  depthUsd: number | null;
  priceUsd: number | null;
}

export type RobinhoodCatalogueStatus = "loading" | "ready" | "unavailable";

let cache: { tokens: RobinhoodAsset[]; at: number } | null = null;
const STALE_MS = 5 * 60 * 1000;

export function useRobinhoodAssetCatalogue(enabled: boolean): { status: RobinhoodCatalogueStatus; tokens: RobinhoodAsset[]; refreshedAt: string | null } {
  const [state, setState] = useState<{ status: RobinhoodCatalogueStatus; tokens: RobinhoodAsset[]; refreshedAt: string | null }>(() =>
    cache && Date.now() - cache.at < STALE_MS ? { status: "ready", tokens: cache.tokens, refreshedAt: null } : { status: "loading", tokens: [], refreshedAt: null },
  );

  useEffect(() => {
    if (!enabled) return;
    if (cache && Date.now() - cache.at < STALE_MS) return;
    let cancelled = false;
    fetch("/api/robinhood/asset-catalogue")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("request failed"))))
      .then((data: { tokens: RobinhoodAsset[]; refreshedAt?: string | null }) => {
        if (cancelled) return;
        const tokens = (data.tokens ?? []).filter((t) => t && typeof t.address === "string" && typeof t.symbol === "string" && Number.isFinite(t.decimals));
        cache = { tokens, at: Date.now() };
        setState({ status: "ready", tokens, refreshedAt: data.refreshedAt ?? null });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => (prev.tokens.length > 0 ? prev : { status: "unavailable", tokens: [], refreshedAt: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
