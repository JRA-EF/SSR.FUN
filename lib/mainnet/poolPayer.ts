// DEC-0240: server co-signing by SSR's Raydium-approved pool payer.
//
// Raydium only lets the whitelisted payer 6smL...oqAS create SSR's
// permissioned CPMM pools, and the payer is the transaction's fee payer, so
// a public pool launch needs its signature. The server signs ONLY a
// transaction it compiled and simulated itself in the same request, and only
// after the simulation shows the payer ends with no net SOL loss: the
// creator refunds the payer's pool rent and fees inside the same
// transaction, so nobody can drain the payer by launching pools.
import { Keypair, SystemProgram, VersionedTransaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { SSR_POOL_PAYER } from "../../src/merge/lib/liquidity/raydiumCpmm";

/** Extra lamports on top of the measured cost, covering priority-fee drift between simulations. */
export const POOL_PAYER_REFUND_MARGIN_LAMPORTS = 20_000n;

export class PoolPayerUnavailable extends Error {}

export function loadPoolPayer(env: NodeJS.ProcessEnv = process.env): Keypair {
  const raw = env.SSR_RAYDIUM_POOL_PAYER_SECRET;
  if (!raw) throw new PoolPayerUnavailable("Pool launches are temporarily unavailable: SSR's pool payer is not configured on this deployment. Nothing was submitted.");
  const parsed: number[] = raw.trim().startsWith("[") ? JSON.parse(raw) : Array.from(Buffer.from(raw, "base64"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(parsed));
  if (!payer.publicKey.equals(SSR_POOL_PAYER)) throw new PoolPayerUnavailable("Pool launches are temporarily unavailable: the configured pool payer is not Raydium's approved SSR payer. Nothing was submitted.");
  return payer;
}

/** The creator's refund of the payer's measured SOL cost, placed first in the pool-creation transaction. */
export function poolPayerRefund(creator: PublicKey, payerCostLamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: creator, toPubkey: SSR_POOL_PAYER, lamports: payerCostLamports + POOL_PAYER_REFUND_MARGIN_LAMPORTS });
}

/**
 * Adds the payer's signature to a prepared pool-creation transaction. Refuses
 * unless the payer is the fee payer and the simulation measured no net SOL
 * cost for it (`payerCostLamports` <= 0 after the refund).
 */
export function coSignPoolPayer(transactionBase64: string, payer: Keypair, payerCostLamports: bigint): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  if (!tx.message.staticAccountKeys[0]?.equals(payer.publicKey)) throw new Error("Internal error: the pool payer is not this transaction's fee payer. Nothing was submitted.");
  if (payerCostLamports > 0n) throw new Error("Internal error: the pool launch would cost SSR's pool payer SOL. Nothing was submitted.");
  tx.sign([payer]);
  return Buffer.from(tx.serialize()).toString("base64");
}
