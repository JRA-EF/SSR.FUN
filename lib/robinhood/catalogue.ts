// The Robinhood Chain asset catalogue job: discovers every Uniswap v3 pool
// paired with USDG or WETH from the factory's PoolCreated logs, refreshes
// each pool's depth and price, and classifies every counterparty token with
// lib/robinhood/catalogueRules.ts. Runs daily behind
// api/robinhood/catalogue-refresh-cron.ts; the first full walk of the chain
// is scripts/robinhood-catalogue-backfill.mts, run once by hand (the public
// RPC caps eth_getLogs at 10,000 matches and 10M blocks per call, and the
// chain carries tens of thousands of pools, so the backfill is minutes of
// adaptive-window scanning, not a request).
//
// Why a table and not a generated constant: the previous list
// (src/merge/lib/robinhoodAssets.generated.ts) was 281 tokens found by name
// and frozen into the bundle. Launchpads on this chain graduate new tokens
// every day, and the name test let copycats through (see catalogueRules.ts).
// Serving from Postgres means the picker is as fresh as the last run and the
// bundle carries nothing.
//
// Every write here is idempotent (upserts keyed by address); a run that dies
// halfway leaves the previous state intact and the next run repeats it.
import { createPublicClient, defineChain, formatUnits, getAddress, http, keccak256, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
  QUOTES,
  UNISWAP_V3_FACTORY,
  classifyToken,
  dropSymbolImpersonators,
  isRobinhoodNamed,
  selectBestPool,
  sortForPicker,
  spotFromSqrtPrice,
  type PoolFacts,
  type QuoteSymbol,
  type RobinhoodCatalogueToken,
} from "./catalogueRules";

export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export const ROBINHOOD_CHAIN = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** A read client for the job. The public RPC rejects default runtime user agents, so one is set explicitly. */
export function robinhoodClient(rpcUrl: string = PUBLIC_RPC_URL): PublicClient {
  return createPublicClient({
    chain: ROBINHOOD_CHAIN,
    // Six retries with exponential backoff from one second: the public RPC
    // answers bursts with 429 and recovers within a few seconds.
    transport: http(rpcUrl, { timeout: 60_000, retryCount: 6, retryDelay: 1_000, fetchOptions: { headers: { "user-agent": "Mozilla/5.0 (ssr.fun catalogue)" } } }),
  }) as PublicClient;
}

type Sql = NeonQueryFunction<false, false>;

const POOL_CREATED = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
const POOL_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

/** The RPC's hard ceiling on one eth_getLogs span; the job starts below it and halves on "too many matches". */
const MAX_LOG_SPAN = 5_000_000n;
const MIN_LOG_SPAN = 2_000n;
/** Pools per Multicall3 round trip (x3 calls each). */
const POOL_CHUNK = 120;
const TOKEN_CHUNK = 150;

export interface DiscoveredPool {
  pool: Address;
  token: Address;
  quote: QuoteSymbol;
  fee: number;
  createdBlock: bigint;
}

/**
 * The RPC's two "window too big" answers. NOT "Too Many Requests": that is
 * rate limiting (429), handled by waiting -- the first backfill mistook it
 * for this, halved the window twelve times and was throttled harder.
 */
function isRangeTooBig(e: unknown): boolean {
  const m = ((e as { details?: string })?.details ?? (e as Error)?.message ?? "").toLowerCase();
  if (/too many requests|rate limit/.test(m)) return false;
  // "log query timed out" is the node giving up on a heavy window -- also a narrow-and-retry.
  return /logs matched by query exceeds limit|narrow the block range|query returned more than|response size exceeded|block range is too large|query timed out|timed out/.test(m);
}

function isRateLimited(e: unknown): boolean {
  const code = (e as { code?: number; status?: number })?.code ?? (e as { status?: number })?.status;
  const m = ((e as { details?: string })?.details ?? (e as Error)?.message ?? "").toLowerCase();
  return code === 429 || /too many requests|rate limit/.test(m);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** On-chain strings as Postgres text: no NUL bytes (rejected by the encoder), trimmed, bounded. Launchpad tokens carry anything. */
function cleanText(s: string | null | undefined, max = 96): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? "").replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}
/** Pause between consecutive log scans -- the public RPC throttles bursts. */
const LOG_SCAN_PACE_MS = 250;

