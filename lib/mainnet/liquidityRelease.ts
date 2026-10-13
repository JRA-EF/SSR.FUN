// DEC-0240: liquidity execution (pool launch, add, withdraw, collect, locks)
// is released together with the program upgrade that added the liquidity
// instructions. Compound stays a preview until its funding decision lands.
export const LIQUIDITY_EXECUTION_ENABLED = true;
export const COMPOUND_EXECUTION_ENABLED = false;
