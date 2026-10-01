// The arithmetic behind launching a Reserve on Robinhood Chain, kept pure
// (no RPC, no React) so tests/phase_robinhood_launch_plan.ts can pin it.
//
// The Robinhood launch mirrors the Solana one: the creator sets target
// WEIGHTS and ONE USDG amount; the app buys each non-cash leg with that USDG
// on Uniswap v3 (src/merge/lib/evmSwap.ts), deposits the cash leg directly,
// and deploys the reserve with initial shares equal to the USDG put in -- one
// Reserve Token per dollar at inception, exactly as on Solana. After that
// the contract mints and redeems pro-rata against the basket (NAV), so the
// creator never "picks a share count".
import type { Address } from "viem";

export const D18 = 10n ** 18n;
/** USDG has 6 decimals. */
export const USDG_DECIMALS = 6;
/** Same per-Reserve basket size as the Solana wizard. */
export const RH_MAX_ASSETS_PER_RESERVE = 12;
/** Price-protection on every launch swap: the quote's expected output minus this is the minimum accepted. */
export const LAUNCH_SWAP_SLIPPAGE_BPS = 100;
/** A quote that lands this far under the pool's own spot price is a market too thin to seed from. */
export const LAUNCH_MAX_PRICE_IMPACT_BPS = 500;

export interface PlannedAsset {
  address: Address;
  symbol: string;
  decimals: number;
  /** Target weight as a fraction of 1 (0.25 = 25%). */
  weight: number;
  /** The Uniswap v3 pool the asset is bought through; null only for USDG. */
  pool: { address: Address; fee: number; quote: "USDG" | "WETH" } | null;
}

export interface LaunchLeg {
  asset: PlannedAsset;
  /** Basis points of the seed this leg receives. */
  bps: number;
  /** USDG (raw, 6 decimals) spent on this leg. */
  usdgRaw: bigint;
  /** "usdg": deposited directly. "swap": bought on Uniswap first. */
  kind: "usdg" | "swap";
}

export interface LaunchPlan {
  legs: LaunchLeg[];
  /** The whole seed in raw USDG; every leg sums to exactly this. */
  seedUsdgRaw: bigint;
  /** Raw USDG that goes through the router (the sum of the swap legs). */
  swapUsdgRaw: bigint;
  /** Raw USDG deposited directly (the cash leg: an explicit USDG weight plus any unallocated remainder). */
  directUsdgRaw: bigint;
  /** 1:1 -- one share (18 decimals) per USDG put in. */
  initialShares: bigint;
}

export function toBps(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  return Math.min(10_000, Math.round(weight * 10_000));
}