/** eth_getLogs over [from, to], halving the span whenever the RPC refuses it and waiting out rate limits. */
async function adaptiveGetLogs(pc: PublicClient, quote: Address, slot: "token0" | "token1", from: bigint, to: bigint, log?: (s: string) => void) {
  const out: Awaited<ReturnType<typeof pc.getLogs<typeof POOL_CREATED>>> = [];
  let span = MAX_LOG_SPAN;
  let cursor = from;
  let throttled = 0;
  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n;
    try {
      const logs = await pc.getLogs({ address: UNISWAP_V3_FACTORY, event: POOL_CREATED, args: { [slot]: quote } as never, fromBlock: cursor, toBlock: end });
      out.push(...logs);
      cursor = end + 1n;
      throttled = 0;
      // Grow back gently after a successful narrow window.
      if (span < MAX_LOG_SPAN) span = span * 2n > MAX_LOG_SPAN ? MAX_LOG_SPAN : span * 2n;
      await sleep(LOG_SCAN_PACE_MS);
    } catch (e) {
      if (isRateLimited(e)) {
        throttled += 1;
        if (throttled > 8) throw e;
        const wait = 2_000 * throttled;
        log?.(`  rate-limited at ${cursor}; waiting ${wait} ms`);
        await sleep(wait);
        continue;
      }
      if (!isRangeTooBig(e) || span <= MIN_LOG_SPAN) throw e;
      span = span / 2n;
      log?.(`  getLogs ${slot}=${quote.slice(0, 8)} narrowed to ${span} blocks at ${cursor}`);
    }
  }
  return out;
}

/**
 * Every v3 pool created in [from, to] that pairs a token with USDG or WETH.
 * A pool between the two quote assets themselves is recorded once, as
 * WETH quoted in USDG (that is the pool the job prices ETH from).
 */
export async function discoverPools(pc: PublicClient, from: bigint, to: bigint, log?: (s: string) => void): Promise<DiscoveredPool[]> {
  const found = new Map<string, DiscoveredPool>();
  for (const quote of [QUOTES.USDG, QUOTES.WETH]) {
    for (const slot of ["token0", "token1"] as const) {
      const logs = await adaptiveGetLogs(pc, quote.address, slot, from, to, log);
      for (const l of logs) {
        const other = slot === "token0" ? l.args.token1 : l.args.token0;
        const pool = l.args.pool;
        const fee = l.args.fee;
        if (!other || !pool || fee === undefined) continue;
        const token = getAddress(other);
        // USDG is only ever a quote; the USDG/WETH pool is recorded under WETH.
        if (token.toLowerCase() === QUOTES.USDG.address.toLowerCase()) continue;
        if (quote.symbol === "WETH" && token.toLowerCase() === QUOTES.WETH.address.toLowerCase()) continue;
        found.set(getAddress(pool), { pool: getAddress(pool), token, quote: quote.symbol, fee: Number(fee), createdBlock: l.blockNumber ?? 0n });
      }
    }
    log?.(`  ${quote.symbol}: ${found.size} pools so far`);
  }
  return [...found.values()];
}

export interface PoolRow {
  pool: Address;
  token: Address;
  quote: QuoteSymbol;
  fee: number;
}

/** liquidity, slot0 and the quote balance of each pool, via Multicall3. */
export async function refreshPools(pc: PublicClient, pools: PoolRow[]): Promise<PoolFacts[]> {
  const out: PoolFacts[] = [];
  for (let i = 0; i < pools.length; i += POOL_CHUNK) {
    const slice = pools.slice(i, i + POOL_CHUNK);
    if (i > 0) await sleep(LOG_SCAN_PACE_MS);
    const res = await pc.multicall({
      allowFailure: true,
      contracts: slice.flatMap((p) => [
        { address: p.pool, abi: POOL_ABI, functionName: "liquidity" } as const,
        { address: p.pool, abi: POOL_ABI, functionName: "slot0" } as const,
        { address: QUOTES[p.quote].address, abi: ERC20_ABI, functionName: "balanceOf", args: [p.pool] } as const,
      ]),
    });
    slice.forEach((p, k) => {
      const liq = res[k * 3];
      const slot = res[k * 3 + 1];
      const bal = res[k * 3 + 2];
      const liquidity = liq.status === "success" ? (liq.result as bigint) : 0n;
      const sqrt = slot.status === "success" ? ((slot.result as readonly unknown[])[0] as bigint) : null;
      const quoteBalance = bal.status === "success" ? Number(formatUnits(bal.result as bigint, QUOTES[p.quote].decimals)) : 0;
      out.push({ pool: p.pool, token: p.token, quote: p.quote, fee: p.fee, liquidity, sqrtPriceX96: sqrt, quoteBalance });
    });
  }
  return out;
}

