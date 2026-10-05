// Post-launch safety net for a Reserve Token's on-chain (Metaplex) name and
// symbol (DEC-0226) -- the PURE half (decision + copy), offline-testable. The
// live wiring (account read + publish transaction) is in
// tokenMetadataAfterLaunchOnChain.ts, kept separate because that file pulls
// in solana-config's import.meta.env, which ts-mocha cannot load.
//
// Why this exists. The Launch flow bundles create_token_metadata into the
// create-and-register batch (createReserveClient.ts). Two real ways a Reserve
// still ended up without it: a build whose TOKEN_METADATA_LIVE flag was off
// (the env var was only ever set on the Production environment -- three
// Mainnet Reserves were launched that way), and a Resume that re-ran the
// registration batches without the metadata instruction. Either way the
// wallet shows "Unknown" where the ticker should be. So, right after a launch
// completes, read the metadata account once; if it is missing, publish it
// with one more wallet approval -- the same instruction the Manage page's
// "Publish to wallets and exchanges" button sends. Best-effort: the Reserve is
// already fully deployed, and a declined or failed publish loses nothing
// (Manage offers it again).
import type { OnChainTokenMetadata } from "@ssr/sdk";

export type AfterLaunchMetadataOutcome =
  /** The metadata account already exists (the normal case: the launch batch carried it). */
  | "already-published"
  /** It was missing and this call published it. */
  | "published"
  /** It was missing and the publish failed or was declined, or the read itself failed; `error` says why. */
  | "failed";

export interface AfterLaunchMetadataResult {
  outcome: AfterLaunchMetadataOutcome;
  error?: string;
}

/**
 * Orchestration over two injected effects: `read` returns the current
 * metadata account (null when absent), `publish` sends the create
 * instruction. `publish` is only ever called when `read` returned null.
 */
export async function ensureReserveTokenMetadataPublished(deps: {
  read: () => Promise<OnChainTokenMetadata | null>;
  publish: () => Promise<unknown>;
}): Promise<AfterLaunchMetadataResult> {
  let existing: OnChainTokenMetadata | null;
  try {
    existing = await deps.read();
  } catch (e) {
    // The read itself failing (RPC hiccup) must not trigger a publish that
    // could be redundant -- report it and let Manage show the real state.
    return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  if (existing) return { outcome: "already-published" };
  try {
    await deps.publish();
    return { outcome: "published" };
  } catch (e) {
    return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The sentence the launch success message adds for a non-routine outcome;
 * null when the metadata was already there (nothing worth saying).
 */
export function describeAfterLaunchMetadataOutcome(result: AfterLaunchMetadataResult, ticker: string): string | null {
  const t = ticker.trim() || "your Reserve Token";
  switch (result.outcome) {
    case "already-published":
      return null;
    case "published":
      return `${t} is now named in wallets and exchanges.`;
    case "failed":
      return `Wallets will show ${t} without its name until you publish it: open Manage Reserve and use "Publish to wallets and exchanges" (one approval).`;
  }
}
