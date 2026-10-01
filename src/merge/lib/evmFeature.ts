// Whether this build exposes the EVM (Robinhood Chain) side of the protocol.
//
// The contracts are deployed and the UI is built, but the chain is not ready
// to be shown to ordinary visitors: Robinhood mainnet 4663 still runs a
// MockRoleRegistry and has had no registerVersion call, so a reserve created
// there would not be governed the way the Solana side is. Rather than delete
// working code, the whole surface hides behind one switch.
//
// Off unless VITE_ENABLE_EVM=true at BUILD time. Vite inlines the value and
// dead-code-eliminates the branches, so a default build ships without the
// EVM entry points at all -- the same mechanism as VITE_TOKEN_METADATA_LIVE
// (src/merge/lib/solana-config.ts). Note the corollary: setting this in a
// running deployment does nothing; the app must be REBUILT with it set.
//
// What it gates (every visitor-reachable entry point):
//   Shell.tsx            the EVM wallet chip in the header
//   App.tsx              the /evm route and the /dtr/rh-<address> detail route
//   Discover.tsx         the chain filter and Robinhood cards/banners
//   CreateReserve.tsx    the chain picker and the Robinhood create form
//   Portfolio.tsx        the Robinhood holdings section
//   Home.tsx             Robinhood reserves among the featured entries
//   HeroPlatforms.tsx    the Robinhood logo in the hero
//   useRobinhoodReserves the RPC fetch itself, so nothing is requested
export const EVM_ENABLED = (import.meta.env.VITE_ENABLE_EVM as string | undefined) === "true";