export interface TokenMeta {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export async function readTokenMeta(pc: PublicClient, tokens: Address[]): Promise<TokenMeta[]> {
  const out: TokenMeta[] = [];
  for (let i = 0; i < tokens.length; i += TOKEN_CHUNK) {
    const slice = tokens.slice(i, i + TOKEN_CHUNK);
    if (i > 0) await sleep(LOG_SCAN_PACE_MS);
    const res = await pc.multicall({
      allowFailure: true,
      contracts: slice.flatMap((a) => [
        { address: a, abi: ERC20_ABI, functionName: "name" } as const,
        { address: a, abi: ERC20_ABI, functionName: "symbol" } as const,
        { address: a, abi: ERC20_ABI, functionName: "decimals" } as const,
      ]),
    });
    slice.forEach((a, k) => {
      const name = res[k * 3].status === "success" ? cleanText(String(res[k * 3].result)) : null;
      const symbol = res[k * 3 + 1].status === "success" ? cleanText(String(res[k * 3 + 1].result), 32) : null;
      const dec = res[k * 3 + 2].status === "success" ? Number(res[k * 3 + 2].result) : null;
      out.push({ address: a, name, symbol, decimals: dec !== null && Number.isFinite(dec) ? dec : null });
    });
  }
  return out;
}

/** keccak256 of each token's runtime code -- the proof of an official Robinhood stock token. A few at a time; the public RPC rate-limits bursts. */
export async function readCodeHashes(pc: PublicClient, tokens: Address[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CONCURRENCY = 4;
  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const slice = tokens.slice(i, i + CONCURRENCY);
    if (i > 0) await sleep(LOG_SCAN_PACE_MS);
    const codes = await Promise.all(slice.map((a) => pc.getBytecode({ address: a }).catch(() => undefined)));
    slice.forEach((a, k) => {
      const code = codes[k];
      if (code && code !== "0x") out.set(a.toLowerCase(), keccak256(code));
    });
  }
  return out;
}

// ------------------------------------------------------------------ the run

export interface RefreshOptions {
  sql: Sql;
  rpcUrl?: string;
  /** Cap on the block span scanned for new pools in one run (the daily cron scans a day; the backfill loops). */
  maxBlocksPerRun?: bigint;
  /** How many pools of currently-ineligible tokens are re-read this run (oldest-read first; every pool comes round within days). */
  rotatingPoolLimit?: number;
  log?: (s: string) => void;
}

export interface RefreshSummary {
  scannedFrom: string;
  scannedTo: string;
  head: string;
  poolsDiscovered: number;
  poolsRefreshed: number;
  tokensUpserted: number;
  eligibleTokens: number;
  wethUsd: number | null;
  caughtUp: boolean;
}

interface StoredPool extends PoolRow {
  liquidity: string | null;
  updatedAt: string | null;
}

interface StoredToken {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  codeHash: string | null;
  eligible: boolean;
}

export async function runRobinhoodCatalogueRefresh(opts: RefreshOptions): Promise<RefreshSummary> {
  const { sql } = opts;
  const log = opts.log ?? (() => {});
  const pc = robinhoodClient(opts.rpcUrl);
  const head = (await pc.getBlockNumber()) - 5n;

  const stateRows = (await sql`select last_scanned_block::text as "lastScannedBlock" from robinhood_catalogue_state where id = 1`) as { lastScannedBlock: string }[];
  const from = stateRows[0] ? BigInt(stateRows[0].lastScannedBlock) + 1n : 0n;
  const cap = opts.maxBlocksPerRun ?? 100_000_000n;
  const to = from + cap - 1n < head ? from + cap - 1n : head;

  // 1. New pools.
  let discovered: DiscoveredPool[] = [];
  if (from <= to) {
    log(`scanning PoolCreated ${from} -> ${to}`);
    discovered = await discoverPools(pc, from, to, log);
    if (discovered.length > 0) {
      await sql.query(
        `insert into robinhood_catalogue_pools (pool, token, quote, fee, created_block)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::bigint[])
         on conflict (pool) do nothing`,
        [discovered.map((p) => p.pool), discovered.map((p) => p.token), discovered.map((p) => p.quote), discovered.map((p) => p.fee), discovered.map((p) => p.createdBlock.toString())],
      );
    }
    log(`  ${discovered.length} new pools`);
  }

  // 2. Which pools to re-read. The chain carries hundreds of thousands of
  //    pools (launchpads create one per token), so a run reads: every pool
  //    never read before, every pool of a token that is currently eligible
  //    (its depth and price must stay current), every WETH/USDG pool (the
  //    ETH mark), and a rotating slice of everything else, oldest-read first,
  //    so a token whose pool fills up later is noticed within days.
  const stored = (await sql`
    select pool, token, quote, fee, liquidity::text as liquidity, updated_at::text as "updatedAt"
    from robinhood_catalogue_pools
  `) as StoredPool[];
  // Known facts (name/symbol/decimals/code hash) so they are read once.
  const known = (await sql`select address, name, symbol, decimals, code_hash as "codeHash", eligible from robinhood_asset_catalogue`) as StoredToken[];
  const knownByAddr = new Map(known.map((t) => [t.address.toLowerCase(), t]));
  const eligibleNow = new Set(known.filter((t) => t.eligible).map((t) => t.address.toLowerCase()));
  const wethLower = QUOTES.WETH.address.toLowerCase();
  const isKnown = (p: StoredPool) => knownByAddr.has(p.token.toLowerCase());
  // "Unread" also covers a pool whose token never reached the catalogue (a run that died between the pool and token writes).
  const unread = stored.filter((p) => p.updatedAt === null || !isKnown(p));
  const current = stored.filter((p) => p.updatedAt !== null && isKnown(p) && (eligibleNow.has(p.token.toLowerCase()) || p.token.toLowerCase() === wethLower));
  const rotating = stored
    .filter((p) => p.updatedAt !== null && isKnown(p) && !eligibleNow.has(p.token.toLowerCase()) && p.token.toLowerCase() !== wethLower)
    .sort((a, b) => Date.parse(a.updatedAt ?? "") - Date.parse(b.updatedAt ?? ""))
    .slice(0, opts.rotatingPoolLimit ?? 3000);
  const toRefresh: PoolRow[] = [...unread, ...current, ...rotating].map((p) => ({ pool: getAddress(p.pool), token: getAddress(p.token), quote: p.quote, fee: p.fee }));
  log(`refreshing ${toRefresh.length} pools (${unread.length} new, ${current.length} of eligible tokens, ${rotating.length} rotating)`);
  const facts = await refreshPools(pc, toRefresh);
  for (let i = 0; i < facts.length; i += 500) {
    const slice = facts.slice(i, i + 500);
    await sql.query(
      `update robinhood_catalogue_pools p set liquidity = v.liquidity::numeric, quote_balance = v.quote_balance::numeric, sqrt_price_x96 = v.sqrt, updated_at = now()
       from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as v(pool, liquidity, quote_balance, sqrt)
       where p.pool = v.pool`,
      [slice.map((f) => f.pool), slice.map((f) => f.liquidity.toString()), slice.map((f) => f.quoteBalance.toString()), slice.map((f) => (f.sqrtPriceX96 === null ? null : f.sqrtPriceX96.toString()))],
    );
  }

  // 3. ETH in USD, from the deepest live WETH/USDG pool.
  const wethPools = facts.filter((f) => f.token.toLowerCase() === QUOTES.WETH.address.toLowerCase() && f.quote === "USDG");
  const bestWeth = selectBestPool(wethPools, null);
  const wethUsd = bestWeth && bestWeth.pool.sqrtPriceX96 !== null ? spotFromSqrtPrice(bestWeth.pool.sqrtPriceX96, QUOTES.WETH.address, 18, QUOTES.USDG) : null;
  log(`WETH/USD ${wethUsd === null ? "unavailable" : wethUsd.toFixed(2)}`);

  // 4. Per token: best pool, depth, price.
  const byToken = new Map<string, PoolFacts[]>();
  for (const f of facts) {
    const k = f.token.toLowerCase();
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k)!.push(f);
  }
  const tokenAddresses = [...new Set([...byToken.keys(), QUOTES.USDG.address.toLowerCase()])].map((a) => getAddress(a));

