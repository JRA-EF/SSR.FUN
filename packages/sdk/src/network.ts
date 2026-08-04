// Shared, cross-boundary copy of api/devnet/_lib/network.ts's genesis-hash
// DevNet guard -- duplicated here (rather than imported) because
// api/devnet/_lib is a CJS-scoped directory tied to Vercel's serverless
// routing conventions and excluded from tsconfig.node.json, while this
// module needs to be importable from both browser code (src/merge/lib) and
// Node scripts alike. See DEC-0051's "DevNet-only enforcement" security
// invariant: every ssr_devnet_amm client entry point must call this before
// building any transaction against that program. Keep in sync with the
// original if DEVNET_GENESIS_HASH ever needs to change (it won't -- it's a
// fixed property of the DevNet genesis block).
import type { Connection } from "@solana/web3.js";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export class NotDevnetError extends Error {
  constructor(actualGenesisHash: string) {
    super(
      `Refusing to proceed: connected cluster's genesis hash (${actualGenesisHash}) does not match known Solana DevNet genesis (${DEVNET_GENESIS_HASH}). This action only ever operates on DevNet.`,
    );
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
