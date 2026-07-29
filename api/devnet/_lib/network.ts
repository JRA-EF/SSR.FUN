// Shared, runtime-agnostic Solana-DevNet cluster verification for every
// DevNet-only server-side endpoint (faucet, sponsorship, swap adapter). See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model", "Mainnet guard" row.
//
// A string check on SOLANA_RPC_URL/VITE_SOLANA_CLUSTER could be silently
// misconfigured (a typo'd env var, a copy-pasted Mainnet URL). The genesis
// hash is a property of the actual chain being talked to and can't be
// spoofed by an environment-variable mistake -- this is checked live, on
// every request, not just assumed once at startup.
import type { Connection } from "@solana/web3.js";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export class NotDevnetError extends Error {
  constructor(actualGenesisHash: string) {
    super(`Refusing to proceed: connected cluster's genesis hash (${actualGenesisHash}) does not match known Solana DevNet genesis (${DEVNET_GENESIS_HASH}). This endpoint only ever operates on DevNet.`);
    this.name = "NotDevnetError";
  }
}

/** Throws NotDevnetError (or the underlying RPC error) unless the connection is genuinely talking to Solana DevNet right now. Fails closed: any failure to confirm is treated as "not DevNet." */
export async function assertDevnetCluster(connection: Connection): Promise<void> {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new NotDevnetError(genesisHash);
  }
}
