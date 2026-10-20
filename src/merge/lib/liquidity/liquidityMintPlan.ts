/** Minting the missing Reserve Tokens before a pool launch or addition. Pure: no wallet or network. */

/** Headroom on the token target: NAV and the pool ratio move between the mint and the liquidity review. */
export const LIQUIDITY_MINT_HEADROOM_BPS=200n;
/** Token-2022 transfer fee charged as the Reserve Tokens move into the pool (0.15%). */
export const RESERVE_TRANSFER_FEE_BPS=15n;
/** The mint's own swap buffer (multiAssetBuyPlan.ts BUY_SWAP_BUFFER_FRACTION) -- unused USDC stays in the wallet. */
const MINT_SWAP_BUFFER_BPS=200n;

const ceilDiv=(a:bigint,b:bigint)=>(a+b-1n)/b;
const toRawUnits=(value:number,decimals:number)=>BigInt(Math.ceil(value*10**decimals));

/** Gross Reserve Tokens a pool launch debits for a USDC side at NAV, including the transfer fee. */
export function launchTokensNeededRaw(usdcSide:number,nav:number,decimals:number):bigint{
 if(!(usdcSide>0)||!(nav>0))return 0n;
 return ceilDiv(toRawUnits(usdcSide/nav,decimals)*(10000n+RESERVE_TRANSFER_FEE_BPS),10000n);
}

/** Reserve Tokens to mint so the treasury covers `neededRaw` with headroom; 0 when it already does. */
export function mintShortfallRaw(neededRaw:bigint,heldRaw:bigint):bigint{
 if(neededRaw<=0n||heldRaw>=neededRaw)return 0n;
 return ceilDiv(neededRaw*(10000n+LIQUIDITY_MINT_HEADROOM_BPS),10000n)-heldRaw;
}

/** Upper estimate of the USDC the mint spends: tokens at NAV, plus the effective mint fee and the swap buffer. */
export function mintUsdcEstimate(tokensRaw:bigint,decimals:number,nav:number,mintFeeBps:number):number{
 if(tokensRaw<=0n||!(nav>0))return 0;
 const tokens=Number(tokensRaw)/10**decimals,bps=Number(MINT_SWAP_BUFFER_BPS)+Math.max(0,mintFeeBps);
 return tokens*nav*(1+bps/10000);
}

export interface LiquidityMintPlan{
 /** Reserve Tokens to mint first (raw); 0 = the treasury already holds enough. */
 mintRaw:bigint;
 /** Estimated USDC the mint spends. */
 mintUsdc:number;
 /** USDC the treasury needs in total: the mint plus the pool's USDC side. */
 totalUsdc:number;
 usdcShort:boolean;
}
export function planLiquidityMint(p:{neededRaw:bigint;heldRaw:bigint;usdcSide:number;usdcHeld:number;decimals:number;nav:number;mintFeeBps:number}):LiquidityMintPlan{
 const mintRaw=mintShortfallRaw(p.neededRaw,p.heldRaw),mintUsdc=mintUsdcEstimate(mintRaw,p.decimals,p.nav,p.mintFeeBps),totalUsdc=p.usdcSide+mintUsdc;
 return {mintRaw,mintUsdc,totalUsdc,usdcShort:totalUsdc>p.usdcHeld};
}
