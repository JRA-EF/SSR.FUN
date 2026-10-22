// DEC-0251: the basket feed keeper (fee-settlement-cron job D).
//
// DEC-0255: a pool with a backing/pool split first adds the pool's part as
// locked liquidity (lib/mainnet/poolFeed.ts), then feeds the rest as below.
//
// For every pool created with liquidity terms v2 whose creator chose to share
// earnings with holders (LiquidityTerms.holder_share_bps > 0):
//   1. Collect + distribute: when the pool has accrued creator fees (or the
//      router already holds some), collect them and run
//      distribute_liquidity_revenue_v2 -- SSR 20%, the holder share to the
//      basket feed, the rest to the creator treasury. Permissionless and
//      destination-fixed on-chain; the keeper only pays fees.
//   2. Feed: whatever the program has released (linear over 24h) is split
//      across the Reserve's assets by TARGET weight, and each leg is ONE
//      atomic transaction [basket_feed_begin -> Jupiter route (none for a
//      USDC asset) -> rebalance_swap_end]. begin lends the released USDC to
//      the keeper, end deposits what the route delivered into the vault and
//      refuses below min_out (Jupiter's own slippage bound). A leg that does
//      not fit one transaction, has no route or exceeds the price-impact
//      ceiling is skipped; its USDC stays released for the next run.
// Nothing is minted, so every Reserve Token's backing grows.
import { PublicKey, type AddressLookupTableAccount, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import {
  assetAta,
  buildBasketFeedBegin,
  buildRebalanceSwapEndInstruction,
  decodeLiquidityTerms,
  findBasketFeed,
  findLiquidityRevenue,
  findLiquidityTerms,
  findProtocolConfig,
  findRebalanceTicket,
  findReserveAsset,
  findReserveVault,
  findSettlementKeeperConfig,
  releasedBasketFeed,
  decodeLiquiditySplit,
  findLiquiditySplit,
  poolFeedRoom,
} from "@ssr/sdk";
import { decodePool, prepareRevenueCollect, LIQUIDITY_USDC } from "../../src/merge/lib/liquidity/raydiumCpmm";
import { canonicalLiquidityPool, readLiquidityState } from "./liquidityLifecycle";
import { initialReserveAtNav } from "./createLiquidity";
import { POOL_LEG_MAX_SHARE_BPS, POOL_NAV_LIMIT_PCT, buildPoolFeedInstructions, planPoolLeg, poolNavDeviationPct } from "./poolFeed";
import { DEFAULT_SLIPPAGE_BPS, buildJupiterSwapInstructionsWithRetry, fetchJupiterQuoteWithRetry, isPriceImpactAcceptable } from "./jupiter";

/** LiquidityTerms account size (programs/ssr_protocol/src/instructions/liquidity_terms.rs). */
export const LIQUIDITY_TERMS_SIZE = 115;
/** Collect only when at least this much creator fee (raw USDC) is waiting -- below it the fees cost more than they move. */
export const COLLECT_MIN_USDC_RAW = 1_000_000n;
/** Feed only when at least this much (raw USDC) is released, and skip legs smaller than LEG_MIN. */
export const FEED_MIN_USDC_RAW = 500_000n;
export const LEG_MIN_USDC_RAW = 100_000n;

export interface FeedAsset { mint: string; targetWeightBps: number; tokenProgram: string }

/**
 * Splits `released` raw USDC across the assets by target weight. Rounds each
 * leg down, gives the remainder to the heaviest asset, and drops legs under
 * `legMin` (their USDC simply stays released). Never returns more than `released`.
 */
export function planBasketFeedLegs(released: bigint, assets: FeedAsset[], legMin = LEG_MIN_USDC_RAW): { mint: string; amount: bigint }[] {
  const weighted = assets.filter((a) => a.targetWeightBps > 0);
  const total = weighted.reduce((s, a) => s + BigInt(a.targetWeightBps), 0n);
  if (released <= 0n || total === 0n) return [];
  const legs = weighted.map((a) => ({ mint: a.mint, amount: (released * BigInt(a.targetWeightBps)) / total }));
  const rest = released - legs.reduce((s, l) => s + l.amount, 0n);
  const heaviest = weighted.reduce((best, a, i) => (a.targetWeightBps > weighted[best].targetWeightBps ? i : best), 0);
  legs[heaviest].amount += rest;
  return legs.filter((l) => l.amount >= legMin);
}

export interface BasketFeedLegResult { mint: string; usdcIn: string; status: "fed" | "skipped-price-impact" | "skipped-no-route" | "skipped-too-large" | "skipped-error"; minOut?: string; signature?: string; detail?: string }
/** DEC-0255: the pool leg of a pool whose creator sends part of the holder share into the pool. */
export interface PoolFeedLegResult {
  status: "added" | "skipped-off-nav" | "skipped-no-price" | "skipped-too-small" | "skipped-too-large" | "skipped-error";
  poolShareBps: number; usdcIn: string; lp?: string; navUsdc?: number; poolPriceUsdc?: number; deviationPct?: number; signature?: string; detail?: string;
}
export interface BasketFeedResult { reserve: string; holderShareBps: number; collectSignature?: string; releasedUsdcRaw: string; pool?: PoolFeedLegResult; legs: BasketFeedLegResult[]; error?: string }

export interface BasketFeedDeps {
  connection: Connection;
  keeper: Keypair;
  program: any;
  programId: PublicKey;
  protocolTreasury: PublicKey;
  apiKey: string;
  deadline: number;
  send: (label: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[]) => Promise<string>;
  budget: (units: number) => TransactionInstruction[];
  fits: (ixs: TransactionInstruction[], tables: AddressLookupTableAccount[]) => boolean;
  reserveTables: (reserve: PublicKey) => Promise<AddressLookupTableAccount[]>;
  jupiterTables: (addresses: string[]) => Promise<AddressLookupTableAccount[]>;
  jupiterInstructions: (built: any) => TransactionInstruction[];
  /** USD prices for NAV (api/mainnet/asset-prices.ts fetchJupiterPrices). Without it the pool leg waits; it never guesses NAV. */
  prices?: (mints: string[]) => Promise<Map<string, { usdPrice?: number | null; decimals?: number | null; blockId?: number | null }>>;
}

/** Every v2 pool whose creator shares with holders. */
export async function findSharingPools(connection: Connection, programId: PublicKey) {
  const rows = await connection.getProgramAccounts(programId, { commitment: "confirmed", filters: [{ dataSize: LIQUIDITY_TERMS_SIZE }] });
  return rows
    .map((row) => { try { return { address: row.pubkey, terms: decodeLiquidityTerms(row.account.data) }; } catch { return null; } })
    .filter((x): x is NonNullable<typeof x> => !!x && x.terms.holderShareBps > 0);
}

async function readFeedAssets(deps: BasketFeedDeps, reserve: PublicKey): Promise<FeedAsset[]> {
  const rows = await deps.connection.getProgramAccounts(deps.programId, { commitment: "confirmed", filters: [{ dataSize: 111 }, { memcmp: { offset: 8, bytes: reserve.toBase58() } }] });
  const decoded = rows.map((r) => deps.program.coder.accounts.decode("reserveAsset", r.account.data)).filter((a: any) => a.enabled);
  const mints = decoded.map((a: any) => new PublicKey(a.assetMint));
  const infos = mints.length ? await deps.connection.getMultipleAccountsInfo(mints, "confirmed") : [];
  return decoded.map((a: any, i: number) => ({ mint: mints[i].toBase58(), targetWeightBps: Number(a.targetWeightBps), tokenProgram: (infos[i]?.owner ?? TOKEN_PROGRAM_ID).toBase58() }));
}

export async function runBasketFeedForPool(deps: BasketFeedDeps, terms: ReturnType<typeof decodeLiquidityTerms>): Promise<BasketFeedResult> {
  const { connection, keeper, programId } = deps;
  const reserve = terms.reserve;
  const result: BasketFeedResult = { reserve: reserve.toBase58(), holderShareBps: terms.holderShareBps, releasedUsdcRaw: "0", legs: [] };
  const reserveInfo = await connection.getAccountInfo(reserve, "confirmed");
  if (!reserveInfo?.owner.equals(programId)) throw new Error("Reserve unavailable");
  const r = deps.program.coder.accounts.decode("reserve", reserveInfo.data);
  const mint = new PublicKey(r.reserveTokenMint);
  const pool = canonicalLiquidityPool(mint);
  const revenue = findLiquidityRevenue(reserve, programId);
  const revenueInfo = await connection.getAccountInfo(revenue, "confirmed");
  if (!revenueInfo?.owner.equals(programId)) throw new Error("Pool revenue registration unavailable");
  const router = deps.program.coder.accounts.decode("liquidityRevenue", revenueInfo.data);
  const creatorTreasury = new PublicKey(router.treasury);

  // 1. Collect + distribute when enough creator fee is waiting.
  const [poolInfo, stagedInfo] = await connection.getMultipleAccountsInfo([pool, getAssociatedTokenAddressSync(LIQUIDITY_USDC, revenue, true)], "confirmed");
  const accrued = decodePool(poolInfo, mint, revenue).accruedUsdc;
  const staged = stagedInfo ? unpackAccount(revenue, stagedInfo).amount : 0n;
  if (accrued + staged >= COLLECT_MIN_USDC_RAW) {
    const c = await prepareRevenueCollect({ connection, programId, reserve, reserveMint: mint, pool, payer: keeper.publicKey, protocolConfig: findProtocolConfig(programId)[0], protocolTreasury: deps.protocolTreasury, creatorTreasury, termsV2: true });
    result.collectSignature = await deps.send(`collect+distribute ${result.reserve.slice(0, 6)}`, [...deps.budget(400_000), ...c.instructions], await deps.reserveTables(reserve));
  }

  // 2. Feed what has been released so far.
  const feed = findBasketFeed(reserve, programId);
  const [termsInfo, feedInfo] = await connection.getMultipleAccountsInfo([findLiquidityTerms(reserve, programId), feed], "confirmed");
  if (!termsInfo?.owner.equals(programId) || !feedInfo) throw new Error("Basket feed accounts unavailable");
  const fresh = decodeLiquidityTerms(termsInfo.data);
  if (!fresh.revenue.equals(revenue) || !fresh.reserve.equals(reserve)) throw new Error("Liquidity terms registration changed");
  const slot = await connection.getSlot("confirmed");
  const now = BigInt((await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000));
  let released = releasedBasketFeed(fresh, now, unpackAccount(feed, feedInfo).amount).unlocked;
  result.releasedUsdcRaw = released.toString();
  if (released < FEED_MIN_USDC_RAW) return result;

  // 2a. DEC-0255: the pool's part, when the creator chose a split. Off NAV it
  // goes to backing this run; on any other failure it stays released for the next run.
  const splitInfo = await connection.getAccountInfo(findLiquiditySplit(reserve, programId), "confirmed");
  if (splitInfo?.owner.equals(programId)) {
    const split = decodeLiquiditySplit(splitInfo.data);
    const room = poolFeedRoom(split, fresh.totalFed + released);
    const leg: PoolFeedLegResult = { status: "skipped-too-small", poolShareBps: split.poolShareBps, usdcIn: "0" };
    result.pool = leg;
    let held = 0n;
    if (room >= LEG_MIN_USDC_RAW) {
      held = room < released ? room : released;
      try {
        const s = await readLiquidityState(deps, reserve);
        if (!s.registered) throw new Error("Pool unavailable");
        const cap = s.usdc * POOL_LEG_MAX_SHARE_BPS / 10_000n;
        const amount = held < cap ? held : cap;
        leg.usdcIn = amount.toString();
        if (!deps.prices) { leg.status = "skipped-no-price"; leg.detail = "No price source for NAV."; }
        else {
          const nav = (await initialReserveAtNav(deps, s, 1n, deps.prices)).navUsdc;
          const deviation = poolNavDeviationPct(s.usdc, s.tokens, nav);
          Object.assign(leg, { navUsdc: nav, poolPriceUsdc: Number(s.usdc) / Number(s.tokens), deviationPct: deviation ?? undefined });
          const plan = amount >= LEG_MIN_USDC_RAW ? planPoolLeg(amount, s) : null;
          if (deviation === null) { leg.status = "skipped-no-price"; leg.detail = "NAV unavailable."; }
          else if (Math.abs(deviation) > POOL_NAV_LIMIT_PCT) {
            leg.status = "skipped-off-nav";
            leg.detail = `Pool is ${deviation.toFixed(2)}% from NAV; this run's pool part goes to backing.`;
            held = 0n;
          } else if (!plan) leg.status = "skipped-too-small";
          else {
            const ixs = [...deps.budget(600_000), ...buildPoolFeedInstructions({ programId, reserve, reserveMint: mint, keeper: keeper.publicKey, accounts: { pool, ...s.registered }, plan })];
            const tables = await deps.reserveTables(reserve);
            if (!deps.fits(ixs, tables)) { leg.status = "skipped-too-large"; leg.detail = "The pool leg does not fit one transaction."; }
            else {
              leg.signature = await deps.send(`pool feed ${result.reserve.slice(0, 6)}`, ixs, tables);
              leg.status = "added";
              leg.lp = plan.lp.toString();
              // The rest of the pool's part (above the 2% cap, or unused by the deposit and
              // returned to the feed) stays released for the pool's next run.
            }
          }
        }
      } catch (e) {
        leg.status = "skipped-error";
        leg.detail = e instanceof Error ? e.message : String(e);
      }
    }
    released -= held;
    if (released < FEED_MIN_USDC_RAW) return result;
  }

  const assets = await readFeedAssets(deps, reserve);
  const tables = await deps.reserveTables(reserve);
  const usdc = LIQUIDITY_USDC.toBase58();
  const keeperUsdc = getAssociatedTokenAddressSync(LIQUIDITY_USDC, keeper.publicKey);
  for (const leg of planBasketFeedLegs(released, assets)) {
    if (Date.now() > deps.deadline) break;
    const asset = assets.find((a) => a.mint === leg.mint)!;
    const mintBuy = new PublicKey(leg.mint);
    const tokenProgram = new PublicKey(asset.tokenProgram);
    const keeperBuy = leg.mint === usdc ? keeperUsdc : assetAta(mintBuy, keeper.publicKey, tokenProgram);
    const legResult: BasketFeedLegResult = { mint: leg.mint, usdcIn: leg.amount.toString(), status: "skipped-no-route" };
    try {
      let minOut = leg.amount, route: TransactionInstruction[] = [], routeTables: AddressLookupTableAccount[] = [];
      if (leg.mint !== usdc) {
        const quote = await fetchJupiterQuoteWithRetry({ inputMint: usdc, outputMint: leg.mint, amount: leg.amount, slippageBps: DEFAULT_SLIPPAGE_BPS, maxAccounts: null, apiKey: deps.apiKey });
        if (quote.kind !== "ok") { legResult.detail = quote.kind === "specific-error" ? quote.message : `Quote request exhausted retries (last status ${quote.lastStatus}).`; result.legs.push(legResult); continue; }
        if (!isPriceImpactAcceptable(quote.value)) { legResult.status = "skipped-price-impact"; legResult.detail = `Price impact ${Number(quote.value.priceImpactPct).toFixed(2)}% exceeds the safety ceiling.`; result.legs.push(legResult); continue; }
        const built = await buildJupiterSwapInstructionsWithRetry({ quote: quote.value, userPublicKey: keeper.publicKey.toBase58(), apiKey: deps.apiKey, destinationTokenAccount: keeperBuy.toBase58() });
        if (built.kind !== "ok") { legResult.status = "skipped-error"; legResult.detail = built.kind === "specific-error" ? built.message : `Swap build exhausted retries (last status ${built.lastStatus}).`; result.legs.push(legResult); continue; }
        // Jupiter's own slippage bound (outAmount less DEFAULT_SLIPPAGE_BPS) becomes the on-chain minimum.
        const threshold = quote.value.otherAmountThreshold;
        if (typeof threshold !== "string" || !/^\d{1,20}$/.test(threshold) || BigInt(threshold) === 0n) throw new Error("Quote has no usable minimum output");
        minOut = BigInt(threshold);
        route = deps.jupiterInstructions(built.value);
        routeTables = await deps.jupiterTables(built.value.addressLookupTableAddresses);
      }
      const begin = buildBasketFeedBegin({ programId, reserve, keeper: keeper.publicKey, settlementKeeperConfig: findSettlementKeeperConfig(programId)[0], keeperUsdc,
        reserveAssetBuy: findReserveAsset(reserve, mintBuy, programId)[0], vaultBuy: findReserveVault(reserve, mintBuy, programId)[0], mintBuy, keeperBuyAccount: keeperBuy,
        ticket: findRebalanceTicket(reserve, programId)[0], amountIn: leg.amount, minOut });
      const end = await buildRebalanceSwapEndInstruction(deps.program, programId, { reserve, signer: keeper.publicKey, mintBuy, signerBuyAccount: keeperBuy, tokenProgramBuy: tokenProgram });
      const ixs = [
        ...deps.budget(1_000_000),
        createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperUsdc, keeper.publicKey, LIQUIDITY_USDC),
        ...(leg.mint === usdc ? [] : [createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperBuy, keeper.publicKey, mintBuy, tokenProgram)]),
        begin, ...route, end,
      ];
      const allTables = [...tables, ...routeTables];
      if (!deps.fits(ixs, allTables)) { legResult.status = "skipped-too-large"; legResult.detail = "The swap route does not fit one transaction with the feed steps."; result.legs.push(legResult); continue; }
      legResult.minOut = minOut.toString();
      legResult.signature = await deps.send(`basket feed ${leg.mint.slice(0, 6)}`, ixs, allTables);
      legResult.status = "fed";
      released -= leg.amount;
    } catch (e) {
      legResult.status = "skipped-error";
      legResult.detail = e instanceof Error ? e.message : String(e);
    }
    result.legs.push(legResult);
  }
  return result;
}
