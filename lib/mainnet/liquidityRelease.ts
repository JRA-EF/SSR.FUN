// DEC-0240: liquidity execution (pool launch, add, withdraw, collect, locks)
// is released together with the program upgrade that added the liquidity
// instructions. Compound stays a preview until its funding decision lands.
//
// DEC-0245: held back from production while the feature is tested on
// staging. On only where the deployment sets VITE_ENABLE_LIQUIDITY=true --
// the same variable that builds the frontend surface in
// (src/merge/lib/liquidityFeature.ts), read here at runtime.
export const LIQUIDITY_EXECUTION_ENABLED = process.env.VITE_ENABLE_LIQUIDITY === 'true';
export const COMPOUND_EXECUTION_ENABLED = false;
