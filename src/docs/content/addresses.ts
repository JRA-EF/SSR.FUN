/**
 * Public on-chain identifiers quoted throughout the docs. All of these are
 * public by nature (program IDs, well-known Solana programs, derived byte
 * layouts) -- nothing here is a secret. Keep in sync with Anchor.toml and
 * programs/ssr_protocol/src/state/reserve.rs when either changes.
 */

export const SSR_PROGRAM_MAINNET = '8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'
export const SSR_PROGRAM_DEVNET = '2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW'
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

/** sha256("account:Reserve")[0..8] -- the Anchor discriminator of the Reserve account, base58. */
export const RESERVE_DISCRIMINATOR_B58 = '8MMas8GHex6'
export const RESERVE_DISCRIMINATOR_BYTES = '[43, 242, 204, 202, 26, 247, 59, 127]'

/** Byte offsets inside a Reserve account (see the layout table in the Protocol reference). */
export const RESERVE_MINT_OFFSET = 49
export const RESERVE_METADATA_URI_OFFSET = 167

export const RESERVE_TOKEN_DECIMALS = 6
export const MAX_METADATA_URI_LEN = 200
