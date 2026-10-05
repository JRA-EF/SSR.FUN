// Live wiring for tokenMetadataAfterLaunch.ts (DEC-0217): the Metaplex
// metadata-account read and the Manage page's publish executor. Separate
// file because managementClient -> solana-config uses import.meta.env, which
// the offline ts-mocha suite cannot load; the decision logic stays pure there.
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { buildReadOnlyProgram, fetchReserveTokenMetadata } from "@ssr/sdk";
import { executeSetReserveTokenMetadata } from "./managementClient";
import { ensureReserveTokenMetadataPublished, type AfterLaunchMetadataResult } from "./tokenMetadataAfterLaunch";

/**
 * The Reserve's own on-chain `metadata_uri` (the app record the token
 * metadata URI is derived from). Needed on the Resume path, whose pending
 * record predates the launch and never stored it. Null when unreadable.
 */
export async function readReserveMetadataUriOnChain(connection: Connection, reserve: string): Promise<string | null> {
  try {
    const program = buildReadOnlyProgram(connection) as unknown as { account: { reserve: { fetch(addr: PublicKey): Promise<{ metadataUri?: string }> } } };
    const acc = await program.account.reserve.fetch(new PublicKey(reserve));
    return typeof acc.metadataUri === "string" && acc.metadataUri ? acc.metadataUri : null;
  } catch {
    return null;
  }
}

/**
 * Read the mint's Metaplex metadata account; publish it (one wallet
 * approval) only if it is missing. `reserveMetadataUri` may be omitted
 * (Resume path) -- it is then read from the Reserve account only if a
 * publish turns out to be needed. Never throws.
 */
export function ensureReserveTokenMetadataPublishedOnChain(
  connection: Connection,
  wallet: WalletContextState,
  p: { reserve: string; reserveTokenMint: string; reserveMetadataUri?: string | null; name: string; ticker: string },
): Promise<AfterLaunchMetadataResult> {
  return ensureReserveTokenMetadataPublished({
    read: () => fetchReserveTokenMetadata(connection, new PublicKey(p.reserveTokenMint)),
    publish: async () => {
      const uri = p.reserveMetadataUri ?? (await readReserveMetadataUriOnChain(connection, p.reserve));
      if (!uri) throw new Error("This Reserve's metadata record could not be read from the chain.");
      return executeSetReserveTokenMetadata(connection, wallet, p.reserve, p.reserveTokenMint, uri, p.name, p.ticker);
    },
  });
}
