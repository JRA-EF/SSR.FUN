/**
 * Manage Reserve -> Liquidity for a live mainnet Solana Reserve. Same layout
 * as the design (LiquiditySection in LiquidityModule.tsx): an empty state that
 * launches the pool, then a pool dashboard (pool liquidity, creator DEX
 * earnings, lock status, pool details, locks) -- filled from on-chain state
 * via /api/mainnet/liquidity. Every action is simulated server-side and signed
 * through LiquidityTransactionReview.
 */
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {useWallet} from '@solana/wallet-adapter-react';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {Check,Coins,Copy,Droplets,ExternalLink,Lock,RefreshCw} from 'lucide-react';
import type {DTR} from '@/lib/types';
import {formatUsdc} from '@/lib/calculations';
import {shortenAddress} from '@/lib/delegateLabels';
import {solscanUrl} from '@/lib/solana-config';
import {SSR_POOL_PAYER} from '../lib/liquidity/raydiumCpmm';
import {LiquiditySetupNeeded,savedLiquidityTables} from '../lib/liquidity/liquiditySetupClient';
import {checkLiquidityMessage} from '../lib/liquidity/liquidityExecution';
import {checkLiveState,checkPrepared,defaultSolCap,fromRaw,postLiquidity,summarizeLiquidity,toRaw,LOCK_TERM_DAYS,type LiveAction,type LiveLiquidityState,type LiveTranche,type PreparedLiveLiquidity} from '../lib/liquidity/liveLiquidityClient';
import {AddLiquidityForm,CreatePoolForm,LockForm,WithdrawForm} from './LiveLiquidityActions';
import {LiquidityLookupSetup} from './LiquidityLookupSetup';
import {LiquidityTransactionReview} from './LiquidityTransactionReview';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from './ui/card';
import {Input} from './ui/input';
import {Label} from './ui/label';

const ACTION_TITLES:Record<LiveAction,string>={create:'Launch pool',add:'Add liquidity',withdraw:'Withdraw liquidity',collect:'Collect DEX earnings',lock:'Lock liquidity',extend:'Extend lock',unlock:'Release expired lock',permanent:'Lock forever'};
const kpiLabel='text-[10px] uppercase tracking-wider font-semibold text-muted-foreground';
const date=(ms:number)=>new Date(ms).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});

