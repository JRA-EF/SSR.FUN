/**
 * DEC-0251: the creator's pool fee terms as the liquidity launch collects
 * them, and the illustrative per-trade split shown next to the controls.
 * No '@/' imports so server tests can load it.
 */
/** `poolSharePct` (DEC-0255): of the holder share, the part added to the pool as locked liquidity; the rest goes to backing. */
export interface FeeTermsValue{buyTaxPct:number;sellTaxPct:number;shareWithHolders:boolean;holderSharePct:number;poolSharePct:number;}
export const DEFAULT_FEE_TERMS:FeeTermsValue={buyTaxPct:0,sellTaxPct:0,shareWithHolders:false,holderSharePct:50,poolSharePct:0};

/** Raydium's creator fee on SSR pools (0.75%) after Raydium keeps 5% of it. */
export const CREATOR_FEE_NET_PCT=0.75*0.95;
/** SSR's share of everything the creator earns from the pool. */
export const SSR_SHARE=0.2;
export const EXAMPLE_TRADE_USD=1000;

export function feeTermsToBps(v:FeeTermsValue){
 return {buyTaxBps:Math.round(v.buyTaxPct*100),sellTaxBps:Math.round(v.sellTaxPct*100),holderShareBps:v.shareWithHolders?Math.round(v.holderSharePct*100):0,
  poolShareBps:v.shareWithHolders?Math.round(v.poolSharePct*100):0};
}
/** What one example trade earns, split the way the program splits it. */
export function exampleSplit(taxPct:number,v:FeeTermsValue,tradeUsd=EXAMPLE_TRADE_USD){
 const earned=tradeUsd*(CREATOR_FEE_NET_PCT+taxPct)/100,ssr=earned*SSR_SHARE,holders=v.shareWithHolders?(earned-ssr)*v.holderSharePct/100:0;
 const pool=holders*(v.poolSharePct??0)/100;
 return {ssr,holders,backing:holders-pool,pool,creator:earned-ssr-holders};
}
