// The Robinhood Chain launch, end to end: quote every leg, buy the non-cash
// legs with the creator's USDG on Uniswap, approve the factory, deploy.
// The plan arithmetic lives in evmLaunchPlan.ts (pure); the swaps in
// evmSwap.ts; the deploy in evmReserve.ts. This module only sequences them
// and reports progress, so the form stays presentational.
//
// Resumable by construction: every step is idempotent against the wallet's
// real balances. A rejected prompt or a dropped connection leaves bought
// tokens in the wallet; the next attempt re-quotes, sees the wallet already
// holds a leg, and skips that swap -- the same "already holds enough"
// rule the Solana launch uses.
import type { Address, PublicClient, WalletClient } from "viem";
import { type ChainConfig } from "./evmChain";
import { approveIfNeeded, createReserve } from "./evmReserve";
import { erc20Balance, quoteExactUsdgIn, routeFor, swapExactUsdgIn, type SwapRoute } from "./evmSwap";
import { LAUNCH_MAX_PRICE_IMPACT_BPS, fmtUsdg, minOutAfterSlippage, priceImpactBps, type ChainFeeRecipient, type LaunchLeg, type LaunchPlan } from "./evmLaunchPlan";

export interface LegQuote {
  leg: LaunchLeg;
  route: SwapRoute | null;
  /** Tokens (raw) the leg's USDG is expected to buy; the USDG leg's own amount for the cash leg. */
  quotedOut: bigint;
  minOut: bigint;
  impactBps: number;
}

/**
 * Quotes every swap leg against Uniswap and refuses a market too thin to
 * seed from. `priceUsd` is the catalogue's last mark per asset, used only
 * to measure impact; the quote itself is live.
 */
export async function quoteLaunch(pc: PublicClient, cfg: ChainConfig, plan: LaunchPlan, priceUsd: (address: Address) => number | null): Promise<LegQuote[]> {
  const out: LegQuote[] = [];
  for (const leg of plan.legs) {
    if (leg.kind === "usdg") {
      out.push({ leg, route: null, quotedOut: leg.usdgRaw, minOut: leg.usdgRaw, impactBps: 0 });
      continue;
    }
    if (!leg.asset.pool) throw new Error(`${leg.asset.symbol} has no Uniswap pool to buy it through.`);
    const route = await routeFor(pc, cfg, leg.asset.address, leg.asset.pool);
    const quotedOut = await quoteExactUsdgIn(pc, cfg, route, leg.usdgRaw);
    if (quotedOut <= 0n) throw new Error(`Uniswap returned nothing for ${leg.asset.symbol}; the pool has no liquidity in range.`);
    const px = priceUsd(leg.asset.address);
    let impactBps = 0;
    if (px !== null && px > 0) {
      const usd = Number(leg.usdgRaw) / 1e6;
      const spotOut = BigInt(Math.floor((usd / px) * 10 ** leg.asset.decimals));
      impactBps = priceImpactBps(quotedOut, spotOut);
    }
    if (impactBps > LAUNCH_MAX_PRICE_IMPACT_BPS) {
      throw new Error(
        `Not enough liquidity for ${leg.asset.symbol}: buying ${fmtUsdg(leg.usdgRaw)} USDG of it would move the price about ${(impactBps / 100).toFixed(1)}%. Lower its weight or the initial amount.`,
      );
    }
    out.push({ leg, route, quotedOut, minOut: minOutAfterSlippage(quotedOut), impactBps });
  }
  return out;
}

export interface ExecuteLaunchInput {
  plan: LaunchPlan;
  quotes: LegQuote[];
  name: string;
  symbol: string;
  mintFee: bigint;
  tvlFee: bigint;
  owner: Address;
  feeRecipients: ChainFeeRecipient[];
  coManagers: Address[];
  mandate: string;
}

export async function executeLaunch(
  pc: PublicClient,
  wallet: WalletClient,
  cfg: ChainConfig,
  account: Address,
  input: ExecuteLaunchInput,
  onProgress: (msg: string) => void,
): Promise<{ reserve: Address; hash: `0x${string}` }> {
  const { plan, quotes } = input;

  // Enough of the chain's dollar for the whole seed, checked before anything
  // moves. The dollar is USDG on Robinhood and USDC on Base, so it is read
  // from the chain rather than named here.
  const cash = cfg.quotes?.usd;
  if (!cash) throw new Error("This chain has no dollar asset configured, so a reserve cannot be seeded on it.");
  const usdgHeld = await erc20Balance(pc, cash.address, account);
  if (usdgHeld < plan.seedUsdgRaw) {
    throw new Error(`This wallet holds ${fmtUsdg(usdgHeld)} ${cash.symbol} but the launch needs ${fmtUsdg(plan.seedUsdgRaw)} ${cash.symbol}. Add ${cash.symbol} or lower the initial amount.`);
  }

  // 1. Buy each non-cash leg, skipping any the wallet already holds enough of.
  const acquired = new Map<string, bigint>();
  const swaps = quotes.filter((q) => q.leg.kind === "swap");
  const pending: LegQuote[] = [];
  for (const q of swaps) {
    const have = await erc20Balance(pc, q.leg.asset.address, account);
    if (have >= q.quotedOut) acquired.set(q.leg.asset.address.toLowerCase(), q.quotedOut);
    else pending.push(q);
  }
  if (pending.length > 0) {
    const routerSpend = pending.reduce((s, q) => s + q.leg.usdgRaw, 0n);
    const dollar = cfg.quotes?.usd;
      if (!cfg.dex || !dollar) throw new Error("This chain has no DEX configured, so the basket cannot be bought.");
      await approveIfNeeded(pc, wallet, cfg, account, dollar.address, cfg.dex.router, routerSpend, onProgress, dollar.symbol);
    for (const q of pending) {
      onProgress(`Buying ${q.leg.asset.symbol} with ${fmtUsdg(q.leg.usdgRaw)} USDG...`);
      const before = await erc20Balance(pc, q.leg.asset.address, account);
      await swapExactUsdgIn(pc, wallet, cfg, account, q.route!, q.leg.usdgRaw, q.minOut);
      const after = await erc20Balance(pc, q.leg.asset.address, account);
      const got = after - before;
      if (got <= 0n) throw new Error(`The ${q.leg.asset.symbol} swap confirmed but the wallet balance did not rise; stopping before anything is deployed.`);
      acquired.set(q.leg.asset.address.toLowerCase(), got);
    }
  }

  // 2. Deploy with what was actually bought (plus the cash leg as planned).
  const legs = plan.legs.map((leg) => {
    const amount = leg.kind === "usdg" ? leg.usdgRaw : acquired.get(leg.asset.address.toLowerCase());
    if (amount === undefined || amount <= 0n) throw new Error(`No ${leg.asset.symbol} was acquired for the basket.`);
    return { asset: { address: leg.asset.address, symbol: leg.asset.symbol, decimals: leg.asset.decimals }, amount };
  });
  return createReserve(
    pc,
    wallet,
    cfg,
    account,
    {
      name: input.name,
      symbol: input.symbol,
      legs,
      initialShares: plan.initialShares,
      mintFee: input.mintFee,
      tvlFee: input.tvlFee,
      owner: input.owner,
      feeRecipients: input.feeRecipients,
      coManagers: input.coManagers,
      mandate: input.mandate,
    },
    onProgress,
  );
}