export function LiveLiquiditySection({dtr}:{dtr:DTR}){
 const chain=dtr.onChain!,wallet=useWallet();
 const [state,setState]=useState<LiveLiquidityState|null>(null),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
 const [panel,setPanel]=useState<'add'|'withdraw'|'lock'|null>(null);
 const [prepared,setPrepared]=useState<PreparedLiveLiquidity|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [setupAddresses,setSetupAddresses]=useState<string[]>([]),[advancedOpen,setAdvancedOpen]=useState(false),[solCap,setSolCap]=useState('');
 const [copied,setCopied]=useState(false);
 const generation=useRef(0),reviewRef=useRef<HTMLDivElement>(null),lastRequest=useRef<{action:LiveAction;extras:Record<string,unknown>}|null>(null);
 const nav=dtr.nav>0?dtr.nav:dtr.tokenPrice;

 const load=useCallback(async()=>{
  const current=++generation.current;setLoading(true);setLoadError('');
  try{const value=checkLiveState(await postLiquidity({action:'read',reserve:chain.reserve}),{reserve:chain.reserve,creator:chain.manager,treasury:chain.feeDestination});if(current===generation.current)setState(value);}
  catch(e){if(current===generation.current)setLoadError(e instanceof Error?e.message:'Liquidity is unavailable right now.');}
  finally{if(current===generation.current)setLoading(false);}
 },[chain.reserve,chain.manager,chain.feeDestination]);
 useEffect(()=>{setState(null);setPrepared(null);setPanel(null);void load();},[load]);
 useEffect(()=>{if(prepared)reviewRef.current?.scrollIntoView({behavior:'smooth',block:'nearest'});},[prepared]);

 const prepare=async(action:LiveAction,extras:Record<string,unknown>={})=>{
  if(!state||!wallet.publicKey||busy)return;
  const current=++generation.current;lastRequest.current={action,extras};setBusy(true);setError('');setPrepared(null);setSetupAddresses([]);
  try{
   const actor=wallet.publicKey.toBase58(),maximumSolRaw=toRaw(solCap.trim()||defaultSolCap(action),9);
   const result=checkPrepared(await postLiquidity({action,reserve:chain.reserve,actor,lock:'unlocked',slippageBps:50,maximumSolRaw,lookupTables:savedLiquidityTables(chain.reserve),...extras}),{action,reserve:chain.reserve,creator:chain.manager,treasury:chain.feeDestination,maximumSolRaw});
   const tx=await checkLiquidityMessage(result);
   // Only pool launch arrives pre-signed, and only by SSR's Raydium payer.
   const signerKeys=tx.message.staticAccountKeys;
   if(tx.signatures.some((sig,i)=>sig.some(b=>b!==0)&&!(action==='create'&&signerKeys[i].equals(SSR_POOL_PAYER))))throw new Error('Unexpected pre-signed transaction.');
   const allowed=action==='collect'?[actor]:[state.creator,state.treasury,...(action==='create'?[SSR_POOL_PAYER.toBase58()]:[])];
   if(result.requiredSigners.some(k=>!allowed.includes(k)))throw new Error('Unexpected signing wallet.');
   VersionedTransaction.deserialize(Buffer.from(result.transactionBase64,'base64'));
   if(current===generation.current)setPrepared(result);
  }catch(e){if(current===generation.current){if(e instanceof LiquiditySetupNeeded)setSetupAddresses(e.addresses);setError(e instanceof Error?e.message:'Could not prepare this transaction.');}}
  finally{if(current===generation.current)setBusy(false);}
 };

 const header=(live:boolean)=><div className="flex flex-wrap items-center gap-3">
  <h2 className="text-xl font-merge-display font-bold">Liquidity</h2>
  <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">{live?'Raydium pool · live':'Raydium'}</Badge>
  {live&&state&&<a href={solscanUrl('address',state.pool)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-merge-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">Pool {shortenAddress(state.pool)} <ExternalLink className="w-3 h-3"/></a>}
  <Button variant="ghost" size="sm" className="ml-auto" disabled={loading||busy} onClick={()=>void load()}><RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading?'animate-spin':''}`}/>Refresh</Button>
 </div>;

 if(!state)return <div className="space-y-6">{header(false)}
  <Card><CardContent className="pt-6 text-sm">{loading?<p className="text-muted-foreground">Reading pool state from Solana…</p>:<div className="space-y-3"><p role="alert" className="text-destructive">{loadError}</p><Button variant="outline" size="sm" onClick={()=>void load()}>Try again</Button></div>}</CardContent></Card>
 </div>;

 const notices=<>
  {state.paused&&<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">The protocol is paused. Liquidity actions are unavailable until it resumes.</div>}
  {!state.executionEnabled&&<div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">Liquidity transactions are not released yet. You can review them, but signing is disabled.</div>}
 </>;
 const disabled=busy||state.paused||!wallet.publicKey;

 const review=<div ref={reviewRef} className="space-y-4">
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {setupAddresses.length>0&&chain.feeDestination&&<LiquidityLookupSetup reserve={chain.reserve} treasury={chain.feeDestination} addresses={setupAddresses} onComplete={()=>{const last=lastRequest.current;if(last)void prepare(last.action,last.extras);}}/>}
  {prepared&&<Card className="border-primary/30"><CardHeader><CardTitle className="text-base font-merge-display">Review: {ACTION_TITLES[prepared.action as LiveAction]??prepared.action}</CardTitle>
   <CardDescription>Simulation passed. Estimated network and setup cost {fromRaw(prepared.totalSolRaw,9)} SOL.</CardDescription></CardHeader>
   <CardContent className="space-y-3 text-sm">
    {prepared.review.usdcDebitRaw&&<p>Funding: {fromRaw(prepared.review.usdcDebitRaw,6)} USDC and {fromRaw(prepared.review.reserveDebitRaw,state.reserveDecimals)} {dtr.ticker}{prepared.review.navUsdc?` at ${prepared.review.navUsdc} USDC per token`:''}.</p>}
    {prepared.review.holderShareBps!==undefined&&<p>Permanent fee terms: {Number(prepared.review.buyTaxBps)/100}% tax on trades into {dtr.ticker}, {Number(prepared.review.sellTaxBps)/100}% on trades out of it, and {Number(prepared.review.holderShareBps)/100}% of your share fed back to holders.</p>}
    {prepared.review.lpAddedRaw&&<p>Liquidity added: {fromRaw(prepared.review.lpAddedRaw,state.lpDecimals)} LP tokens. Lock: {prepared.review.lock}.</p>}
    {prepared.review.minimumUsdcRaw&&<p>You receive at least {fromRaw(prepared.review.minimumUsdcRaw,6)} USDC and {fromRaw(prepared.review.minimumReserveRaw,state.reserveDecimals)} {dtr.ticker}.</p>}
    {prepared.review.distributableUsdcRaw&&<p>{fromRaw(prepared.review.distributableUsdcRaw,6)} USDC is split by the pool's fee terms between SSR, your creator treasury{state.holderShareBps?' and your holders (added to the Reserve over 24 hours)':''}.</p>}
    {prepared.solCostsByWallet?.map(c=><p key={c.wallet} className="text-xs text-muted-foreground">…{c.wallet.slice(-4)} pays {fromRaw(c.lamports,9)} SOL.</p>)}
    <LiquidityTransactionReview plan={prepared} onSettled={state=>{if(state==='confirmed')void load();}}/>
    <Button variant="ghost" size="sm" onClick={()=>{setPrepared(null);void load();}}>Done · refresh pool</Button>
   </CardContent></Card>}
 </div>;
 const advanced=<div>
  <button type="button" className="text-xs text-muted-foreground underline" onClick={()=>setAdvancedOpen(v=>!v)}>{advancedOpen?'Hide':'Show'} advanced</button>
  {advancedOpen&&<div className="mt-3 space-y-1 max-w-[260px]"><Label htmlFor="liquidity-sol-cap">Maximum network and setup cost (SOL)</Label><Input id="liquidity-sol-cap" value={solCap} onChange={e=>setSolCap(e.target.value)} placeholder={`Automatic: ${defaultSolCap('add')} SOL, ${defaultSolCap('create')} SOL for a pool launch`} inputMode="decimal" className="font-merge-mono"/>
   <p className="text-xs text-muted-foreground">The review is refused if the simulated cost is higher. A pool launch costs about 0.19 SOL: Raydium's 0.15 SOL pool-creation fee plus account rent.</p></div>}
 </div>;

 if(!state.hasPool)return <div className="space-y-6">{header(false)}{notices}
  <Card><CardHeader>
   <CardTitle className="text-xl font-merge-display flex items-center gap-2"><Droplets className="w-5 h-5 text-primary"/> Take your Reserve Token to market</CardTitle>
   <CardDescription>Add liquidity on Raydium and {dtr.ticker} becomes tradeable outside SSR.fun, with a public chart. Liquidity is what turns a backed token into a market.</CardDescription>
  </CardHeader><CardContent className="space-y-4">
   <CreatePoolForm dtr={dtr} state={state} nav={nav} busy={disabled} onPrepare={(a,x)=>void prepare(a,x)} refresh={load}/>
   {advanced}
  </CardContent></Card>
  {review}
 </div>;

 const s=summarizeLiquidity(state,nav),now=Date.now();
 const lockLabel=s.permanentCount>0&&s.positionLp===0n?'Locked forever':s.timedLockedLp>0n?`${s.lockedPct.toFixed(0)}% locked`:s.permanentCount>0?'Partly locked forever':'Unlocked';
 const copy=()=>{navigator.clipboard.writeText(state.pool).then(()=>{setCopied(true);window.setTimeout(()=>setCopied(false),2000);}).catch(()=>undefined);};
 const row=(label:string,value:ReactNode)=><div className="flex items-center justify-between border-b border-border pb-2.5"><span className="text-muted-foreground">{label}</span><span>{value}</span></div>;

 return <div className="space-y-6">
  {header(true)}{notices}
  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
   <Card><CardContent className="pt-6 space-y-1">
    <p className={kpiLabel}>Pool liquidity</p>
    <p className="font-merge-mono text-2xl">{formatUsdc(s.tvlUsd)}</p>
    <p className="text-xs text-muted-foreground">Raydium · {dtr.ticker} / USDC</p>
   </CardContent></Card>
   <Card><CardContent className="pt-6 space-y-1">
    <p className={kpiLabel}>Creator DEX earnings</p>
    <p className="font-merge-mono text-2xl">{formatUsdc(s.earningsUsdc)}</p>
    <div className="flex flex-wrap items-center gap-2 pt-1">
     <Button size="sm" disabled={disabled||s.earningsUsdc<0.01} onClick={()=>void prepare('collect')}><Coins className="w-3.5 h-3.5 mr-1.5"/> Collect</Button>
     <Button size="sm" variant="outline" disabled title="Compound is not released yet"><Droplets className="w-3.5 h-3.5 mr-1.5"/> Compound</Button>
    </div>
    <p className="text-xs text-muted-foreground">{state.termsVersion===2?`Accrues in USDC. When collected, SSR takes 20%${state.holderShareBps?`, ${state.holderShareBps/100}% of the rest is added to the Reserve's backing for holders,`:''} and the rest goes to your fixed creator treasury.`:"Accrues in USDC after SSR's pool share. Collect sends it to your fixed creator treasury."} Compound is coming later.</p>
   </CardContent></Card>
   <Card><CardContent className="pt-6 space-y-1.5">
    <p className={kpiLabel}>Lock status</p>
    <p className="font-merge-mono text-2xl">{lockLabel}</p>
    {s.timedLockedLp>0n&&<div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary rounded-full" style={{width:`${Math.min(100,Math.max(2,s.lockedPct))}%`}}/></div>}
    <p className="text-xs text-muted-foreground">
     {s.nextUnlockMs?`Next unlock ${date(s.nextUnlockMs)}. `:''}
     {s.permanentCount>0?`${s.permanentCount} addition${s.permanentCount===1?'':'s'} locked forever. `:''}
     {s.timedLockedLp===0n&&s.permanentCount===0?'Nothing is locked. Locking is the strongest trust signal you can give holders.':'Fees keep accruing to you while locked.'}
    </p>
   </CardContent></Card>
  </div>

  <Card>
   <CardHeader className="flex flex-row items-center justify-between space-y-0"><CardTitle className="text-base font-merge-display">Pool</CardTitle></CardHeader>
   <CardContent>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 text-sm">
     {row('DEX','Raydium · Standard (CPMM)')}
     {row('Pair',<span className="font-merge-mono">{dtr.ticker} / USDC</span>)}
     {row('Pool address',<span className="inline-flex items-center gap-2">
      <a href={solscanUrl('address',state.pool)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-merge-mono text-primary hover:underline">{shortenAddress(state.pool)} <ExternalLink className="w-3 h-3"/></a>
      <button type="button" onClick={copy} aria-label="Copy pool address" className="text-muted-foreground hover:text-foreground">{copied?<Check className="w-3.5 h-3.5 text-positive"/>:<Copy className="w-3.5 h-3.5"/>}</button></span>)}
     {row('Your position',<span className="font-merge-mono">{s.positionTokens.toLocaleString(undefined,{maximumFractionDigits:2})} {dtr.ticker} + {formatUsdc(s.positionUsdc)}</span>)}
     {state.termsVersion===2&&row('Shared with holders',<span className="font-merge-mono">{state.holderShareBps?`${state.holderShareBps/100}% of your earnings · ${formatUsdc(Number(fromRaw(state.basketFedUsdcRaw??'0',6)))} added so far`:'None (your choice at launch)'}</span>)}
     {row('Your share of the pool',<span className="font-merge-mono">{s.sharePct.toFixed(2)}%</span>)}
     {row('Market price vs backing',s.premiumPct===null?<span className="text-muted-foreground">No price yet</span>:<span className={`font-merge-mono ${s.premiumPct>=0?'text-positive':'text-destructive'}`}>{s.premiumPct>=0?'+':''}{s.premiumPct.toFixed(2)}%</span>)}
    </div>
    <div className="flex flex-wrap items-center gap-2 mt-5">
     <Button variant={panel==='add'?'default':'outline'} size="sm" disabled={disabled} onClick={()=>setPanel(p=>p==='add'?null:'add')}><Droplets className="w-3.5 h-3.5 mr-1.5"/> Add liquidity</Button>
     <Button variant={panel==='lock'?'default':'outline'} size="sm" disabled={disabled||s.unlockedLp===0n} onClick={()=>setPanel(p=>p==='lock'?null:'lock')}><Lock className="w-3.5 h-3.5 mr-1.5"/> Lock liquidity</Button>
     <Button variant={panel==='withdraw'?'default':'outline'} size="sm" disabled={disabled||s.unlockedLp===0n} onClick={()=>setPanel(p=>p==='withdraw'?null:'withdraw')}>Withdraw</Button>
    </div>
    <p className="text-xs text-muted-foreground mt-4">Withdrawing is only possible for unlocked liquidity, and any withdrawal is publicly visible. Locking never touches your fees: collected fees always go to your creator treasury. The position excludes liquidity locked forever.</p>
    {panel&&<div className="mt-5 border-t border-border pt-5">
     {panel==='add'&&<AddLiquidityForm dtr={dtr} state={state} summary={s} busy={disabled} onPrepare={(a,x)=>void prepare(a,x)} refresh={load}/>}
     {panel==='withdraw'&&<WithdrawForm state={state} summary={s} busy={disabled} onPrepare={(a,x)=>void prepare(a,x)}/>}
     {panel==='lock'&&<LockForm state={state} summary={s} busy={disabled} onPrepare={(a,x)=>void prepare(a,x)}/>}
    </div>}
   </CardContent>
  </Card>

  {(s.activeTimed.length>0||s.expiredTimed.length>0)&&<Card>
   <CardHeader><CardTitle className="text-base font-merge-display">Locks</CardTitle></CardHeader>
   <CardContent className="space-y-3 text-sm">
    {[...s.expiredTimed,...s.activeTimed].map((t,i)=><TrancheRow key={t.address} index={i+1} tranche={t} lpDecimals={state.lpDecimals} now={now} disabled={disabled} onPrepare={(a,x)=>void prepare(a,x)}/>)}
   </CardContent>
  </Card>}

  {advanced}
  {review}
 </div>;
}

function TrancheRow({index,tranche,lpDecimals,now,disabled,onPrepare}:{index:number;tranche:LiveTranche;lpDecimals:number;now:number;disabled:boolean;onPrepare:(a:LiveAction,x:Record<string,unknown>)=>void}){
 const unlockMs=Number(tranche.unlockTs)*1000,expired=unlockMs<=now;
 return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
  <div><p className="font-medium">Lock {index} · <span className="font-merge-mono">{fromRaw(tranche.lpRaw,lpDecimals)}</span> LP</p>
   <p className="text-xs text-muted-foreground">{expired?`Expired ${date(unlockMs)}. Release it to withdraw or relock.`:`Locked until ${date(unlockMs)}`}</p></div>
  <div className="flex flex-wrap gap-2">
   {expired?<Button size="sm" variant="outline" disabled={disabled} onClick={()=>onPrepare('unlock',{tranche:new PublicKey(tranche.address).toBase58()})}>Release</Button>
    :(Object.entries(LOCK_TERM_DAYS) as [string,number][]).map(([term,days])=>{const target=Math.floor(now/1000)+days*86400;if(target<=Number(tranche.unlockTs))return null;
     return <Button key={term} size="sm" variant="outline" disabled={disabled} onClick={()=>onPrepare('extend',{tranche:tranche.address,unlockTs:String(target)})}>Extend to {term.replace('-month','m')}</Button>;})}
   <Button size="sm" variant="outline" disabled={disabled} onClick={()=>onPrepare('permanent',{tranche:tranche.address})}><Lock className="w-3.5 h-3.5 mr-1.5"/> Lock forever</Button>
  </div>
 </div>;
}
