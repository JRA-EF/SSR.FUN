// Robinhood reserve ids in the shared /dtr/:id route. Kept free of viem so the
// router can use it without pulling the EVM stack into the main bundle.
export const RH_ID_PREFIX = "rh-";
export const rhReserveId = (address: string) => `${RH_ID_PREFIX}${address}`;
export function rhAddressFromId(id: string): `0x${string}` | null {
  if (!id.startsWith(RH_ID_PREFIX)) return null;
  const a = id.slice(RH_ID_PREFIX.length);
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
}
