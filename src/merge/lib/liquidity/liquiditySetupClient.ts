import {PublicKey} from '@solana/web3.js';
export class LiquiditySetupNeeded extends Error{readonly addresses:string[];constructor(addresses:string[]){super('One-time transaction setup is needed before this operation can fit atomically.');this.addresses=addresses;}}
export function throwLiquidityResponse(result:any,fallback:string):never{
 if(result?.code==='LIQUIDITY_LOOKUP_REQUIRED'&&Array.isArray(result.addresses)&&result.addresses.length<=128){const addresses=result.addresses.map((a:any)=>new PublicKey(a).toBase58());throw new LiquiditySetupNeeded(addresses);}
 throw new Error(typeof result?.error==='string'?result.error:fallback);
}
export function liquidityTableKey(reserve:string){return `ssr-liquidity-table:${reserve}`;}
export function savedLiquidityTables(reserve:string):string[]{const table=localStorage.getItem(liquidityTableKey(reserve));return table?[new PublicKey(table).toBase58()]:[];}
