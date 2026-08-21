// SSR.fun Protocol/Manager fee-split math (DEC-0094). Mirrors
// programs/ssr_protocol/src/fee_math.rs EXACTLY -- keep both in sync. Used
// both to build instructions (client must not under/over-estimate what the
// program will compute) and to render "before submission" previews in the
// Create Reserve / Manage Reserve UI. The on-chain program is always the
// source of truth; this exists so the client can compute the SAME numbers
// ahead of time, never so the frontend can enforce the rule on its own.
import { BPS_DENOMINATOR, mulDivFloor } from "./calculations";

/** SSR.fun's Protocol minimum on both the Mint fee and the Annualized TVL fee. */
export const PROTOCOL_MIN_MINT_FEE_BPS = 50n; // 0.5%
export const PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS = 50n; // 0.5%

/** Maximum Manager fee recipients per Reserve, including the Primary Fee Destination. */
export const MAX_FEE_RECIPIENTS = 10;

export interface EffectiveFeeSplit {
  protocolBps: bigint;
  managerBps: bigint;
  /** protocolBps + managerBps -- the EFFECTIVE total rate actually charged, which can exceed configuredBps when configuredBps is below the floor. */
  effectiveTotalBps: bigint;
}

/**
 * `protocolBps = max(protocolMinBps, configuredBps / 2)`
 * `managerBps  = max(configuredBps - protocolBps, 0)`
 *
 * Whenever a manager configures a NONZERO fee, the Protocol's share is
 * floored at `protocolMinBps` (the effective total can then exceed
 * `configuredBps` when it's below the floor). A manager who genuinely
 * configures 0% pays no floor at all -- `configuredBps === 0n` always
 * yields `{protocolBps: 0n, managerBps: 0n}`, a real zero-fee mint/TVL
 * accrual. There is no forced minimum fee; the floor only governs how a
 * NONZERO fee splits.
 *
 * Floor division for the "50% of configured" half -- matches every example
 * in the task's own table exactly (all even bps values); for an odd
 * `configuredBps` the extra basis point goes to the Manager, not the
 * Protocol (an arbitrary but deterministic tie-break, not a rounding bug --
 * `protocolBps` is always still >= `protocolMinBps` when `configuredBps > 0`).
 */
export function computeEffectiveFeeSplit(configuredBps: bigint, protocolMinBps: bigint): EffectiveFeeSplit {
  if (configuredBps === 0n) return { protocolBps: 0n, managerBps: 0n, effectiveTotalBps: 0n };
  const half = configuredBps / 2n;
  const protocolBps = protocolMinBps > half ? protocolMinBps : half;
  const managerBps = configuredBps > protocolBps ? configuredBps - protocolBps : 0n;
  return { protocolBps, managerBps, effectiveTotalBps: protocolBps + managerBps };
}

export interface TotalFeeSplit {
  protocolTotal: bigint;
  managerTotal: bigint;
}

/**
 * Splits `totalFeeShares` (already computed from the EFFECTIVE total bps,
 * e.g. via mulDivCeil(amount, effectiveTotalBps, BPS_DENOMINATOR)) into
 * (protocolTotal, managerTotal). Divides by `protocolBps + managerBps` (the
 * effective total the fee was itself computed from), NOT BPS_DENOMINATOR --
 * unlike the pre-DEC-0094 two-way split, these generally don't sum to
 * 10,000. managerTotal is floor-rounded; protocolTotal is the exact
 * remainder, so the two always sum to totalFeeShares exactly.
 */
export function splitTotalFee(totalFeeShares: bigint, protocolBps: bigint, managerBps: bigint): TotalFeeSplit {
  const effectiveTotalBps = protocolBps + managerBps;
  if (effectiveTotalBps === 0n) return { protocolTotal: 0n, managerTotal: 0n };
  const managerTotal = mulDivFloor(totalFeeShares, managerBps, effectiveTotalBps);
  const protocolTotal = totalFeeShares - managerTotal;
  return { protocolTotal, managerTotal };
}

export interface FeeRecipientAllocation {
  wallet: string;
  allocationBps: bigint;
}

