// Pure helpers for the DEX volume index (DEC-0254): no network, no database.

/** LiquidityRevenue account: 8-byte discriminator, then reserve, pool, treasury (Pubkeys). */
export const LIQUIDITY_REVENUE_SIZE = 133;
export const LIQUIDITY_REVENUE_DISCRIMINATOR = Uint8Array.from([18, 153, 113, 253, 31, 161, 41, 64]);

/** Raydium CPMM PoolState offsets (packed layout, 637 bytes). */
export const POOL_STATE_SIZE = 637;
export const POOL = { vault0: 72, vault1: 104, mint0: 168, mint1: 200, protocolFee0: 341, fundFee0: 357, creatorFee0: 397 } as const;

export interface PoolSwap {
  side: "in" | "out";
  usdcRaw: bigint;
  tokenRaw: bigint;
}

/**
 * A swap moves the two vaults in opposite directions. Deposits move both up,
 * withdrawals both down, and fee collections only the USDC side, so none of
 * those count as volume.
 */
export function classifyPoolSwap(usdcBefore: bigint, usdcAfter: bigint, tokenBefore: bigint, tokenAfter: bigint): PoolSwap | null {
  const usdc = usdcAfter - usdcBefore, token = tokenAfter - tokenBefore;
  if (usdc === 0n || token === 0n || usdc > 0n === token > 0n) return null;
  return usdc > 0n ? { side: "in", usdcRaw: usdc, tokenRaw: -token } : { side: "out", usdcRaw: -usdc, tokenRaw: token };
}

/**
 * The pool's own reserves: vault balances minus fees accrued for Raydium,
 * its fund and the creator, which sit in the vaults but are not tradeable.
 */
export function poolReserves(pool: Uint8Array, vault0Amount: bigint, vault1Amount: bigint): [bigint, bigint] {
  const view = new DataView(pool.buffer, pool.byteOffset, pool.byteLength);
  const fees = (i: 0 | 1) => [POOL.protocolFee0, POOL.fundFee0, POOL.creatorFee0].reduce((s, o) => s + view.getBigUint64(o + i * 8, true), 0n);
  const net = (amount: bigint, fee: bigint) => (amount > fee ? amount - fee : 0n);
  return [net(vault0Amount, fees(0)), net(vault1Amount, fees(1))];
}

/** The parts of a transaction the index reads (from raw jsonParsed RPC, so any transaction version works). */
export interface TxVaultView {
  accountKeys: string[];
  pre: { accountIndex: number; amount: string }[];
  post: { accountIndex: number; amount: string }[];
}

/** A vault's balance before and after the transaction; null when the transaction does not touch it. */
export function vaultBalances(tx: TxVaultView, vault: string): [bigint, bigint] | null {
  const index = tx.accountKeys.indexOf(vault);
  if (index < 0) return null;
  const amount = (list: TxVaultView["pre"]) => BigInt(list.find((b) => b.accountIndex === index)?.amount ?? "0");
  return [amount(tx.pre), amount(tx.post)];
}

/** Raw getTransaction (jsonParsed) result -> TxVaultView; null for a missing or failed transaction. */
export function toVaultView(result: unknown): (TxVaultView & { blockTime: number }) | null {
  const r = result as {
    blockTime?: number | null;
    meta?: { err: unknown; preTokenBalances?: { accountIndex: number; uiTokenAmount: { amount: string } }[]; postTokenBalances?: { accountIndex: number; uiTokenAmount: { amount: string } }[] } | null;
    transaction?: { message?: { accountKeys?: ({ pubkey: string } | string)[] } };
  } | null;
  if (!r?.meta || r.meta.err || !r.blockTime || !r.transaction?.message?.accountKeys) return null;
  const tokens = (l?: { accountIndex: number; uiTokenAmount: { amount: string } }[]) => (l ?? []).map((b) => ({ accountIndex: b.accountIndex, amount: b.uiTokenAmount.amount }));
  return {
    blockTime: r.blockTime,
    accountKeys: r.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)),
    pre: tokens(r.meta.preTokenBalances),
    post: tokens(r.meta.postTokenBalances),
  };
}
