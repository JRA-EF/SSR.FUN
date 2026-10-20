/**
 * Live liquidity client for the Manage Reserve Liquidity tab: reads the
 * creator's on-chain pool state through /api/mainnet/liquidity, validates the
 * server's prepared transactions, and derives the dashboard numbers (pool
 * liquidity, creator earnings, lock status, position). No '@/' imports so the
 * mocha suite can load it directly.
 */
import type {PreparedLiquidity} from '../../../../lib/mainnet/prepareCompound';
import {throwLiquidityResponse} from './liquiditySetupClient';
import {onLocalClock} from './liquidityExecution';

export interface LiveTranche{address:string;unlockTs:string;permanent:boolean;withdrawn:boolean;lpRaw:string;}
export interface LiveLiquidityState{
 reserve:string;creator:string;treasury:string;pool:string;hasPool:boolean;paused:boolean;executionEnabled:boolean;
 reserveDecimals:number;lpDecimals:number;
 usdcBalanceRaw:string;reserveBalanceRaw:string;lpBalanceRaw:string;
 nativeEarningsUsdcRaw:string;stagedEarningsUsdcRaw:string;
 poolUsdcRaw:string;poolReserveRaw:string;lpSupplyRaw:string;
 tranches:LiveTranche[];
 /** DEC-0251: the pool's permanent fee terms; 1 = created before liquidity terms v2, null = no pool. */
 termsVersion?:1|2|null;buyTaxBps?:number|null;sellTaxBps?:number|null;holderShareBps?:number;
 basketFeedUsdcRaw?:string;basketFedUsdcRaw?:string;
 /** Terms a new pool gets now: false until the DEC-0251 upgrade executes. */
 termsV2Available?:boolean;
}
export type LiveAction='create'|'add'|'withdraw'|'collect'|'lock'|'extend'|'unlock'|'permanent';
export type LockTerm='unlocked'|'1-month'|'3-month'|'6-month'|'12-month'|'permanent';
export type PreparedLiveLiquidity=PreparedLiquidity&{review:Record<string,string>;tranche?:string};

const RAW=/^\d{1,20}$/;

/** Decimal string -> raw integer string with `decimals` places. */
export function toRaw(value:string,decimals:number):string{
 if(!Number.isInteger(decimals)||decimals<0||decimals>18||!/^\d+(\.\d+)?$/.test(value.trim()))throw new Error('Enter a valid positive amount.');
 const [whole,fraction='']=value.trim().split('.');
 if(fraction.length>decimals)throw new Error(`Use at most ${decimals} decimal places.`);
 const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
 if(n<=0n||n>0xffffffffffffffffn)throw new Error('Amount is outside the supported range.');
 return n.toString();
}
/** Raw integer string -> trimmed decimal string. */
export function fromRaw(value:string|bigint,decimals:number):string{
 const n=BigInt(value),d=10n**BigInt(decimals),frac=decimals?(n%d).toString().padStart(decimals,'0').replace(/0+$/,''):'';
 return frac?`${n/d}.${frac}`:`${n/d}`;
}
export function rawToNumber(value:string|bigint,decimals:number):number{return Number(BigInt(value))/10**decimals;}

/** Throws unless the read payload is complete and belongs to this Reserve. */
export function checkLiveState(value:any,expected:{reserve:string;creator:string;treasury?:string}):LiveLiquidityState{
 if(!value||value.reserve!==expected.reserve||value.creator!==expected.creator||value.treasury!==expected.treasury||!Array.isArray(value.tranches))throw new Error('Liquidity identity changed; refresh the Reserve.');
 for(const n of [value.reserveDecimals,value.lpDecimals])if(!Number.isInteger(n)||n<0||n>18)throw new Error('Unsupported token precision.');
 for(const k of ['usdcBalanceRaw','reserveBalanceRaw','lpBalanceRaw','nativeEarningsUsdcRaw','stagedEarningsUsdcRaw','poolUsdcRaw','poolReserveRaw','lpSupplyRaw'])if(!RAW.test(String(value[k])))throw new Error('Invalid liquidity balance.');
 for(const k of ['basketFeedUsdcRaw','basketFedUsdcRaw'])if(value[k]!==undefined&&!RAW.test(String(value[k])))throw new Error('Invalid liquidity balance.');
 if(value.holderShareBps!==undefined&&(!Number.isInteger(value.holderShareBps)||value.holderShareBps<0||value.holderShareBps>10000))throw new Error('Invalid holder share.');
 for(const t of value.tranches)if(typeof t?.address!=='string'||!RAW.test(String(t.lpRaw))||!/^-?\d{1,20}$/.test(String(t.unlockTs)))throw new Error('Invalid liquidity lock.');
 return {...value,hasPool:!!value.hasPool,paused:!!value.paused,executionEnabled:value.executionEnabled===true};
}

/**
 * Throws unless the prepared transaction is the one asked for. The release
 * flag is reported by the server and enforced again at signing
 * (liquidityExecution.ts), so it only has to be a boolean here.
 */
