/**
 * Live liquidity forms used by LiveLiquiditySection (Manage Reserve ->
 * Liquidity). Each form only collects inputs and calls onPrepare; the section
 * owns the server request, validation and the signing review.
 */
import {useState,type ReactNode} from 'react';
import {AlertCircle,Droplets,Lock,Unlock} from 'lucide-react';
import type {DTR} from '@/lib/types';
import {formatUsdc} from '@/lib/calculations';
import {LOCK_MONTH_PRESETS,MIN_LIQUIDITY_USD,QUICK_AMOUNTS_USD,RECOMMENDED_LIQUIDITY_USD} from '@/lib/liquidityPreview';
import {fromRaw,rawToNumber,toRaw,type LiveLiquidityState,type LockTerm,type LiquiditySummary} from '../lib/liquidity/liveLiquidityClient';
import {DEFAULT_FEE_TERMS,feeTermsToBps,type FeeTermsValue} from '../lib/liquidity/feeTerms';
import {LiquidityFeeTerms} from './LiquidityFeeTerms';
import {LiquidityMintStep} from './LiquidityMintStep';
import {launchTokensNeededRaw,planLiquidityMint} from '../lib/liquidity/liquidityMintPlan';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Label} from './ui/label';

export type PrepareFn=(action:'create'|'add'|'withdraw'|'lock',extras:Record<string,unknown>)=>void;

const pill=(active:boolean)=>`px-4 py-2 rounded-full text-sm border transition-colors ${active?'bg-primary/10 text-primary border-primary/40':'border-border text-muted-foreground hover:bg-muted'}`;
const monthsToTerm=(m:number)=>`${m}-month` as LockTerm;

/** No lock / timed (1-12 months) / forever -- the design's three lock cards. */
export function LockChoice({value,onChange,allowNone=true,disabled}:{value:LockTerm;onChange:(t:LockTerm)=>void;allowNone?:boolean;disabled?:boolean}){
 const mode=value==='unlocked'?'none':value==='permanent'?'permanent':'timed';
 const choices=[
  ...(allowNone?[{mode:'none',title:'No lock',body:'You can withdraw anytime. The weakest trust signal for holders.',icon:Unlock,term:'unlocked' as LockTerm}]:[]),
  {mode:'timed',title:'Lock for a period',body:'Held until the unlock date. You can extend later, never shorten. Trading fees stay yours throughout.',icon:Lock,term:'12-month' as LockTerm},
  {mode:'permanent',title:'Lock forever',body:'Permanent. You keep earning trading fees and can collect them anytime, but can never withdraw.',icon:Lock,term:'permanent' as LockTerm},
 ];
 return <div className={`grid grid-cols-1 gap-3 ${allowNone?'md:grid-cols-3':'md:grid-cols-2'}`}>
  {choices.map(c=>{const Icon=c.icon,active=mode===c.mode;return(
   <button key={c.mode} type="button" disabled={disabled} onClick={()=>{if(!active)onChange(c.term);}} className={`text-left rounded-lg border p-3 transition-colors ${active?'border-primary/50 bg-primary/10':'border-border hover:bg-muted'}`}>
    <Icon className={`w-4 h-4 mb-1.5 ${active?'text-primary':'text-muted-foreground'}`}/>
    <p className={`text-sm font-medium ${active?'text-foreground':'text-muted-foreground'}`}>{c.title}</p>
    {c.mode==='timed'&&active?<span className="mt-2 flex flex-wrap gap-1.5">{LOCK_MONTH_PRESETS.map(m=>
     <span key={m} role="button" tabIndex={0} onClick={e=>{e.stopPropagation();onChange(monthsToTerm(m));}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.stopPropagation();onChange(monthsToTerm(m));}}}
      className={`px-2 py-0.5 rounded-full text-xs font-merge-mono border cursor-pointer ${value===monthsToTerm(m)?'bg-primary text-primary-foreground border-primary':'border-border text-muted-foreground'}`}>{m}m</span>)}</span>
     :<p className="text-xs text-muted-foreground mt-1">{c.body}</p>}
   </button>);})}
 </div>;
}