/** "10.5" -> 10_500_000n (raw USDG). Refuses zero, negatives and more than 6 decimals of precision after rounding. */
export function parseUsdgAmount(input: string | number): bigint {
  const n = typeof input === "number" ? input : parseFloat(String(input).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error("Enter an initial amount in USDG greater than zero.");
  return BigInt(Math.round(n * 10 ** USDG_DECIMALS));
}

export function isUsdg(address: string, usdg: Address): boolean {
  return address.toLowerCase() === usdg.toLowerCase();
}

/**
 * Splits the seed across the basket by weight (integer bps, remainder to the
 * cash leg so the column sums to exactly the seed). Weights may sum to less
 * than 100%: the rest stays as USDG in the reserve, as on Solana's
 * "Unallocated USDC Reserve". More than 100% is refused.
 */
export function planLaunch(assets: PlannedAsset[], seedUsdgRaw: bigint, usdg: Address): LaunchPlan {
  if (seedUsdgRaw <= 0n) throw new Error("Enter an initial amount in USDG greater than zero.");
  const bpsList = assets.map((a) => toBps(a.weight));
  const total = bpsList.reduce((s, b) => s + b, 0);
  if (total > 10_000) throw new Error("Target weights exceed 100%.");
  const seen = new Set<string>();
  for (const a of assets) {
    const k = a.address.toLowerCase();
    if (seen.has(k)) throw new Error(`${a.symbol} is listed twice.`);
    seen.add(k);
    if (!isUsdg(a.address, usdg) && !a.pool) throw new Error(`${a.symbol} has no Uniswap pool to buy it through.`);
  }
  let allocated = 0n;
  const legs: LaunchLeg[] = [];
  let directUsdgRaw = 0n;
  let swapUsdgRaw = 0n;
  assets.forEach((a, i) => {
    const bps = bpsList[i];
    if (bps === 0) return;
    const raw = (seedUsdgRaw * BigInt(bps)) / 10_000n;
    allocated += raw;
    if (isUsdg(a.address, usdg)) {
      directUsdgRaw += raw;
      legs.push({ asset: a, bps, usdgRaw: raw, kind: "usdg" });
    } else {
      swapUsdgRaw += raw;
      legs.push({ asset: a, bps, usdgRaw: raw, kind: "swap" });
    }
  });
  const remainder = seedUsdgRaw - allocated;
  if (remainder > 0n) {
    directUsdgRaw += remainder;
    const cash = legs.find((l) => l.kind === "usdg");
    if (cash) {
      cash.usdgRaw += remainder;
      cash.bps = 10_000 - (total - cash.bps);
    } else {
      legs.push({
        asset: { address: usdg, symbol: "USDG", decimals: USDG_DECIMALS, weight: (10_000 - total) / 10_000, pool: null },
        bps: 10_000 - total,
        usdgRaw: remainder,
        kind: "usdg",
      });
    }
  }
  if (legs.length === 0) throw new Error("Add at least one asset.");
  return { legs, seedUsdgRaw, swapUsdgRaw, directUsdgRaw, initialShares: seedUsdgRaw * 10n ** BigInt(18 - USDG_DECIMALS) };
}

/** 1.25 (%) -> 0.0125e18. Fees are entered to two decimals of a percent. */
export function percentToD18(pct: number): bigint {
  if (!Number.isFinite(pct) || pct < 0) throw new Error("A fee must be a number of percent, zero or more.");
  return BigInt(Math.round(pct * 100)) * 10n ** 14n;
}

export function d18ToPercent(v: bigint): number {
  return Number(v / 10n ** 12n) / 10_000;
}

/**
 * Mirrors SSRLib.computeMintFees (and evmReserve.ts's mintFeeBreakdown): the
 * DAO takes `num/den` of the configured fee, never less than `floor`, and
 * the total charged is raised to the DAO's share if the configured fee is
 * below it. Returns D18 fractions.
 */
export function effectiveFeeSplit(feeD18: bigint, daoNum: bigint, daoDen: bigint, floorD18: bigint): { totalD18: bigint; protocolD18: bigint; managerD18: bigint } {
  let total = feeD18;
  let dao = daoDen === 0n ? 0n : (total * daoNum + daoDen - 1n) / daoDen;
  if (dao < floorD18) dao = floorD18;
  if (total < dao) total = dao;
  return { totalD18: total, protocolD18: dao, managerD18: total - dao };
}

export interface FeeRecipientInput {
  address: string;
  /** Percent of the Manager's fee share (0-100). */
  pct: number;
}

export interface ChainFeeRecipient {
  recipient: Address;
  portion: bigint;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The Folio's fee-recipient list from the Solana-style form: the primary
 * destination takes whatever the additional recipients do not. The contract
 * requires strictly ascending addresses, no zero portions, and portions
 * summing to exactly 1e18 (FolioLib.setFeeRecipients) -- all enforced here
 * so a bad list fails before the wallet opens, not inside deploySSR.
 */
export function feeRecipientsForChain(primary: string, additional: FeeRecipientInput[]): ChainFeeRecipient[] {
  if (!ADDRESS_RE.test(primary.trim())) throw new Error("The primary fee destination must be a valid 0x address.");
  const portions = new Map<string, bigint>();
  let used = 0n;
  for (const r of additional) {
    const a = r.address.trim();
    if (!ADDRESS_RE.test(a)) throw new Error(`Fee recipient ${a || "(blank)"} is not a valid 0x address.`);
    if (!Number.isFinite(r.pct) || r.pct <= 0) throw new Error(`Fee recipient ${a} needs a share greater than 0%.`);
    const portion = BigInt(Math.round(r.pct * 100)) * 10n ** 14n;
    used += portion;
    const k = a.toLowerCase();
    portions.set(k, (portions.get(k) ?? 0n) + portion);
  }
  if (used > D18) throw new Error("Additional fee recipients exceed 100% of the Manager's share.");
  const pk = primary.trim().toLowerCase();
  const primaryPortion = D18 - used;
  if (primaryPortion > 0n) portions.set(pk, (portions.get(pk) ?? 0n) + primaryPortion);
  const list = [...portions.entries()]
    .filter(([, p]) => p > 0n)
    .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1))
    .map(([addr, portion]) => ({ recipient: checksumless(addr), portion }));
  const sum = list.reduce((s, r) => s + r.portion, 0n);
  if (sum !== D18) throw new Error("Fee shares do not add up to 100%.");
  if (list.length > 64) throw new Error("At most 64 fee recipients.");
  return list;
}

