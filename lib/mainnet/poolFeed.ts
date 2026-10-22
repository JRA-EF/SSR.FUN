// DEC-0255: the keeper's pool leg. For a pool whose creator chose to send part
// of the holder share into the pool (LiquiditySplit), the keeper takes up to
// the pool's share of what has been released, swaps about half of it into
// Reserve Tokens on the pool and deposits both sides, in ONE transaction:
//   [pool_feed_begin -> Raydium swap_base_input -> Raydium deposit -> pool_feed_end]
// begin lends the USDC, end locks the new LP in the split's own account (no
// instruction can move it out), refuses fewer LP than the planned amount, and
// returns what the deposit did not use.
//
// NAV guard: the leg runs only while the pool trades within 1% of the
// Reserve's backing value (NAV). Off NAV, adding liquidity at the pool's
// ratio would hand the gap to the first arbitrageur, so that run's pool part
// goes to backing instead; the program lets the pool catch up later, never
// past its share.
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, type TransferFee } from "@solana/spl-token";
import { buildCpmmDeposit, buildCpmmSwapBaseInput, buildPoolFeedBegin, buildPoolFeedEnd, findSettlementKeeperConfig, type CpmmAccounts } from "@ssr/sdk";
import { LIQUIDITY_USDC, SSR_CPMM_CONFIG } from "../../src/merge/lib/liquidity/raydiumCpmm";
import { transferNet } from "./compoundQuotes";

/** Raydium SSR config: 0.25% trade fee + 0.75% creator fee, both on the input (decodeConfig refuses any other numbers). */
export const POOL_INPUT_FEE_PPM = 10_000n;
/** The pool leg runs only while |pool price / NAV - 1| <= this. */
export const POOL_NAV_LIMIT_PCT = 1;
/** One leg moves at most 2% of the pool's USDC side (about 1% price impact for the swap half). */
export const POOL_LEG_MAX_SHARE_BPS = 200n;
/** Margin taken off the deposit so rounding and the trade fee left in the pool never push it over what the keeper holds. */
const DEPOSIT_MARGIN_BPS = 30n;
const SWAP_SLIPPAGE_BPS = 50n;

export function poolNavDeviationPct(poolUsdcRaw: bigint, poolTokensRaw: bigint, navUsdc: number): number | null {
  if (poolUsdcRaw <= 0n || poolTokensRaw <= 0n || !(navUsdc > 0)) return null;
  return (Number(poolUsdcRaw) / Number(poolTokensRaw) / navUsdc - 1) * 100;
}

/** USDC to swap so the remaining USDC and the bought tokens match the pool's ratio after the swap (fee-aware zap). */
export function zapSwapAmount(amount: bigint, poolUsdc: bigint, feePpm = POOL_INPUT_FEE_PPM): bigint {
  const r = Number(1_000_000n - feePpm) / 1e6, u = Number(poolUsdc), a = Number(amount);
  const s = (Math.sqrt(u * u * (1 + r) ** 2 + 4 * r * a * u) - u * (1 + r)) / (2 * r);
  const out = BigInt(Math.floor(s));
  return out < 1n ? 1n : out >= amount ? amount - 1n : out;
}

export interface PoolLegPlan { amountIn: bigint; swapIn: bigint; minTokensOut: bigint; lp: bigint; maxUsdc: bigint; maxTokens: bigint }

/**
 * Plans one pool leg of `amount` USDC against reserves `usdc`/`tokens` (fees
 * already excluded) and `lpSupply`. Every bound is conservative: the swap
 * minimum allows 0.5% slippage, the deposit asks 0.3% fewer LP than the held
 * amounts allow, and the caps are what the keeper is guaranteed to hold.
 */
export function planPoolLeg(amount: bigint, s: { usdc: bigint; tokens: bigint; lpSupply: bigint; fee: TransferFee | null }): PoolLegPlan | null {
  if (amount <= 1n || s.usdc <= 0n || s.tokens <= 0n || s.lpSupply <= 0n) return null;
  const swapIn = zapSwapAmount(amount, s.usdc);
  const net = swapIn * (1_000_000n - POOL_INPUT_FEE_PPM) / 1_000_000n;
  const out = s.tokens * net / (s.usdc + net);
  const minTokensOut = transferNet(out, s.fee) * (10_000n - SWAP_SLIPPAGE_BPS) / 10_000n;
  if (minTokensOut <= 0n) return null;
  // After the swap the vault holds at most every input unit and exactly `out` fewer tokens.
  const usdcAfter = s.usdc + swapIn, tokensAfter = s.tokens - out, maxUsdc = amount - swapIn;
  const byUsdc = maxUsdc * s.lpSupply / usdcAfter, byTokens = transferNet(minTokensOut, s.fee) * s.lpSupply / tokensAfter;
  const lp = (byUsdc < byTokens ? byUsdc : byTokens) * (10_000n - DEPOSIT_MARGIN_BPS) / 10_000n;
  if (lp <= 0n) return null;
  return { amountIn: amount, swapIn, minTokensOut, lp, maxUsdc, maxTokens: minTokensOut };
}

/** The leg's instructions, without compute budget: begin, swap, deposit, end (plus idempotent keeper accounts). */
export function buildPoolFeedInstructions(p: {
  programId: PublicKey; reserve: PublicKey; reserveMint: PublicKey; keeper: PublicKey; accounts: CpmmAccounts; plan: PoolLegPlan;
}): TransactionInstruction[] {
  const { keeper, accounts: a, plan } = p;
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), a.pool.toBuffer()], new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"))[0];
  const keeperUsdc = getAssociatedTokenAddressSync(LIQUIDITY_USDC, keeper);
  const keeperReserveToken = getAssociatedTokenAddressSync(p.reserveMint, keeper, false, TOKEN_2022_PROGRAM_ID);
  const keeperLp = getAssociatedTokenAddressSync(lpMint, keeper);
  const usdc0 = a.mint0.equals(LIQUIDITY_USDC);
  return [
    createAssociatedTokenAccountIdempotentInstruction(keeper, keeperUsdc, keeper, LIQUIDITY_USDC),
    createAssociatedTokenAccountIdempotentInstruction(keeper, keeperReserveToken, keeper, p.reserveMint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(keeper, keeperLp, keeper, lpMint, TOKEN_PROGRAM_ID),
    buildPoolFeedBegin({ programId: p.programId, reserve: p.reserve, pool: a.pool, keeper, settlementKeeperConfig: findSettlementKeeperConfig(p.programId)[0],
      keeperUsdc, keeperReserveToken, keeperLp, amountIn: plan.amountIn, minLp: plan.lp }),
    buildCpmmSwapBaseInput(a, keeper, SSR_CPMM_CONFIG, LIQUIDITY_USDC, plan.swapIn, plan.minTokensOut),
    buildCpmmDeposit(a, keeper, plan.lp, usdc0 ? plan.maxUsdc : plan.maxTokens, usdc0 ? plan.maxTokens : plan.maxUsdc),
    buildPoolFeedEnd({ programId: p.programId, reserve: p.reserve, pool: a.pool, reserveMint: p.reserveMint, reserveTokenProgram: TOKEN_2022_PROGRAM_ID,
      keeper, keeperUsdc, keeperReserveToken, keeperLp }),
  ];
}
