// Plain-language copy for the moment a multi-transaction Buy or Sell opens
// the wallet's sign-everything prompt (DEC-0217).
//
// Why this exists. When a purchase cannot fit one atomic transaction
// (lib/mainnet/buildBuy.ts mode "batch"), the wallet shows one entry per
// transaction and simulates each one on its own against the wallet's
// CURRENT balances: the swaps read as "USDC out, reserve asset in", and the
// mint -- which depends on assets the swaps have not delivered yet -- cannot
// be previewed at all, so the Reserve Token it will deliver is not shown.
// That is exactly what a buyer saw in Phantom ("trading my USDC for the
// underlying assets"). Nothing in the wallet's preview can be changed from
// here; what CAN be done is telling the buyer, at that exact moment, what
// they are looking at and what they will hold when it is done.
//
// Pure and offline-testable; the clients pass the real transaction counts.
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function describeBatchBuyWalletPrompt(p: { swaps: number; total: number; ticker: string }): string {
  const swaps = Math.max(0, Math.floor(p.swaps));
  const total = Math.max(swaps + 1, Math.floor(p.total));
  const ticker = p.ticker.trim() || "Reserve Token";
  const swapPart = swaps > 0 ? `${swaps} ${plural(swaps, "swap", "swaps")} of your USDC into the Reserve's assets, then ` : "";
  return (
    `Your wallet will ask you to approve ${total} ${plural(total, "transaction", "transactions")} at once: ${swapPart}the deposit that mints your ${ticker}. ` +
    `The wallet previews each one separately, so the swaps read as USDC out and assets in -- those assets only pass through your wallet on their way into the Reserve. ` +
    `When everything lands you hold ${ticker}, not the assets.`
  );
}

export function describeBatchSellWalletPrompt(p: { swaps: number; total: number; ticker: string }): string {
  const swaps = Math.max(0, Math.floor(p.swaps));
  const total = Math.max(swaps + 1, Math.floor(p.total));
  const ticker = p.ticker.trim() || "Reserve Token";
  const swapPart = swaps > 0 ? `, then ${swaps} ${plural(swaps, "sale", "sales")} of those assets into USDC` : "";
  return (
    `Your wallet will ask you to approve ${total} ${plural(total, "transaction", "transactions")} at once: the redemption of your ${ticker} into the Reserve's assets${swapPart}. ` +
    `The wallet previews each one separately, so the assets appear in your wallet for a moment -- when everything lands you hold USDC.`
  );
}

/**
 * The line every Launch success message carries (DEC-0217): the Discover
 * page and other visitors' first paint come from a server snapshot that is
 * rebuilt a few seconds after launch and otherwise every ten minutes, and a
 * freshly used asset can take a moment longer to resolve on a reload.
 */
export const RESERVE_VISIBILITY_NOTE =
  "It can take a few minutes for your Reserve to appear everywhere -- Discover, Portfolio, and other people's screens catch up on their own. Your Reserve and funds are already safe on-chain.";
