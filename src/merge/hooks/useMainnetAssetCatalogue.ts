// Mainnet-only hook: fetches the Jupiter Tokens API V2 verified-token
// catalogue (see api/ledger/asset-catalogue.ts, lib/ledger/jupiterCatalogue.ts)
// for CreateDTR.tsx's Reserve Asset selector. A read failure surfaces
// honestly as "unavailable" -- CreateDTR.tsx still keeps its own hardcoded
// USDC entry selectable regardless of this hook's status, since USDC is a
// local constant this app already knows, never dependent on this fetch.
import { useEffect, useState } from "react";
import type { LaunchpadId, LaunchpadStage, LaunchpadVenue } from "@ssr/sdk";

/** Where the token was launched and whether it has graduated -- a label only; every token here already passed the catalogue's eligibility gates. */
export interface CatalogueAssetLaunchpad {
  id: LaunchpadId;
  stage: LaunchpadStage;
  venue: LaunchpadVenue | null;
}

export interface CatalogueAsset {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  real: true;
  launchpad?: CatalogueAssetLaunchpad | null;
}

export type CatalogueStatus = "loading" | "ready" | "unavailable";

interface RawToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  launchpad?: CatalogueAssetLaunchpad | null;
}

export function useMainnetAssetCatalogue(enabled: boolean): { status: CatalogueStatus; tokens: CatalogueAsset[] } {
  const [state, setState] = useState<{ status: CatalogueStatus; tokens: CatalogueAsset[] }>({ status: "loading", tokens: [] });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/ledger/asset-catalogue")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("request failed"))))
      .then((data: { tokens: RawToken[] }) => {
        if (cancelled) return;
        const tokens: CatalogueAsset[] = (data.tokens ?? []).map((t) => ({ symbol: t.symbol, name: t.name, mint: t.mint, decimals: t.decimals, real: true as const, launchpad: t.launchpad ?? null }));
        setState({ status: "ready", tokens });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => (prev.tokens.length > 0 ? prev : { status: "unavailable", tokens: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
