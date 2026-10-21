// Read side of the DEX volume index (DEC-0254). Volume comes from Postgres
// only; pool balances for the market-cap split come from ONE batched account
// read over the pools the daily sweep registered (no program scan here).
import { Connection, PublicKey } from "@solana/web3.js";
import { getSql } from "../ledger/db";
import { poolReserves } from "./classify";

/** All-time USD volume of swaps in SSR pools (USDC leg, exact). */
export async function fetchDexVolumeUsd(cluster = "mainnet-beta"): Promise<number> {
  const [row] = (await getSql()`select coalesce(sum(usdc_raw), 0)::float8 / 1e6 as usd from dex_pool_swaps where cluster = ${cluster}`) as { usd: number }[];
  return row?.usd ?? 0;
}

/** The same figure per Reserve; a Reserve without swaps is absent (0, not unknown). */
export async function fetchDexVolumeUsdByReserve(cluster = "mainnet-beta"): Promise<Record<string, number>> {
  const rows = (await getSql()`
    select reserve, coalesce(sum(usdc_raw), 0)::float8 / 1e6 as usd from dex_pool_swaps where cluster = ${cluster} group by reserve
  `) as { reserve: string; usd: number }[];
  return Object.fromEntries(rows.map((r) => [r.reserve, r.usd]));
}

export interface PoolBalances {
  pool: string;
  /** Reserve Tokens in the pool's own reserves (accrued fees excluded), raw. */
  pooledTokensRaw: string;
  /** USDC in the pool's own reserves (accrued fees excluded), raw. */
  poolUsdcRaw: string;
}

/** Current reserves of every registered SSR pool, keyed by Reserve address. */
export async function readPoolBalances(connection: Connection, cluster = "mainnet-beta"): Promise<Record<string, PoolBalances>> {
  const pools = (await getSql()`select pool, reserve, usdc_vault, token_vault, usdc_is_0 from dex_pools where cluster = ${cluster}`) as {
    pool: string; reserve: string; usdc_vault: string; token_vault: string; usdc_is_0: boolean;
  }[];
  if (!pools.length) return {};
  const keys = pools.flatMap((p) => [p.pool, p.usdc_vault, p.token_vault].map((k) => new PublicKey(k)));
  const infos: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> = [];
  for (let i = 0; i < keys.length; i += 99) infos.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")));
  // SPL token account: amount is the u64 at offset 64 (same for Token-2022).
  const amount = (data: Buffer | undefined) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n);
  const out: Record<string, PoolBalances> = {};
  pools.forEach((p, i) => {
    const [state, usdcVault, tokenVault] = infos.slice(i * 3, i * 3 + 3);
    if (!state || !usdcVault || !tokenVault) return;
    const usdc = amount(usdcVault.data), tokens = amount(tokenVault.data);
    const [r0, r1] = poolReserves(state.data, p.usdc_is_0 ? usdc : tokens, p.usdc_is_0 ? tokens : usdc);
    out[p.reserve] = { pool: p.pool, poolUsdcRaw: (p.usdc_is_0 ? r0 : r1).toString(), pooledTokensRaw: (p.usdc_is_0 ? r1 : r0).toString() };
  });
  return out;
}
