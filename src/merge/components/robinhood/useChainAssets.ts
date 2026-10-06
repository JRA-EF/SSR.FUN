// The Launch form's asset list for WHICHEVER chain it is composing on.
//
// Robinhood has a discovery catalogue (api/robinhood/asset-catalogue). A chain
// onboarded without one -- BNB, Base -- carries a verified starter list in its
// ChainConfig instead (scripts/evm-chain-assets.mts). Both come back in the
// same RobinhoodAsset shape so the form does not care which it got.
//
// Lives in the EVM chunk (it prices through viem); the Robinhood catalogue
// hook stays viem-free in the main bundle, untouched.
import { useEffect, useState } from "react";
import type { PublicClient } from "viem";
import type { ChainConfig } from "@/lib/evmChain";
import { usdPrice } from "@/lib/evmReserve";
import { useRobinhoodAssetCatalogue, type RobinhoodAsset, type RobinhoodCatalogueStatus } from "@/hooks/useRobinhoodAssetCatalogue";

type State = { status: RobinhoodCatalogueStatus; tokens: RobinhoodAsset[]; refreshedAt: string | null };

/**
 * The route vocabulary is still the catalogue's ("USDG" = the dollar leg,
 * "WETH" = the native leg); evmSwap.routeFor translates it back to roles.
 * Mapping here keeps the form and the Robinhood catalogue unchanged.
 */
const ROLE_TO_LABEL = { usd: "USDG", native: "WETH" } as const;

export function useChainAssets(cfg: ChainConfig, pc: PublicClient): State {
  const starter = cfg.starterAssets;
  const robinhood = useRobinhoodAssetCatalogue(!starter);
  const [state, setState] = useState<State>({ status: "loading", tokens: [], refreshedAt: null });

  useEffect(() => {
    if (!starter) return;
    let cancelled = false;
    const base: RobinhoodAsset[] = starter.map((a) => ({
      address: a.address,
      symbol: a.symbol,
      name: a.symbol,
      decimals: a.decimals,
      issuer: null,
      pool: { address: a.pool.address, fee: a.pool.fee, quote: ROLE_TO_LABEL[a.pool.quote] },
      depthUsd: null,
      priceUsd: null,
    }));
    // Usable immediately; prices fill in as each live read lands.
    setState({ status: "ready", tokens: base, refreshedAt: null });
    Promise.all(base.map((t) => usdPrice(pc, cfg, t.address, t.decimals).catch(() => null))).then((prices) => {
      if (cancelled) return;
      setState({ status: "ready", tokens: base.map((t, i) => ({ ...t, priceUsd: prices[i] })), refreshedAt: new Date().toISOString() });
    });
    return () => {
      cancelled = true;
    };
  }, [starter, cfg, pc]);

  return starter ? state : robinhood;
}
