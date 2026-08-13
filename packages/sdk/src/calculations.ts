// Deterministic integer math mirroring
// programs/ssr_protocol/src/instructions/common.rs -- uses BigInt throughout
// (never `number`/floating point) so a client can compute the exact amounts
// the on-chain program will independently compute, for building
// slippage-bounded instructions. See docs/protocol/SSR_ARCHITECTURE.md
// section 0 and RESERVE_REFERENCE_ANALYSIS.md section 14 for the
// rounding-direction policy this mirrors (ceiling favors the protocol on
// mint-side requirements and fees; floor favors the protocol on
// redemption-side payouts).

export const BPS_DENOMINATOR = 10_000n;

export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("mulDivCeil: division by zero");
  const product = a * b;
  return (product + c - 1n) / c;
}

export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("mulDivFloor: division by zero");
  return (a * b) / c;
}

export interface AssetBalance {
  mint: string; // base58 pubkey
  vaultBalance: bigint;
}

export interface MintRequirement {
  mint: string;
  requiredAmount: bigint;
}

/**
 * Required per-asset input amounts for a requested (pre-fee, gross)
 * `reserveTokensRequested` mint, given the CURRENT on-chain supply and vault
 * balances. Mirrors `mint_reserve_tokens_in_kind`'s ceiling-rounded
 * `mul_div_ceil(requested, vaultBalance, totalSupply)` exactly. Callers
 * should pass a small buffer above these amounts as `maxAssetAmounts` to
 * the instruction to tolerate balances moving between simulation and
 * execution (the instruction itself re-reads live balances on-chain --
 * this is only for the client's slippage-bound choice, not a guess at the
 * final amount).
 */
export function computeMintRequirements(
  reserveTokensRequested: bigint,
  totalSupply: bigint,
  assetBalances: AssetBalance[],
): MintRequirement[] {
  if (totalSupply <= 0n) {
    throw new Error("computeMintRequirements: zero supply -- Reserve must be seeded first (see computeSeedPlan)");
  }
  return assetBalances.map((a) => ({
    mint: a.mint,
    requiredAmount: mulDivCeil(reserveTokensRequested, a.vaultBalance, totalSupply),
  }));
}

/** Net Reserve Tokens the depositor actually receives after the mint fee (ceil-rounded, protocol-favoring). */
export function computeNetMintOutput(reserveTokensRequested: bigint, mintFeeBps: bigint): { netOut: bigint; feeShares: bigint } {
  const feeShares = mulDivCeil(reserveTokensRequested, mintFeeBps, BPS_DENOMINATOR);
  const netOut = reserveTokensRequested - feeShares;
  if (netOut <= 0n) throw new Error("computeNetMintOutput: fee consumes the entire requested amount");
  return { netOut, feeShares };
}

export interface RedemptionEntitlement {
  mint: string;
  entitlement: bigint;
}

/**
 * Proportional per-asset payout for burning `reserveTokensToRedeem` (gross,
 * pre-fee), given CURRENT supply/balances. Mirrors
 * `redeem_reserve_tokens_in_kind`'s floor-rounded
 * `mul_div_floor(netShares, vaultBalance, totalSupply)`, where `netShares`
 * excludes the redemption fee portion (which stays in the vaults as
 * accretion to remaining holders -- see the comment in
 * redeem_reserve_tokens_in_kind.rs).
 */
export function computeRedemptionEntitlements(
  reserveTokensToRedeem: bigint,
  redemptionFeeBps: bigint,
  totalSupply: bigint,
  assetBalances: AssetBalance[],
): RedemptionEntitlement[] {
  if (totalSupply <= 0n) throw new Error("computeRedemptionEntitlements: zero supply");
  const feeShares = mulDivCeil(reserveTokensToRedeem, redemptionFeeBps, BPS_DENOMINATOR);
  const netShares = reserveTokensToRedeem - feeShares;
  if (netShares <= 0n) throw new Error("computeRedemptionEntitlements: fee consumes the entire redeemed amount");
  return assetBalances.map((a) => ({
    mint: a.mint,
    entitlement: mulDivFloor(netShares, a.vaultBalance, totalSupply),
  }));
}

/**
 * Client-side sanity check only (NOT an on-chain invariant -- the program
 * itself checks each asset's seed amount independently). Mirrors the
 * MIN_SEED_AMOUNT_PER_ASSET floor from
 * programs/ssr_protocol/src/constants.rs so a client can fail fast with a
 * clear message before submitting a transaction that would revert.
 */
export const MIN_SEED_AMOUNT_PER_ASSET = 1_000n;

export function validateSeedPlan(seedAmounts: bigint[], initialReserveTokens: bigint): void {
  if (initialReserveTokens <= 0n) throw new Error("validateSeedPlan: initialReserveTokens must be > 0");
  for (const amount of seedAmounts) {
    if (amount < MIN_SEED_AMOUNT_PER_ASSET) {
      throw new Error(
        `validateSeedPlan: seed amount ${amount} is below the minimum ${MIN_SEED_AMOUNT_PER_ASSET} -- see DEC-0009 (this floor exists specifically because SSR's Reserve creation is permissionless, unlike the reference protocol's trusted-deployer model)`,
      );
    }
  }
}

export interface FeeShareSplit {
  managerFeeShares: bigint;
  protocolFeeShares: bigint;
}

/**
 * Splits a total assessed fee (already in Reserve Token base units, e.g.
 * `computeNetMintOutput`'s `feeShares`) between Manager and Protocol per the
 * Reserve's own configured bps split. Mirrors the exact floor+exact-remainder
 * pattern in mint_reserve_tokens_in_kind.rs/accrue_fees.rs (2026-08-13
 * corrective pass, DEC-0093): managerFeeShares is floor-rounded,
 * protocolFeeShares is whatever's left -- never independently rounded --
 * so `managerFeeShares + protocolFeeShares === totalFeeShares` always holds
 * exactly, with zero dust ever silently unallocated. Only valid when
 * `managerFeeShareBps + protocolFeeShareBps === BPS_DENOMINATOR`, which
 * create_reserve.rs now enforces for every Reserve at creation time.
 */
export function computeFeeShareSplit(totalFeeShares: bigint, managerFeeShareBps: bigint, protocolFeeShareBps: bigint): FeeShareSplit {
  if (managerFeeShareBps + protocolFeeShareBps !== BPS_DENOMINATOR) {
    throw new Error(
      `computeFeeShareSplit: managerFeeShareBps (${managerFeeShareBps}) + protocolFeeShareBps (${protocolFeeShareBps}) must equal BPS_DENOMINATOR (${BPS_DENOMINATOR}) -- every real Reserve's FeeConfig satisfies this by construction`,
    );
  }
  const managerFeeShares = mulDivFloor(totalFeeShares, managerFeeShareBps, BPS_DENOMINATOR);
  const protocolFeeShares = totalFeeShares - managerFeeShares;
  return { managerFeeShares, protocolFeeShares };
}