function TreasuryLine({dtr,state}:{dtr:DTR;state:LiveLiquidityState}){
 return <p className="text-xs text-muted-foreground">Creator treasury holds {formatUsdc(rawToNumber(state.usdcBalanceRaw,6))} USDC and {Number(fromRaw(state.reserveBalanceRaw,state.reserveDecimals)).toLocaleString(undefined,{maximumFractionDigits:2})} {dtr.ticker}. Liquidity is funded from the treasury, separate from your Reserve backing.</p>;
}
function Warning({children}:{children:ReactNode}){
 return <div className="bg-destructive/10 text-destructive p-3 rounded text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0"/>{children}</div>;
}

const mintFeeBps=(dtr:DTR)=>Number(dtr.onChain?.effectiveMintFeeTotalBps??dtr.onChain?.mintFeeBps??0);

/** No pool yet: launch the canonical Raydium pool at the Reserve Token's backing value. */
export function CreatePoolForm({dtr,state,nav,busy,onPrepare,refresh}:{dtr:DTR;state:LiveLiquidityState;nav:number;busy:boolean;onPrepare:PrepareFn;refresh:()=>Promise<void>}){
 const [total,setTotal]=useState(RECOMMENDED_LIQUIDITY_USD),[customOpen,setCustomOpen]=useState(false),[custom,setCustom]=useState('');
 const [lock,setLock]=useState<LockTerm>('12-month'),[terms,setTerms]=useState<FeeTermsValue>(DEFAULT_FEE_TERMS);
 const [error,setError]=useState('');
 const v2=state.termsV2Available!==false;
 const effective=customOpen?Math.max(0,Number(custom)||0):total,usdcSide=effective/2,tokens=nav>0?usdcSide/nav:0;
 const usdcHeld=rawToNumber(state.usdcBalanceRaw,6);
 const mint=planLiquidityMint({neededRaw:launchTokensNeededRaw(usdcSide,nav,state.reserveDecimals),heldRaw:BigInt(state.reserveBalanceRaw),usdcSide,usdcHeld,decimals:state.reserveDecimals,nav,mintFeeBps:mintFeeBps(dtr)});
 const short=mint.mintRaw===0n&&usdcSide>usdcHeld;
 const submit=()=>{setError('');try{
  onPrepare('create',{maximumUsdcRaw:toRaw(usdcSide.toFixed(6),6),...feeTermsToBps(v2?terms:{...terms,shareWithHolders:false}),lock});
 }catch(e){setError(e instanceof Error?e.message:'Check the amounts.');}};
 return <div className="space-y-5">
  <div className="space-y-2">
   <Label className="text-xs uppercase tracking-wider text-muted-foreground">Total liquidity</Label>
   <div className="flex flex-wrap gap-2">
    {QUICK_AMOUNTS_USD.map(amt=><button key={amt} type="button" onClick={()=>{setTotal(amt);setCustomOpen(false);}} className={`${pill(!customOpen&&total===amt)} font-merge-mono inline-flex items-center gap-2`}>
     {formatUsdc(amt,{compact:true})}{amt===RECOMMENDED_LIQUIDITY_USD&&<span className="text-[9px] uppercase tracking-wider text-primary">Recommended</span>}</button>)}
    <button type="button" onClick={()=>setCustomOpen(true)} className={pill(customOpen)}>Custom</button>
   </div>
   {customOpen&&<Input type="number" min={0} placeholder="Total in USD" value={custom} onChange={e=>setCustom(e.target.value)} className="max-w-[240px] font-merge-mono"/>}
  </div>
  <div className="rounded-lg border border-border divide-y divide-border">
   <div className="flex items-center justify-between p-3"><div><p className="font-medium text-sm">{dtr.ticker}</p><p className="text-xs text-muted-foreground">Reserve Token</p></div>
    <div className="text-right"><p className="font-merge-mono text-base">≈ {tokens.toLocaleString(undefined,{maximumFractionDigits:2})}</p><p className="text-xs text-muted-foreground">≈ {formatUsdc(usdcSide)}</p></div></div>
   <div className="flex items-center justify-between p-3"><div><p className="font-medium text-sm">USDC</p><p className="text-xs text-muted-foreground">Pairing asset</p></div>
    <div className="text-right"><p className="font-merge-mono text-base">{formatUsdc(usdcSide).replace('$','')}</p><p className="text-xs text-muted-foreground">≈ {formatUsdc(usdcSide)}</p></div></div>
  </div>
  <p className="text-xs text-muted-foreground -mt-3">Both sides are balanced at the Reserve Token's current backing value ({formatUsdc(nav)} per token), so the pool opens at fair value instead of gifting an instant profit to arbitrage bots. The exact token amount is fixed in the review.</p>
  <TreasuryLine dtr={dtr} state={state}/>
  <div className="space-y-2"><Label className="text-xs uppercase tracking-wider text-muted-foreground">Lock your liquidity</Label><LockChoice value={lock} onChange={setLock} disabled={busy}/></div>
  <div className="border-t border-border pt-5"><LiquidityFeeTerms value={terms} onChange={setTerms} disabled={busy} v2={v2}/></div>
  {effective>0&&effective<MIN_LIQUIDITY_USD&&<Warning>Pools under {formatUsdc(MIN_LIQUIDITY_USD,{compact:true})} produce unstable pricing and a poor chart. We recommend at least {formatUsdc(RECOMMENDED_LIQUIDITY_USD,{compact:true})} in total.</Warning>}
  {short&&<Warning>The creator treasury does not hold enough USDC for this amount yet.</Warning>}
  {mint.mintRaw>0n&&<LiquidityMintStep dtr={dtr} state={state} plan={mint} disabled={busy} onMinted={()=>void refresh().then(submit)}/>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Button className="w-full" size="lg" disabled={busy||effective<=0||mint.mintRaw>0n} onClick={submit}><Droplets className="w-4 h-4 mr-2"/>{busy?'Preparing review…':'Review pool launch on Raydium'}</Button>
  <p className="text-xs text-muted-foreground">Reviewing simulates the transaction first. Nothing moves until the required wallets sign.</p>
 </div>;
}

/** Add to the existing pool at its current ratio. */
export function AddLiquidityForm({dtr,state,summary,busy,onPrepare,refresh}:{dtr:DTR;state:LiveLiquidityState;summary:LiquiditySummary;busy:boolean;onPrepare:PrepareFn;refresh:()=>Promise<void>}){
 const [usdc,setUsdc]=useState(''),[lock,setLock]=useState<LockTerm>('unlocked'),[error,setError]=useState('');
 const ratio=summary.poolUsdc>0?summary.poolTokens/summary.poolUsdc:0,tokens=(Number(usdc)||0)*ratio;
 // The server checks the treasury against the token cap below (tokens + 1%), so that is what must be held.
 const neededRaw=tokens>0?BigInt(toRaw((tokens*1.01).toFixed(state.reserveDecimals),state.reserveDecimals)):0n;
 const mint=planLiquidityMint({neededRaw,heldRaw:BigInt(state.reserveBalanceRaw),usdcSide:Number(usdc)||0,usdcHeld:rawToNumber(state.usdcBalanceRaw,6),decimals:state.reserveDecimals,nav:dtr.nav>0?dtr.nav:dtr.tokenPrice,mintFeeBps:mintFeeBps(dtr)});
 const submit=()=>{setError('');try{
  // The pool takes whichever side binds first; 1% headroom on the token cap keeps the USDC amount the binding one.
  onPrepare('add',{maximumUsdcRaw:toRaw(usdc,6),maximumReserveRaw:toRaw((tokens*1.01).toFixed(state.reserveDecimals),state.reserveDecimals),lock});
 }catch(e){setError(e instanceof Error?e.message:'Check the amounts.');}};
 return <div className="space-y-4">
  <div className="space-y-1"><Label htmlFor="liquidity-add-usdc">USDC to add</Label><Input id="liquidity-add-usdc" value={usdc} onChange={e=>setUsdc(e.target.value)} inputMode="decimal" placeholder="0.00" className="max-w-[240px] font-merge-mono" disabled={busy}/></div>
  <p className="text-sm">Paired with ≈ <span className="font-merge-mono">{tokens.toLocaleString(undefined,{maximumFractionDigits:2})} {dtr.ticker}</span> at the pool's current price.</p>
  <TreasuryLine dtr={dtr} state={state}/>
  <div className="space-y-2"><Label className="text-xs uppercase tracking-wider text-muted-foreground">Lock this addition</Label><LockChoice value={lock} onChange={setLock} disabled={busy}/></div>
  {mint.mintRaw>0n&&<LiquidityMintStep dtr={dtr} state={state} plan={mint} disabled={busy} onMinted={()=>void refresh().then(submit)}/>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Button disabled={busy||!usdc||mint.mintRaw>0n} onClick={submit}><Droplets className="w-3.5 h-3.5 mr-1.5"/>{busy?'Preparing review…':'Review add liquidity'}</Button>
 </div>;
}

/** Withdraw unlocked LP back to the creator treasury. */
export function WithdrawForm({state,summary,busy,onPrepare}:{state:LiveLiquidityState;summary:LiquiditySummary;busy:boolean;onPrepare:PrepareFn}){
 const [lp,setLp]=useState(''),[error,setError]=useState('');
 const set=(pct:bigint)=>setLp(fromRaw(summary.unlockedLp*pct/100n,state.lpDecimals));
 const submit=()=>{setError('');try{onPrepare('withdraw',{lpAmountRaw:toRaw(lp,state.lpDecimals)});}catch(e){setError(e instanceof Error?e.message:'Check the amount.');}};
 return <div className="space-y-4">
  <p className="text-sm">Unlocked: <span className="font-merge-mono">{fromRaw(summary.unlockedLp,state.lpDecimals)}</span> LP tokens. Locked liquidity cannot be withdrawn until its lock expires and is released.</p>
  <div className="flex flex-wrap gap-2">{[25n,50n,100n].map(p=><button key={String(p)} type="button" className={pill(false)} onClick={()=>set(p)} disabled={busy||summary.unlockedLp===0n}>{String(p)}%</button>)}</div>
  <div className="space-y-1"><Label htmlFor="liquidity-withdraw-lp">LP tokens to withdraw</Label><Input id="liquidity-withdraw-lp" value={lp} onChange={e=>setLp(e.target.value)} inputMode="decimal" className="max-w-[240px] font-merge-mono" disabled={busy}/></div>
  <p className="text-xs text-muted-foreground">Withdrawals are publicly visible and allow 0.5% price movement within the displayed minimums.</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Button variant="outline" disabled={busy||!lp} onClick={submit}>{busy?'Preparing review…':'Review withdrawal'}</Button>
 </div>;
}

/** Lock unlocked LP for a term or forever. */
export function LockForm({state,summary,busy,onPrepare}:{state:LiveLiquidityState;summary:LiquiditySummary;busy:boolean;onPrepare:PrepareFn}){
 const [lp,setLp]=useState(()=>fromRaw(summary.unlockedLp,state.lpDecimals)),[lock,setLock]=useState<LockTerm>('12-month'),[error,setError]=useState('');
 const submit=()=>{setError('');try{onPrepare('lock',{lpAmountRaw:toRaw(lp,state.lpDecimals),lock});}catch(e){setError(e instanceof Error?e.message:'Check the amount.');}};
 return <div className="space-y-4">
  <div className="space-y-1"><Label htmlFor="liquidity-lock-lp">LP tokens to lock</Label><Input id="liquidity-lock-lp" value={lp} onChange={e=>setLp(e.target.value)} inputMode="decimal" className="max-w-[240px] font-merge-mono" disabled={busy}/>
   <p className="text-xs text-muted-foreground">Unlocked: {fromRaw(summary.unlockedLp,state.lpDecimals)} LP tokens.</p></div>
  <LockChoice value={lock} onChange={setLock} allowNone={false} disabled={busy}/>
  <p className="text-xs text-muted-foreground">Timed locks are held by SSR's program for 30, 90, 180 or 365 days. Lock forever uses Raydium's irreversible lock.</p>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <Button disabled={busy||!lp||summary.unlockedLp===0n} onClick={submit}><Lock className="w-3.5 h-3.5 mr-1.5"/>{busy?'Preparing review…':'Review lock'}</Button>
 </div>;
}
