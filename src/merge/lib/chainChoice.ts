// Which chain the Launch Reserve page is composing for, parsed from the URL,
// and the list of chains a creator may choose.
//
// Pure, flag-free and viem-free by design: the Launch page is in the main
// bundle, and evmChain.ts pulls in viem. So the EVM choices are declared here
// as plain data and tests/phase_evm_chain_registry.ts asserts they match the
// LIVE entries of evmChain.ts's CHAINS exactly -- a chain flipped live there
// without being listed here (or vice versa) fails the suite.

/** "solana", or the ChainConfig.key of a live EVM chain. */
export type ChainChoice = string;

export interface ChainOption {
  v: ChainChoice;
  label: string;
  blurb: string;
}

export const SOLANA_OPTION: ChainOption = {
  v: "solana",
  label: "Solana",
  blurb: "Settles in USDC. Mint and redeem in one click; the Reserve swaps into its basket for you.",
};

/**
 * The EVM chains offered at launch, in display order. Adding one: flip
 * `live: true` on its ChainConfig AND add it here; the registry test keeps the
 * two in step. See .claude/skills/evm-chain-onboarding/SKILL.md.
 */
export const EVM_LAUNCH_OPTIONS: ChainOption[] = [
  {
    v: "robinhood",
    label: "Robinhood Chain",
    blurb: "Holds tokenized equities (NVDA, SPY, AMZN) and USDG. You seed the basket from your own wallet; mints and redemptions are in kind.",
  },
  {
    v: "bnb",
    label: "BNB Chain",
    blurb: "Holds BTCB, ETH, CAKE, SOL and other major BEP-20 assets, swapped into from USDT on PancakeSwap. Mints and redemptions are in kind.",
  },
  {
    v: "base",
    label: "Base",
    blurb: "Holds cbBTC, WETH, AERO, VIRTUAL and other Base assets, swapped into from USDC on Uniswap. Mints and redemptions are in kind.",
  },
];

export function launchOptions(evmEnabled: boolean): ChainOption[] {
  return evmEnabled ? [SOLANA_OPTION, ...EVM_LAUNCH_OPTIONS] : [SOLANA_OPTION];
}

/**
 * The chain a path selects. Anything that is not a currently offered chain --
 * including an old `?chain=robinhood` bookmark on a build with EVM off --
 * resolves to Solana rather than rendering a form this build does not ship.
 */
export function chainFromPath(path: string, evmEnabled: boolean): ChainChoice {
  if (!evmEnabled) return "solana";
  const want = new URLSearchParams(path.split("?")[1] ?? "").get("chain");
  return EVM_LAUNCH_OPTIONS.some((o) => o.v === want) ? (want as string) : "solana";
}

/** The URL for a choice: Solana is the bare page, every EVM chain is ?chain=<key>. */
export function pathForChain(c: ChainChoice): string {
  return c === "solana" ? "/create" : `/create?chain=${encodeURIComponent(c)}`;
}