/** The contract compares addresses numerically; lower-case hex is fine for the ABI encoder. */
function checksumless(addr: string): Address {
  return addr.toLowerCase() as Address;
}

/** Co-managers: unique, valid, never the owner twice. */
export function coManagersForChain(owner: string, additional: string[]): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>([owner.trim().toLowerCase()]);
  for (const a of additional) {
    const t = a.trim();
    if (!ADDRESS_RE.test(t)) throw new Error(`Co-manager ${t || "(blank)"} is not a valid 0x address.`);
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t as Address);
  }
  return out;
}

/** The least a swap may return for the quoted output, after slippage. */
export function minOutAfterSlippage(quotedOut: bigint, slippageBps: number = LAUNCH_SWAP_SLIPPAGE_BPS): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Price impact of a quote against the pool's spot, in bps (positive = the
 * quote pays more per token than spot). `spotOut` is what the input would
 * buy at the marked price with no impact.
 */
export function priceImpactBps(quotedOut: bigint, spotOut: bigint): number {
  if (spotOut <= 0n) return 0;
  const diff = spotOut - quotedOut;
  if (diff <= 0n) return 0;
  return Number((diff * 10_000n) / spotOut);
}

/** Rough gas for the whole launch, for the Wallet Cost Summary. Approvals ~55k, a v3 swap ~200k, deploySSR ~1.6M plus ~150k per leg. */
export function estimateLaunchGas(legCount: number, swapCount: number): bigint {
  const approvals = BigInt(swapCount > 0 ? 1 : 0) + BigInt(legCount);
  return approvals * 55_000n + BigInt(swapCount) * 200_000n + 1_600_000n + BigInt(legCount) * 150_000n;
}

/** Wallet prompts the launch will ask for, in order, so Review can list them like the Solana wizard does. */
export function launchSteps(plan: LaunchPlan): string[] {
  const swaps = plan.legs.filter((l) => l.kind === "swap");
  const steps: string[] = [];
  if (swaps.length > 0) {
    steps.push(`Approve ${fmtUsdg(plan.swapUsdgRaw)} USDG for the Uniswap router`);
    for (const s of swaps) steps.push(`Swap ${fmtUsdg(s.usdgRaw)} USDG for ${s.asset.symbol} (skipped if your wallet already holds enough)`);
  }
  for (const l of plan.legs) steps.push(`Approve ${l.asset.symbol} for the SSR factory`);
  steps.push("Deploy the reserve (moves the assets in and mints your Reserve Tokens)");
  return steps;
}

export function fmtUsdg(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