  const fresh = tokenAddresses.filter((a) => !knownByAddr.has(a.toLowerCase()));
  log(`${tokenAddresses.length} tokens touched, ${fresh.length} new`);
  const metas = fresh.length ? await readTokenMeta(pc, fresh) : [];
  const metaByAddr = new Map(metas.map((m) => [m.address.toLowerCase(), m]));

  // Code hashes: every Robinhood-named token without one yet (new or stored).
  const needCode = tokenAddresses.filter((a) => {
    const k = a.toLowerCase();
    const name = metaByAddr.get(k)?.name ?? knownByAddr.get(k)?.name ?? "";
    const has = knownByAddr.get(k)?.codeHash;
    return !has && isRobinhoodNamed(name);
  });
  log(`reading code for ${needCode.length} Robinhood-named tokens`);
  const codeHashes = needCode.length ? await readCodeHashes(pc, needCode) : new Map<string, string>();

  const rows: {
    address: Address;
    name: string;
    symbol: string;
    displayName: string;
    decimals: number | null;
    codeHash: string | null;
    issuer: string | null;
    poolAddress: string | null;
    poolFee: number | null;
    poolQuote: string | null;
    depthUsd: number | null;
    priceUsd: number | null;
    eligible: boolean;
    reason: string | null;
  }[] = [];
  for (const addr of tokenAddresses) {
    const k = addr.toLowerCase();
    const meta = metaByAddr.get(k);
    const prior = knownByAddr.get(k);
    const name = cleanText(meta?.name ?? prior?.name ?? "");
    const symbol = cleanText(meta?.symbol ?? prior?.symbol ?? "", 32);
    const decimals = meta?.decimals ?? prior?.decimals ?? null;
    const codeHash = codeHashes.get(k) ?? prior?.codeHash ?? null;
    const isUsdg = k === QUOTES.USDG.address.toLowerCase();
    const best = isUsdg ? null : selectBestPool(byToken.get(k) ?? [], wethUsd);
    let priceUsd: number | null = isUsdg ? 1 : null;
    if (best && best.pool.sqrtPriceX96 !== null && decimals !== null) {
      const inQuote = spotFromSqrtPrice(best.pool.sqrtPriceX96, addr, decimals, QUOTES[best.pool.quote]);
      if (inQuote !== null) priceUsd = best.pool.quote === "USDG" ? inQuote : wethUsd === null ? null : inQuote * wethUsd;
    }
    if (decimals === null || !symbol) {
      rows.push({ address: addr, name, symbol: symbol || "?", displayName: name || symbol || addr, decimals, codeHash, issuer: null, poolAddress: best?.pool.pool ?? null, poolFee: best?.pool.fee ?? null, poolQuote: best?.pool.quote ?? null, depthUsd: best?.depthUsd ?? null, priceUsd: null, eligible: false, reason: "not a readable ERC-20 (name/symbol/decimals)" });
      continue;
    }
    const c = classifyToken({ address: addr, name, symbol, decimals, codeHash, depthUsd: isUsdg ? Number.POSITIVE_INFINITY : best?.depthUsd ?? null });
    // A token without any live pool cannot be bought or priced, whatever it is -- except USDG itself.
    const eligible = c.eligible && (isUsdg || best !== null);
    rows.push({
      address: addr,
      name,
      symbol,
      displayName: c.displayName,
      decimals,
      codeHash,
      issuer: c.issuer,
      poolAddress: best?.pool.pool ?? null,
      poolFee: best?.pool.fee ?? null,
      poolQuote: best?.pool.quote ?? null,
      depthUsd: isUsdg ? null : best?.depthUsd ?? null,
      priceUsd,
      eligible,
      reason: eligible ? null : c.ineligibleReason ?? "no pool with in-range liquidity",
    });
  }
  for (let i = 0; i < rows.length; i += 400) {
    const slice = rows.slice(i, i + 400);
    await sql.query(
      `insert into robinhood_asset_catalogue
         (address, name, symbol, display_name, decimals, code_hash, issuer, pool_address, pool_fee, pool_quote, depth_usd, price_usd, eligible, ineligible_reason, updated_at)
       select * , now() from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::int[], $10::text[], $11::numeric[], $12::numeric[], $13::boolean[], $14::text[])
       on conflict (address) do update set
         name = excluded.name, symbol = excluded.symbol, display_name = excluded.display_name, decimals = excluded.decimals,
         code_hash = coalesce(excluded.code_hash, robinhood_asset_catalogue.code_hash), issuer = excluded.issuer,
         pool_address = excluded.pool_address, pool_fee = excluded.pool_fee, pool_quote = excluded.pool_quote,
         depth_usd = excluded.depth_usd, price_usd = excluded.price_usd, eligible = excluded.eligible,
         ineligible_reason = excluded.ineligible_reason, updated_at = now()`,
      [
        slice.map((r) => r.address),
        slice.map((r) => r.name),
        slice.map((r) => r.symbol),
        slice.map((r) => r.displayName),
        slice.map((r) => r.decimals),
        slice.map((r) => r.codeHash),
        slice.map((r) => r.issuer),
        slice.map((r) => r.poolAddress),
        slice.map((r) => r.poolFee),
        slice.map((r) => r.poolQuote),
        slice.map((r) => (r.depthUsd === null || !Number.isFinite(r.depthUsd) ? null : r.depthUsd.toFixed(2))),
        slice.map((r) => (r.priceUsd === null || !Number.isFinite(r.priceUsd) ? null : r.priceUsd.toPrecision(12))),
        slice.map((r) => r.eligible),
        slice.map((r) => r.reason),
      ],
    );
  }

