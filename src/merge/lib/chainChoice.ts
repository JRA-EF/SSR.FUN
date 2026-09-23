// Which chain the Launch Reserve page is composing for, parsed from the URL.
//
// Pure and flag-free by design: src/merge/lib/evmFeature.ts reads
// import.meta.env, which cannot be loaded under the CommonJS test runner, so
// the decision lives here and the flag is passed in. CreateReserve.tsx
// supplies EVM_ENABLED.
export type ChainChoice = "solana" | "robinhood";

/**
 * The chain a path selects.
 *
 * With the EVM surface disabled there is only one chain, so an old
 * `?chain=robinhood` bookmark resolves to Solana rather than rendering a form
 * this build does not ship.
 */
export function chainFromPath(path: string, evmEnabled: boolean): ChainChoice {
  if (!evmEnabled) return "solana";
  const q = path.split("?")[1] ?? "";
  return new URLSearchParams(q).get("chain") === "robinhood" ? "robinhood" : "solana";
}