/**
 * Splits `managerTotal` across `recipients` via largest-remainder (Hamilton)
 * apportionment -- exact integer math, no floats: each recipient's exact
 * share is `managerTotal * allocationBps / 10_000`; every recipient gets
 * the floor of that, and the leftover raw units (always < recipients.length
 * since allocations must sum to exactly 10,000) go one-by-one to the
 * recipients with the largest fractional remainder, ties broken by lowest
 * array index for determinism. Exact: the returned amounts always sum to
 * `managerTotal`. Mirrors fee_math::apportion_to_recipients exactly.
 */
export function apportionToRecipients(managerTotal: bigint, recipients: FeeRecipientAllocation[]): bigint[] {
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let sumFloor = 0n;

  for (const r of recipients) {
    const numerator = managerTotal * r.allocationBps;
    const floor = numerator / BPS_DENOMINATOR;
    floors.push(floor);
    remainders.push(numerator % BPS_DENOMINATOR);
    sumFloor += floor;
  }

  const leftover = managerTotal - sumFloor;
  const order = recipients.map((_, i) => i).sort((a, b) => {
    if (remainders[b] !== remainders[a]) return remainders[b] > remainders[a] ? 1 : -1;
    return a - b;
  });

  const increments = [...floors];
  for (let i = 0; i < Number(leftover); i++) {
    increments[order[i]] += 1n;
  }
  return increments;
}

export interface WeightedSplit {
  protocolShare: bigint;
  managerShare: bigint;
}

/**
 * USDC fee-settlement pipeline (2026-08-21 pass). Mirrors
 * programs/ssr_protocol/src/fee_math.rs::split_by_weight EXACTLY -- keep
 * both in sync. Splits `amount` between Protocol and Manager proportionally
 * to their CURRENT weights (e.g. FeeSettlement's protocolSharesInVault vs
 * managerSharesInVault, or protocolSharesPendingSettlement vs
 * managerSharesPendingSettlement), same floor+exact-remainder pattern as
 * splitTotalFee above (managerShare floor-rounded, protocolShare gets the
 * exact remainder -- protocol-favored). Returns zeros when both weights are
 * zero rather than dividing by zero.
 */
export function splitByWeight(amount: bigint, protocolWeight: bigint, managerWeight: bigint): WeightedSplit {
  const totalWeight = protocolWeight + managerWeight;
  if (totalWeight === 0n) return { protocolShare: 0n, managerShare: 0n };
  const managerShare = mulDivFloor(amount, managerWeight, totalWeight);
  const protocolShare = amount - managerShare;
  return { protocolShare, managerShare };
}

export interface RecipientInput {
  wallet: string;
  allocationBps: number;
}

/**
 * Client-side sanity check only (NOT an on-chain invariant -- the program
 * independently validates the same rules) mirroring
 * instructions::common::validate_fee_recipient_inputs, so a client can fail
 * fast with a clear message before submitting a transaction that would
 * revert. Rejects: empty or >MAX_FEE_RECIPIENTS lists, the default/zero
 * address, a zero allocation, a duplicate wallet, and a total that isn't
 * exactly 10,000 basis points (100% of the Manager's share -- never a
 * percentage of the total assessed fee).
 */
export function validateFeeRecipientInputs(recipients: RecipientInput[]): void {
  if (recipients.length === 0 || recipients.length > MAX_FEE_RECIPIENTS) {
    throw new Error(`validateFeeRecipientInputs: recipient count must be between 1 and ${MAX_FEE_RECIPIENTS}, got ${recipients.length}`);
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const r of recipients) {
    if (!r.wallet || r.wallet === "11111111111111111111111111111111") {
      throw new Error("validateFeeRecipientInputs: recipient wallet must not be empty or the default/zero address");
    }
    if (r.allocationBps <= 0) {
      throw new Error(`validateFeeRecipientInputs: recipient ${r.wallet} has a zero/negative allocation`);
    }
    if (seen.has(r.wallet)) {
      throw new Error(`validateFeeRecipientInputs: duplicate recipient wallet ${r.wallet}`);
    }
    seen.add(r.wallet);
    sum += r.allocationBps;
  }
  if (sum !== 10_000) {
    throw new Error(`validateFeeRecipientInputs: allocations must sum to exactly 10,000 basis points (100%), got ${sum}`);
  }
}
