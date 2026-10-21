// DEX volume index (DEC-0254): finds every SSR-created Raydium CPMM pool and
// records each swap's USDC leg. Run once a day from api/kpis/dex-volume-cron.ts,
// never from a page request: one program-account scan plus a signature walk
// per pool is too much for the shared Helius cap on a hot path.
import { Connection, PublicKey } from "@solana/web3.js";
import { getSql } from "../ledger/db";
import { classifyPoolSwap, LIQUIDITY_REVENUE_DISCRIMINATOR, LIQUIDITY_REVENUE_SIZE, POOL, POOL_STATE_SIZE, toVaultView, vaultBalances, type TxVaultView } from "./classify";

export const SSR_PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
export const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SIGNATURE_PAGE = 1000;
const TX_BATCH = 25;

export interface DexPool {
  pool: string;
  reserve: string;
  reserveMint: string;
  usdcVault: string;
  tokenVault: string;
  usdcIs0: boolean;
  newestSignature: string | null;
}

/** Every pool SSR registered (LiquidityRevenue accounts), with its vaults read from the pool itself. */
export async function discoverSsrPools(connection: Connection): Promise<Omit<DexPool, "newestSignature">[]> {
  const registrations = await connection.getProgramAccounts(SSR_PROGRAM_ID, { commitment: "confirmed", filters: [{ dataSize: LIQUIDITY_REVENUE_SIZE }] });
  const entries = registrations
    .filter((r) => LIQUIDITY_REVENUE_DISCRIMINATOR.every((b: number, i: number) => r.account.data[i] === b))
    .map((r) => ({ reserve: new PublicKey(r.account.data.subarray(8, 40)), pool: new PublicKey(r.account.data.subarray(40, 72)) }));
  if (!entries.length) return [];
  const pools = await connection.getMultipleAccountsInfo(entries.map((e) => e.pool), "confirmed");
  const out: Omit<DexPool, "newestSignature">[] = [];
  entries.forEach((e, i) => {
    const info = pools[i];
    // A registration whose pool was never created (or is not a Raydium pool) has nothing to index.
    if (!info || !info.owner.equals(RAYDIUM_CPMM) || info.data.length < POOL_STATE_SIZE) return;
    const key = (o: number) => new PublicKey(info.data.subarray(o, o + 32));
    const mint0 = key(POOL.mint0), mint1 = key(POOL.mint1), usdcIs0 = mint0.equals(USDC_MINT);
    if (!usdcIs0 && !mint1.equals(USDC_MINT)) return;
    out.push({
      pool: e.pool.toBase58(),
      reserve: e.reserve.toBase58(),
      reserveMint: (usdcIs0 ? mint1 : mint0).toBase58(),
      usdcVault: key(usdcIs0 ? POOL.vault0 : POOL.vault1).toBase58(),
      tokenVault: key(usdcIs0 ? POOL.vault1 : POOL.vault0).toBase58(),
      usdcIs0,
    });
  });
  return out;
}

/**
 * Fetches transactions with raw JSON-RPC (one batched request). web3.js's own
 * parser rejects version-1 transactions, which Mainnet now carries, and one of
 * those fails a whole getParsedTransactions batch.
 */
export async function fetchVaultViews(endpoint: string, signatures: string[]): Promise<Map<string, TxVaultView & { blockTime: number }>> {
  const body = signatures.map((signature, id) => ({ jsonrpc: "2.0", id, method: "getTransaction", params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }));
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`getTransaction batch failed: HTTP ${response.status}`);
  const replies = (await response.json()) as { id: number; result?: unknown; error?: { message: string } }[];
  const out = new Map<string, TxVaultView & { blockTime: number }>();
  for (const reply of replies) {
    if (reply.error) throw new Error(`getTransaction failed: ${reply.error.message}`);
    const view = toVaultView(reply.result);
    if (view) out.set(signatures[reply.id], view);
  }
  return out;
}

export interface PoolSyncResult {
  pool: string;
  scanned: number;
  swaps: number;
  complete: boolean;
}

