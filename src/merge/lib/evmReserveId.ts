// EVM reserve ids in the shared /dtr/:id route, as "<prefix>-<address>".
//
// Kept free of viem so the router can use it without pulling the EVM stack
// into the main bundle -- which is why the prefix table is duplicated here as
// plain data rather than imported from evmChain.ts. phase_evm_chain_ids.ts
// asserts the two agree.
//
// "rh-" was the only prefix while Robinhood was the only chain. Existing
// rh-<address> links keep working unchanged.

/** Prefix -> chain key. Must match every ChainConfig.idPrefix in evmChain.ts. */
export const EVM_ID_PREFIXES: Record<string, string> = {
  rh: "robinhood",
  rht: "robinhood-testnet",
  base: "base",
  bnb: "bnb",
  eth: "ethereum",
};

/** Robinhood's prefix, kept named because it is the one already in the wild. */
export const RH_ID_PREFIX = "rh-";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface EvmReserveRef {
  /** The ChainConfig.key this id belongs to. */
  chainKey: string;
  address: `0x${string}`;
}

/** Builds the route id for a reserve on a chain. */
export function evmReserveId(idPrefix: string, address: string): string {
  return `${idPrefix}-${address}`;
}

/** Robinhood's, unchanged -- every link already issued uses it. */
export const rhReserveId = (address: string) => `${RH_ID_PREFIX}${address}`;

/**
 * Splits "<prefix>-<address>" into the chain it names and the address, or null
 * when the id is not an EVM reserve id at all (a Solana id, say). Unknown
 * prefixes return null rather than guessing a chain.
 */
export function parseEvmReserveId(id: string): EvmReserveRef | null {
  const dash = id.indexOf("-");
  if (dash <= 0) return null;
  const chainKey = EVM_ID_PREFIXES[id.slice(0, dash)];
  if (!chainKey) return null;
  const address = id.slice(dash + 1);
  return ADDRESS_RE.test(address) ? { chainKey, address: address as `0x${string}` } : null;
}

/** Back-compat: the address of a Robinhood id, or null for anything else. */
export function rhAddressFromId(id: string): `0x${string}` | null {
  const ref = parseEvmReserveId(id);
  return ref && ref.chainKey === "robinhood" ? ref.address : null;
}
