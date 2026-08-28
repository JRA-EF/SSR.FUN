// Cluster targets for the Reserve Activity pipeline (/internal/kpis, the
// backfill sweep, and the nightly cron). The pipeline originally indexed
// DevNet only; the protocol has been live on Mainnet since 2026-08-19
// (DEC-0115), so "all protocol activity" now means BOTH clusters, with
// Mainnet first-class (DEC-0175).
//
// Each cluster is a self-contained target: its own RPC endpoint, program
// id, and candidate-mint strategy. Callers iterate targets and isolate
// failures per cluster -- one cluster's discovery failing (live 2026-08-28:
// the DevNet program's upgraded account layout no longer decodes with the
// SDK's deployed-Mainnet-shape IDL, "Invalid bool: 87") must never take
// down the other cluster's data or the whole KPIs page.
//
// RPC resolution deliberately mirrors api/devnet/_lib/rpc.ts and
// api/mainnet/_lib/rpc.ts (same env vars, same fallbacks) rather than
// importing them: those modules live under api/, and lib/ must not import
// api/ code (the dependency points the other way everywhere else in this
// repo). The two-line resolution logic is duplicated knowingly.
import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_FIXTURES, DEVUSDC_MINT, MAINNET_USDC_MINT, WRAPPED_SOL_MINT, enumerateReserveAssetMintsOnChain } from "@ssr/sdk";

export type ActivityCluster = "mainnet-beta" | "devnet";

/** Mainnet first: it is the live protocol and must never be starved of sweep budget by DevNet (whose discovery currently errors -- see module header). */
export const ACTIVITY_CLUSTERS: ActivityCluster[] = ["mainnet-beta", "devnet"];

export type ClusterFilter = ActivityCluster | "all";

/** Pure: validates a ?cluster= query value. Absent/empty means "all"; anything unrecognized is null (caller should 400). */
export function parseClusterFilter(value: unknown): ClusterFilter | null {
  if (value === undefined || value === null || value === "") return "all";
  if (value === "all" || value === "mainnet-beta" || value === "devnet") return value;
  return null;
}

/** Pure: the concrete cluster tags a filter selects, in sweep order. */
export function clustersForFilter(filter: ClusterFilter): ActivityCluster[] {
  return filter === "all" ? [...ACTIVITY_CLUSTERS] : [filter];
}

// The deployed Mainnet program -- same literal api/mainnet/landing-stats.ts
// pins (deployed 2026-08-19, DEC-0115; never a VITE_ env read on the server
// side, see landing-stats.ts's own comment).
export const MAINNET_PROGRAM_ID = "8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9";

export interface ClusterTarget {
  cluster: ActivityCluster;
  connection: Connection;
  programId: PublicKey;
  /** Discovery hint mints -- resolved lazily because Mainnet's list needs a live chain scan. */
  candidateMints(): Promise<PublicKey[]>;
}

export function buildClusterTargets(clusters: ActivityCluster[]): ClusterTarget[] {
  return clusters.map((cluster) => {
    if (cluster === "mainnet-beta") {
      const connection = new Connection(process.env.HELIUS_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
      return {
        cluster,
        connection,
        programId: new PublicKey(MAINNET_PROGRAM_ID),
        // Same strategy landing-stats.ts uses (DEC-0158): USDC plus every
        // mint any ReserveAsset account genuinely holds on-chain. The scan
        // failing degrades to USDC-only resolution (assetCount/status come
        // from the Reserve account itself either way), never to a throw.
        candidateMints: async () => {
          const known = await enumerateReserveAssetMintsOnChain(connection).catch(() => [] as string[]);
          return [new PublicKey(MAINNET_USDC_MINT), ...known.filter((m) => m !== MAINNET_USDC_MINT).map((m) => new PublicKey(m))];
        },
      };
    }
    const connection = new Connection(process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
    return {
      cluster,
      connection,
      programId: new PublicKey(DEVNET_FIXTURES.programId),
      // The fixed DevNet hint list every DevNet caller of discoverAllReserves
      // already uses (public DevNet RPC blocks the gPA scan -- see
      // enumerateReserveAssetMintsOnChain's doc comment).
      candidateMints: async () => [
        new PublicKey(DEVNET_FIXTURES.mints.mintX.address),
        new PublicKey(DEVNET_FIXTURES.mints.mintY.address),
        new PublicKey(DEVNET_FIXTURES.mints.mintZ.address),
        WRAPPED_SOL_MINT,
        DEVUSDC_MINT,
      ],
    };
  });
}