/**
 * Walks the pool's USDC vault history from newest back to the last indexed
 * signature and stores each swap. The cursor only moves once the walk reaches
 * it, so a run cut short by the time budget is simply redone (inserts are
 * idempotent on pool + signature).
 */
export async function syncPoolSwaps(connection: Connection, pool: DexPool, deadline: number, cluster = "mainnet-beta"): Promise<PoolSyncResult> {
  const sql = getSql();
  const vault = new PublicKey(pool.usdcVault);
  let before: string | undefined, newest: string | null = null, scanned = 0, swaps = 0;
  for (;;) {
    if (Date.now() > deadline) return { pool: pool.pool, scanned, swaps, complete: false };
    const page = await connection.getSignaturesForAddress(vault, { before, until: pool.newestSignature ?? undefined, limit: SIGNATURE_PAGE }, "confirmed");
    if (!page.length) break;
    newest ??= page[0].signature;
    const ok = page.filter((s) => !s.err).map((s) => s.signature);
    for (let i = 0; i < ok.length; i += TX_BATCH) {
      if (Date.now() > deadline) return { pool: pool.pool, scanned, swaps, complete: false };
      const views = await fetchVaultViews(connection.rpcEndpoint, ok.slice(i, i + TX_BATCH));
      for (const [signature, tx] of views) {
        scanned++;
        const usdc = vaultBalances(tx, pool.usdcVault), token = vaultBalances(tx, pool.tokenVault);
        const swap = usdc && token ? classifyPoolSwap(usdc[0], usdc[1], token[0], token[1]) : null;
        if (!swap) continue;
        await sql`
          insert into dex_pool_swaps (pool, signature, cluster, reserve, ts, side, usdc_raw, token_raw)
          values (${pool.pool}, ${signature}, ${cluster}, ${pool.reserve}, ${tx.blockTime}, ${swap.side}, ${swap.usdcRaw.toString()}, ${swap.tokenRaw.toString()})
          on conflict (pool, signature) do nothing
        `;
        swaps++;
      }
    }
    if (page.length < SIGNATURE_PAGE) break;
    before = page[page.length - 1].signature;
  }
  if (newest) await sql`update dex_pools set newest_signature = ${newest}, updated_at = now() where pool = ${pool.pool}`;
  return { pool: pool.pool, scanned, swaps, complete: true };
}

/** Discover pools, refresh the registry, then index each pool until the time budget runs out. */
export async function sweepDexVolume(connection: Connection, budgetMs: number, cluster = "mainnet-beta") {
  const deadline = Date.now() + budgetMs, sql = getSql();
  const discovered = await discoverSsrPools(connection);
  for (const p of discovered) {
    await sql`
      insert into dex_pools (pool, cluster, reserve, reserve_mint, usdc_vault, token_vault, usdc_is_0)
      values (${p.pool}, ${cluster}, ${p.reserve}, ${p.reserveMint}, ${p.usdcVault}, ${p.tokenVault}, ${p.usdcIs0})
      on conflict (pool) do update set reserve = excluded.reserve, reserve_mint = excluded.reserve_mint,
        usdc_vault = excluded.usdc_vault, token_vault = excluded.token_vault, usdc_is_0 = excluded.usdc_is_0, updated_at = now()
    `;
  }
  const pools = (await sql`
    select pool, reserve, reserve_mint, usdc_vault, token_vault, usdc_is_0, newest_signature
    from dex_pools where cluster = ${cluster} order by updated_at asc
  `) as { pool: string; reserve: string; reserve_mint: string; usdc_vault: string; token_vault: string; usdc_is_0: boolean; newest_signature: string | null }[];
  const results: PoolSyncResult[] = [];
  for (const r of pools) {
    if (Date.now() > deadline) break;
    results.push(await syncPoolSwaps(connection, { pool: r.pool, reserve: r.reserve, reserveMint: r.reserve_mint, usdcVault: r.usdc_vault, tokenVault: r.token_vault, usdcIs0: r.usdc_is_0, newestSignature: r.newest_signature }, deadline, cluster));
  }
  return { poolsDiscovered: discovered.length, results };
}
