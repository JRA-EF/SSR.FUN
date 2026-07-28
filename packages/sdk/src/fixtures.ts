// Typed view over the canonical Gate 9 DevNet fixture registry
// (packages/sdk/fixtures/devnet-fixtures.json), generated from
// devnet-fixtures/checkpoint.json -- see docs/protocol/DEVNET_FIXTURES.md for
// the human-readable record and how these were created. Public keys only.
import registry from "../fixtures/devnet-fixtures.json";

export interface FixtureAsset {
  mint: string;
  symbol: string;
  decimals: number;
  weightBps: number;
  reserveAsset: string;
  vault: string;
}

export interface FixtureReserve {
  reserveId: string;
  reserve: string;
  reserveTokenMint: string;
  mintAuthority: string;
  vaultAuthority: string;
  assets: FixtureAsset[];
}

export interface DevnetFixtureRegistry {
  programId: string;
  manager: string;
  delegates: {
    updateTargets: { wallet: string; delegateAccount: string };
    pauseUnpause: { wallet: string; delegateAccount: string };
  };
  holders: { holderA: string; holderB: string };
  mints: Record<string, { address: string; decimals: number; symbol: string }>;
  reserveOne: FixtureReserve;
  reserveTwo: FixtureReserve;
}

export const DEVNET_FIXTURES: DevnetFixtureRegistry = registry as DevnetFixtureRegistry;
