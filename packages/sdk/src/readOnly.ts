// Read-only access to deployed SSR Protocol accounts -- usable from the
// browser (no wallet needed for reads) and from Node scripts alike. Avoids
// getProgramAccounts entirely (confirmed blocked/403 on the public DevNet RPC,
// see docs/protocol/DEVNET_RUNBOOK.md) by always deriving PDAs directly from
// already-known inputs (reserve address + asset mint list) rather than
// scanning.
import { AnchorProvider, Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import idl from "../idl/ssr_protocol.json";
import type { SsrProtocol } from "../idl/ssr_protocol";
import { findReserveAsset, findReserveVault } from "./pda";

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error("read-only provider cannot sign transactions");
  },
  signAllTransactions: async () => {
    throw new Error("read-only provider cannot sign transactions");
  },
};

export function buildReadOnlyProgram(connection: Connection): Program<SsrProtocol> {
  const provider = new AnchorProvider(connection, READ_ONLY_WALLET as unknown as AnchorProvider["wallet"], {
    commitment: "confirmed",
  });
  return new Program(idl as SsrProtocol, provider);
}

export interface ReserveAssetOnChain {
  assetMint: string;
  reserveAsset: string;
  vault: string;
  decimals: number;
  targetWeightBps: number;
  enabled: boolean;
  orderIndex: number;
  vaultBalanceRaw: string;
}

export interface ReserveOnChain {
  reserveId: string;
  manager: string;
  reserveTokenMint: string;
  status: string;
  assetCount: number;
  totalTargetWeightBps: number;
  metadataUri: string;
  reserveTokenSupplyRaw: string;
  assets: ReserveAssetOnChain[];
}

/**
 * Fetches full Reserve state given a reserve address and the (already known)
 * list of candidate asset mints -- typically from the fixture registry
 * (packages/sdk/src/fixtures.ts) or from the mints a client itself just
 * registered while creating a Reserve. Assets not actually registered on this
 * Reserve are silently skipped (their ReserveAsset PDA simply won't exist).
 */
export async function fetchReserveOnChain(
  connection: Connection,
  programId: PublicKey,
  reserveAddress: PublicKey,
  candidateAssetMints: PublicKey[],
): Promise<ReserveOnChain | null> {
  const program = buildReadOnlyProgram(connection);
  const reserveAccount = await program.account.reserve.fetchNullable(reserveAddress);
  if (!reserveAccount) return null;

  const assets: ReserveAssetOnChain[] = [];
  for (const mint of candidateAssetMints) {
    const [reserveAssetPda] = findReserveAsset(reserveAddress, mint, programId);
    const [vaultPda] = findReserveVault(reserveAddress, mint, programId);
    const reserveAsset = await program.account.reserveAsset.fetchNullable(reserveAssetPda);
    if (!reserveAsset) continue;
    const vaultInfo = await getAccount(connection, vaultPda).catch(() => null);
    assets.push({
      assetMint: mint.toBase58(),
      reserveAsset: reserveAssetPda.toBase58(),
      vault: vaultPda.toBase58(),
      decimals: reserveAsset.decimals,
      targetWeightBps: reserveAsset.targetWeightBps,
      enabled: reserveAsset.enabled,
      orderIndex: reserveAsset.orderIndex,
      vaultBalanceRaw: vaultInfo ? vaultInfo.amount.toString() : "0",
    });
  }
  assets.sort((a, b) => a.orderIndex - b.orderIndex);

  const supply = await connection.getTokenSupply(reserveAccount.reserveTokenMint).catch(() => null);

  return {
    reserveId: reserveAccount.reserveId.toString(),
    manager: reserveAccount.manager.toBase58(),
    reserveTokenMint: reserveAccount.reserveTokenMint.toBase58(),
    status: Object.keys(reserveAccount.status as object)[0],
    assetCount: reserveAccount.assetCount,
    totalTargetWeightBps: reserveAccount.totalTargetWeightBps,
    metadataUri: reserveAccount.metadataUri,
    reserveTokenSupplyRaw: supply ? supply.value.amount : "0",
    assets,
  };
}

/** Fetches a wallet's Reserve Token balance for a given mint; returns "0" if the ATA doesn't exist yet. */
export async function fetchTokenBalanceRaw(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<string> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const info = await getAccount(connection, ata).catch(() => null);
  return info ? info.amount.toString() : "0";
}