export function checkPrepared(response:any,expected:{action:LiveAction;reserve:string;creator:string;treasury?:string;maximumSolRaw:string}):PreparedLiveLiquidity{
 const result=response&&typeof response==='object'?onLocalClock(response):response;
 if(result?.action!==expected.action||result.reserve!==expected.reserve||result.creator!==expected.creator||result.treasury!==expected.treasury||result.confirmationText!==expected.action.toUpperCase()||!(result.expiresAtMs>Date.now())||typeof result.executionEnabled!=='boolean'||!result.simulation?.passed)throw new Error('Liquidity review changed or has expired.');
 if(!RAW.test(String(result.totalSolRaw))||BigInt(result.totalSolRaw)>BigInt(expected.maximumSolRaw))throw new Error('Simulated SOL cost exceeds your cap.');
 return {...result,review:result.review??{}};
}

/** SOL cost cap used when the creator leaves it blank. A pool launch pays Raydium's 0.15 SOL creation fee plus ~0.04 SOL rent. */
export function defaultSolCap(action:LiveAction):string{return action==='create'?'0.30':'0.05';}

export async function postLiquidity(body:unknown):Promise<any>{
 const response=await fetch('/api/mainnet/liquidity',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throwLiquidityResponse(result,'Liquidity request unavailable.');
 return result;
}

export const LOCK_TERM_DAYS:Record<Exclude<LockTerm,'unlocked'|'permanent'>,number>={'1-month':30,'3-month':90,'6-month':180,'12-month':365};

export interface LiquiditySummary{
 poolUsdc:number;poolTokens:number;tvlUsd:number;marketPrice:number|null;premiumPct:number|null;
 earningsUsdc:number;
 unlockedLp:bigint;timedLockedLp:bigint;activeTimed:LiveTranche[];expiredTimed:LiveTranche[];permanentCount:number;
 /** Share of the creator's withdrawable-or-timed position that is time-locked (0-100). Permanent locks are counted separately. */
 lockedPct:number;nextUnlockMs:number|null;
 positionLp:bigint;sharePct:number;positionUsdc:number;positionTokens:number;
}
/** What burning `lpRaw` returns at the pool's current balances: USDC, and Reserve Tokens after the 0.15% transfer fee. */
export function withdrawPreview(s:Pick<LiveLiquidityState,'poolUsdcRaw'|'poolReserveRaw'|'lpSupplyRaw'|'reserveDecimals'>,lpRaw:bigint):{usdc:number;tokens:number}{
 const supply=BigInt(s.lpSupplyRaw);if(lpRaw<=0n||supply<=0n)return {usdc:0,tokens:0};
 const usdcRaw=lpRaw*BigInt(s.poolUsdcRaw)/supply,tokenRaw=lpRaw*BigInt(s.poolReserveRaw)/supply;
 return {usdc:rawToNumber(usdcRaw.toString(),6),tokens:rawToNumber((tokenRaw-(tokenRaw*15n+9999n)/10000n).toString(),s.reserveDecimals)};
}
export function summarizeLiquidity(s:LiveLiquidityState,navPerToken:number,nowMs=Date.now()):LiquiditySummary{
 const poolUsdc=rawToNumber(s.poolUsdcRaw,6),poolTokens=rawToNumber(s.poolReserveRaw,s.reserveDecimals);
 const marketPrice=poolTokens>0?poolUsdc/poolTokens:null;
 const live=s.tranches.filter(t=>!t.withdrawn);
 const timed=live.filter(t=>!t.permanent&&BigInt(t.lpRaw)>0n);
 const activeTimed=timed.filter(t=>Number(t.unlockTs)*1000>nowMs),expiredTimed=timed.filter(t=>Number(t.unlockTs)*1000<=nowMs);
 const timedLockedLp=activeTimed.reduce((a,t)=>a+BigInt(t.lpRaw),0n),expiredLp=expiredTimed.reduce((a,t)=>a+BigInt(t.lpRaw),0n);
 const unlockedLp=BigInt(s.lpBalanceRaw);
 const positionLp=unlockedLp+timedLockedLp+expiredLp,supply=BigInt(s.lpSupplyRaw);
 const share=supply>0n?Number(positionLp*1_000_000n/supply)/1_000_000:0;
 const lockable=positionLp;
 return {
  poolUsdc,poolTokens,tvlUsd:marketPrice===null?0:poolUsdc*2,marketPrice,
  premiumPct:marketPrice!==null&&navPerToken>0?((marketPrice-navPerToken)/navPerToken)*100:null,
  earningsUsdc:rawToNumber(BigInt(s.nativeEarningsUsdcRaw)+BigInt(s.stagedEarningsUsdcRaw),6),
  unlockedLp,timedLockedLp,activeTimed,expiredTimed,permanentCount:live.filter(t=>t.permanent).length,
  lockedPct:lockable>0n?Number(timedLockedLp*10_000n/lockable)/100:0,
  nextUnlockMs:activeTimed.length?Math.min(...activeTimed.map(t=>Number(t.unlockTs)*1000)):null,
  positionLp,sharePct:share*100,positionUsdc:poolUsdc*share,positionTokens:poolTokens*share,
 };
}
