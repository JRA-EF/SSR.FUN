// Read-only access to ssr_devnet_amm accounts -- mirrors readOnly.ts's
// pattern for ssr_protocol exactly. See DEC-0051.
import { AnchorProvider, Program } from "@anchor-lang/core";
import type * as anchor from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import idl from "../idl/ssr_devnet_amm.json";
import { findAmmPool, findAmmVault, SSR_DEVNET_AMM_PROGRAM_ID } from "./ammPda";

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error("read-only provider cannot sign transactions");
  },
  signAllTransactions: async () => {
    throw new Error("read-only provider cannot sign transactions");
  },
};

/** Untyped (no hand-rolled camelCase .ts type file exists for this IDL, matching the established `(program.methods as any)` convention already used throughout this codebase for newer instructions -- see DEC-0046/DEC-0048). */
export function buildReadOnlyAmmProgram(connection: Connection): Program<anchor.Idl> {
  const provider = new AnchorProvider(connection, READ_ONLY_WALLET as unknown as AnchorProvider["wallet"], {
    commitment: "confirmed",
  });
  return new Program(idl as anchor.Idl, provider);
}

export interface AmmPoolOnChain {
  pool: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  feeBps: number;
  reserveARaw: string;
  reserveBRaw: string;
}

/** Fetches a pool's full state, including LIVE vault balances (needed for quoting -- the constant-product formula reads real balances, never a cached number). Returns null if the pool doesn't exist. */
export async function fetchAmmPoolOnChain(
  connection: Connection,
  mintA: PublicKey,
  mintB: PublicKey,
  programId: PublicKey = SSR_DEVNET_AMM_PROGRAM_ID,
): Promise<AmmPoolOnChain | null> {
  const program = buildReadOnlyAmmProgram(connection);
  const [poolPda] = findAmmPool(mintA, mintB, programId);
  const pool = await (program.account as any).pool.fetchNullable(poolPda);
  if (!pool) return null;

  const [vaultA] = findAmmVault(poolPda, mintA, programId);
  const [vaultB] = findAmmVault(poolPda, mintB, programId);
  const vaultAInfo = await getAccount(connection, vaultA).catch(() => null);
  const vaultBInfo = await getAccount(connection, vaultB).catch(() => null);

  return {
    pool: poolPda.toBase58(),
    mintA: (pool.mintA as PublicKey).toBase58(),
    mintB: (pool.mintB as PublicKey).toBase58(),
    vaultA: vaultA.toBase58(),
    vaultB: vaultB.toBase58(),
    feeBps: pool.feeBps,
    reserveARaw: vaultAInfo ? vaultAInfo.amount.toString() : "0",
    reserveBRaw: vaultBInfo ? vaultBInfo.amount.toString() : "0",
  };
}