  // 5. Checkpoint.
  await sql`
    insert into robinhood_catalogue_state (id, last_scanned_block, weth_usd, updated_at)
    values (1, ${to.toString()}::bigint, ${wethUsd}, now())
    on conflict (id) do update set last_scanned_block = greatest(robinhood_catalogue_state.last_scanned_block, excluded.last_scanned_block), weth_usd = excluded.weth_usd, updated_at = now()
  `;

  const eligibleTokens = rows.filter((r) => r.eligible).length;
  log(`done: ${rows.length} tokens written, ${eligibleTokens} eligible this pass`);
  return {
    scannedFrom: from.toString(),
    scannedTo: to.toString(),
    head: head.toString(),
    poolsDiscovered: discovered.length,
    poolsRefreshed: facts.length,
    tokensUpserted: rows.length,
    eligibleTokens,
    wethUsd,
    caughtUp: to >= head,
  };
}

// ---------------------------------------------------------------- serving

interface ServedRow {
  address: string;
  symbol: string;
  displayName: string;
  decimals: number;
  issuer: string | null;
  poolAddress: string | null;
  poolFee: number | null;
  poolQuote: string | null;
  depthUsd: string | null;
  priceUsd: string | null;
}

/** Every eligible token, in picker order. USDG has no pool of its own (it IS the cash leg) and is served with pool: null. */
export async function loadRobinhoodCatalogue(sql: Sql): Promise<{ tokens: RobinhoodCatalogueToken[]; updatedAt: string | null }> {
  const rows = (await sql`
    select address, symbol, display_name as "displayName", decimals, issuer, pool_address as "poolAddress", pool_fee as "poolFee", pool_quote as "poolQuote",
      depth_usd::text as "depthUsd", price_usd::text as "priceUsd"
    from robinhood_asset_catalogue
    where eligible = true and decimals is not null
  `) as ServedRow[];
  const state = (await sql`select updated_at::text as "updatedAt" from robinhood_catalogue_state where id = 1`) as { updatedAt: string }[];
  const tokens: RobinhoodCatalogueToken[] = rows.map((r) => ({
    address: getAddress(r.address),
    symbol: r.symbol,
    name: r.displayName,
    decimals: r.decimals,
    issuer: r.issuer === "robinhood" ? "robinhood" : null,
    pool: r.poolAddress && r.poolFee !== null && (r.poolQuote === "USDG" || r.poolQuote === "WETH") ? { address: getAddress(r.poolAddress), fee: r.poolFee, quote: r.poolQuote } : null,
    depthUsd: r.depthUsd === null ? null : Number(r.depthUsd),
    priceUsd: r.priceUsd === null ? null : Number(r.priceUsd),
  }));
  return { tokens: sortForPicker(dropSymbolImpersonators(tokens)), updatedAt: state[0]?.updatedAt ?? null };
}
