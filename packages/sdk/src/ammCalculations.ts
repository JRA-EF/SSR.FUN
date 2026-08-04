// Pure quote math for ssr_devnet_amm -- mirrors
// programs/ssr_devnet_amm/src/instructions/common.rs's
// constant_product_amount_out EXACTLY (same formula, same floor rounding)
// so client-side quotes always match what the program will actually
// compute on-chain. See DEC-0051: this is a real, documented,
// deterministic pricing model (x*y=k over live vault balances), never a
// fabricated number.
import { mulDivFloor } from "./calculations";

export const AMM_BPS_DENOMINATOR = 10_000n;

export interface AmmSwapQuote {
  feeAmount: bigint;
  amountInAfterFee: bigint;
  amountOut: bigint;
}

/** Quotes a swap given live pool reserves (read directly from vault balances -- never cached/assumed). Throws if reserves are zero (no liquidity yet). */
export function quoteAmmSwap(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): AmmSwapQuote {
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error("This pool has no liquidity yet -- cannot quote a swap.");
  }
  const feeAmount = mulDivFloor(amountIn, feeBps, AMM_BPS_DENOMINATOR);
  const amountInAfterFee = amountIn - feeAmount;
  const k = reserveIn * reserveOut;
  const newReserveIn = reserveIn + amountInAfterFee;
  const newReserveOut = k / newReserveIn;
  const amountOut = reserveOut - newReserveOut;
  return { feeAmount, amountInAfterFee, amountOut };
}

/** Applies a fractional slippage buffer to a quoted amountOut, producing the minimumAmountOut to pass on-chain (e.g. 0.01 = 1% tolerance). */
export function applySlippageToMinOut(amountOut: bigint, slippageFraction: number): bigint {
  const bps = BigInt(Math.round(slippageFraction * 10_000));
  return mulDivFloor(amountOut, 10_000n - bps, 10_000n);
}
