// Buying Reserve assets with USDG on Uniswap v3 (Robinhood Chain) for the
// Launch flow -- the EVM counterpart of the Jupiter swaps a Solana launch
// runs. Quotes come from QuoterV2 (an eth_call, no state change); swaps go
// through SwapRouter02's exactInputSingle (USDG-quoted pools) or exactInput
// over USDG -> WETH -> token (WETH-quoted pools, which is where graduated
// launchpad tokens trade). Addresses: developers.uniswap.org, v3
// deployments, Robinhood Chain (4663).
//
// The router is never given an unlimited allowance: it is approved for
// exactly the USDG the swaps will spend, and every swap carries a minimum
// output (src/merge/lib/evmLaunchPlan.ts's slippage rule).
import { encodePacked, parseAbi, zeroAddress, type Address, type PublicClient, type WalletClient } from "viem";
import { ERC20_ABI, UNISWAP_V3, USDG, WETH, type ChainConfig } from "./evmChain";
import { describeEvmError } from "./evmReserve";

export const UNISWAP_V3_QUOTER_V2: Address = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
export const UNISWAP_V3_SWAP_ROUTER_02: Address = "0xcaf681a66d020601342297493863e78c959e5cb2";

export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);

/** SwapRouter02: no deadline field (unlike the v1 router). */
export const SWAP_ROUTER_02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
]);

const V3_FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const V3_POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);

export interface SwapRoute {
  tokenOut: Address;
  /** Fee tier of the token's own pool. */
  fee: number;
  quote: "USDG" | "WETH";
  /** Fee tier of the USDG/WETH hop, for WETH-quoted tokens. */
  wethHopFee?: number;
}

let wethHopFeeCache: number | null = null;

/** The deepest USDG/WETH pool's fee tier -- the first hop of every WETH-quoted buy. */
export async function bestWethHopFee(pc: PublicClient): Promise<number> {
  if (wethHopFeeCache !== null) return wethHopFeeCache;
  const pools = await Promise.all(
    UNISWAP_V3.fees.map(async (fee) => {
      const p = await pc.readContract({ address: UNISWAP_V3.factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [USDG, WETH, fee] });
      if (p === zeroAddress) return { fee, liq: 0n };
      const liq = await pc.readContract({ address: p, abi: V3_POOL_ABI, functionName: "liquidity" }).catch(() => 0n);
      return { fee, liq };
    }),
  );
  const best = pools.reduce((a, b) => (b.liq > a.liq ? b : a));
  if (best.liq === 0n) throw new Error("No USDG/WETH pool with liquidity was found on Robinhood Chain.");
  wethHopFeeCache = best.fee;
  return best.fee;
}

export async function routeFor(pc: PublicClient, tokenOut: Address, pool: { fee: number; quote: "USDG" | "WETH" }): Promise<SwapRoute> {
  if (pool.quote === "USDG") return { tokenOut, fee: pool.fee, quote: "USDG" };
  return { tokenOut, fee: pool.fee, quote: "WETH", wethHopFee: await bestWethHopFee(pc) };
}

/** Uniswap's packed path: tokenIn (20) fee (3) tokenOut (20) [fee (3) token (20)]. */
export function encodeSwapPath(route: SwapRoute): `0x${string}` {
  if (route.quote === "USDG") return encodePacked(["address", "uint24", "address"], [USDG, route.fee, route.tokenOut]);
  if (route.wethHopFee === undefined) throw new Error("A WETH-quoted route needs the USDG/WETH hop fee.");
  return encodePacked(["address", "uint24", "address", "uint24", "address"], [USDG, route.wethHopFee, WETH, route.fee, route.tokenOut]);
}

/** Expected output of spending `amountInUsdg` (raw) on the route, from QuoterV2 (eth_call; nothing is sent). */
export async function quoteExactUsdgIn(pc: PublicClient, route: SwapRoute, amountInUsdg: bigint): Promise<bigint> {
  try {
    if (route.quote === "USDG") {
      const { result } = await pc.simulateContract({
        address: UNISWAP_V3_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: USDG, tokenOut: route.tokenOut, amountIn: amountInUsdg, fee: route.fee, sqrtPriceLimitX96: 0n }],
      });
      return result[0];
    }
    const { result } = await pc.simulateContract({ address: UNISWAP_V3_QUOTER_V2, abi: QUOTER_V2_ABI, functionName: "quoteExactInput", args: [encodeSwapPath(route), amountInUsdg] });
    return result[0];
  } catch (e) {
    throw new Error(`Uniswap could not quote this buy (${describeEvmError(e)}). The pool may have no liquidity in range right now.`);
  }
}

/** Sends the swap from the user's wallet; resolves with the tx hash once mined. Gas is estimated here and passed explicitly so the wallet does not have to. */
export async function swapExactUsdgIn(
  pc: PublicClient,
  wallet: WalletClient,
  cfg: ChainConfig,
  account: Address,
  route: SwapRoute,
  amountInUsdg: bigint,
  minOut: bigint,
): Promise<`0x${string}`> {
  const base = { address: UNISWAP_V3_SWAP_ROUTER_02, abi: SWAP_ROUTER_02_ABI, account, chain: cfg.chain } as const;
  // Simulate first: a revert here is reported with its reason and costs
  // nothing; gas is estimated here and handed to the wallet explicitly.
  let hash: `0x${string}`;
  if (route.quote === "USDG") {
    const call = {
      ...base,
      functionName: "exactInputSingle",
      args: [{ tokenIn: USDG, tokenOut: route.tokenOut, fee: route.fee, recipient: account, amountIn: amountInUsdg, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    } as const;
    const { request } = await pc.simulateContract(call);
    const gas = await pc.estimateContractGas(call);
    hash = await wallet.writeContract({ ...request, gas: (gas * 125n) / 100n });
  } else {
    const call = { ...base, functionName: "exactInput", args: [{ path: encodeSwapPath(route), recipient: account, amountIn: amountInUsdg, amountOutMinimum: minOut }] } as const;
    const { request } = await pc.simulateContract(call);
    const gas = await pc.estimateContractGas(call);
    hash = await wallet.writeContract({ ...request, gas: (gas * 125n) / 100n });
  }
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}

export async function erc20Balance(pc: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return pc.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
}
