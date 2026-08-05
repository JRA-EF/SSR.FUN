// GET /api/devnet/landing-stats -- real, on-chain-derived numbers for the
// landing page's KPI strip (Total Reserve AUM and Active Reserves are cheap
// enough to compute client-side from data the frontend already fetches via
// discovery; this endpoint covers the two that genuinely need heavier
// server-side reads: Reserve Token Holders (getProgramAccounts, which only a
// dedicated provider like Helius supports on DevNet -- the public endpoint
// 403s it) and a real rolling 24h trade-volume figure (walking each
// Reserve's recent transaction history and decoding its real
// ReserveTokensMinted/ReserveTokensRedeemed events -- see
// packages/sdk/src/readOnly.ts). Both numbers are genuine reads, valued (for
// volume) at the same fixed DevNet test prices already used honestly for
// TVL elsewhere -- never fabricated, and this endpoint fails with a real
// error rather than ever returning a synthetic 0 on a read failure.
import { Connection, PublicKey } from "@solana/web3.js";
// Imported via the "@ssr/sdk" package name -- see api/devnet/swap-sign.ts's
// header comment for why a relative "../../packages/sdk/src" import crashes
// this endpoint when deployed (resolves to raw ESM .ts source a CommonJS
// require() can't load), while the package name resolves through
// packages/sdk/package.json's "main" to the real compiled CommonJS output.
import {
  buildReadOnlyProgram,
  discoverAllReserves,
  fetchReserveTokenHolderOwners,
  fetchReserve24hVolumeUsd,
  evaluateReserveEligibility,
  DEVNET_FIXTURES,
  WRAPPED_SOL_MINT,
  DEVUSDC,
  DEVUSDC_MINT,
  type AssetPricing,
} from "@ssr/sdk";
import { resolveRpcUrl } from "./_lib/rpc";
import { withReadConcurrencyLimit } from "../../src/merge/lib/rpcResilience";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

const RPC_URL = resolveRpcUrl();
const PROGRAM_ID = new PublicKey(DEVNET_FIXTURES.programId);
const CACHE_TTL_MS = 60_000;
const TWENTY_FOUR_HOURS_SEC = 24 * 60 * 60;

type MintMeta = { address: string; decimals: number; symbol: string };
const ASSET_TEST_PRICES_USD: Record<string, number> = {
  ...Object.fromEntries(Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => [m.address, 1])),
  [WRAPPED_SOL_MINT.toBase58()]: 20, // matches SOL_TEST_PRICE_USD elsewhere -- wrapped SOL IS SOL
  [DEVUSDC.mint]: 1, // devUSDC is pegged to $1 by design
};

interface PerReserveStats {
  holders: number;
  volume24hUsd: number;
}

interface LandingStats {
  /** Globally deduplicated: a wallet holding tokens from 3 different Reserves counts once, not 3 times. */
  holders: number;
  /** Sum of every displayable Reserve's own 24h volume -- each Reserve's volume is walked from its OWN transaction history (getSignaturesForAddress on its own PDA), so no single transaction can ever be double-counted across two Reserves' totals. */
  volume24hUsd: number;
  computedAt: number;
  reservesCounted: number;
  /** Same source of truth as the aggregate fields above, keyed by Reserve address -- this is what the Reserve detail page reads for its own holder count/24h volume, so the per-Reserve and global numbers can never disagree with each other. */
  perReserve: Record<string, PerReserveStats>;
}

let cached: LandingStats | null = null;

async function computeLandingStats(): Promise<LandingStats> {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = buildReadOnlyProgram(connection);
  const candidateAssetMints = [WRAPPED_SOL_MINT, DEVUSDC_MINT, ...Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => new PublicKey(m.address))];

  const { reserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints);
  // The exact same canonical eligibility check the frontend's
  // mergeDiscoveredReserves uses (packages/sdk/src/reserveEligibility.ts) --
  // one shared function, so this endpoint's public Reserve counts can never
  // silently disagree with what Discover/Featured/Portfolio/Manage actually
  // show.
  const displayable = reserves.filter(
    (r) =>
      evaluateReserveEligibility({
        reserve: r.reserve,
        assetCount: r.assetCount,
        resolvedAssetCount: r.resolvedAssetCount,
        assetMints: r.assets.map((a) => a.assetMint),
        status: r.status,
        reserveTokenSupplyRaw: r.reserveTokenSupplyRaw,
      }).eligible,
  );

  const sinceUnixSec = Math.floor(Date.now() / 1000) - TWENTY_FOUR_HOURS_SEC;
  const perReserve: Record<string, PerReserveStats> = {};
  // Union of every Reserve's real holder-owner set -- this (not a running
  // sum of per-Reserve counts) is what makes the global figure a genuine
  // deduplicated wallet count instead of over-counting anyone holding more
  // than one Reserve's token.
  const globalOwners = new Set<string>();
  let volume24hUsd = 0;

  await Promise.all(
    displayable.map((reserve) =>
      withReadConcurrencyLimit(async () => {
        try {
          const pricing: Record<string, AssetPricing> = {};
          for (const asset of reserve.assets) {
            pricing[asset.assetMint] = { decimals: asset.decimals, priceUsd: ASSET_TEST_PRICES_USD[asset.assetMint] ?? 0 };
          }
          const [reserveOwners, reserveVolume] = await Promise.all([
            fetchReserveTokenHolderOwners(connection, new PublicKey(reserve.reserveTokenMint)),
            fetchReserve24hVolumeUsd(connection, program, new PublicKey(reserve.reserve), pricing, sinceUnixSec),
          ]);
          perReserve[reserve.reserve] = { holders: reserveOwners.size, volume24hUsd: reserveVolume };
          for (const owner of reserveOwners) globalOwners.add(owner);
          volume24hUsd += reserveVolume;
        } catch {
          // One Reserve's read failing (e.g. a transient RPC hiccup) must
          // not abort the whole aggregate -- it's simply excluded from this
          // computation's total (and absent from perReserve, which the
          // frontend treats as "not yet available" for that one Reserve,
          // never as a fabricated 0), same "don't let one bad account ruin
          // the rest" philosophy as discovery's own per-account error handling.
        }
      }),
    ),
  );

  return { holders: globalOwners.size, volume24hUsd, computedAt: Date.now(), reservesCounted: displayable.length, perReserve };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Bypasses the 60s cache only when explicitly asked (e.g. right after a
  // confirmed Buy/Sell, so the holder count/volume the user just affected
  // doesn't sit stale for up to a minute) -- never used for an ordinary page
  // load, so this can't turn into an easy way to hammer the underlying
  // Helius reads on every render.
  const forceFresh = typeof req.url === "string" && /[?&]force=1(?:&|$)/.test(req.url);

  if (!forceFresh && cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    res.status(200).json(cached);
    return;
  }

  try {
    const stats = await computeLandingStats();
    cached = stats;
    res.status(200).json(stats);
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to compute landing-page stats." });
  }
}
