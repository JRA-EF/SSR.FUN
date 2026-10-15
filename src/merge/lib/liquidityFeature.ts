// Whether this build exposes the in-app DEX liquidity feature (DEC-0240:
// pool launch, add, withdraw, collect, locks) to visitors.
//
// The program instructions are live on Mainnet, but the surface is held back
// from production while it is tested on staging (DEC-0245). Rather than
// delete working code, every visitor-reachable entry point hides behind one
// switch -- the same mechanism as EVM_ENABLED (src/merge/lib/evmFeature.ts).
//
// Off unless VITE_ENABLE_LIQUIDITY=true at BUILD time; the value is inlined,
// so changing it on a running deployment does nothing until a rebuild. The
// server-side execution gate (lib/mainnet/liquidityRelease.ts) reads the same
// variable at runtime, so one Vercel env var turns both halves on together.
//
// What it gates:
//   ManageDTR.tsx        the Liquidity tab on Manage Reserve
//   DTRDetail.tsx        the post-first-mint prompt that leads into that tab
export const LIQUIDITY_ENABLED = (import.meta.env.VITE_ENABLE_LIQUIDITY as string | undefined) === "true";
