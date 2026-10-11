import {SSR_POOL_PAYER} from '../lib/liquidity/raydiumCpmm';
import {LiquiditySetupNeeded,throwLiquidityResponse,savedLiquidityTables} from '../lib/liquidity/liquiditySetupClient';
import {LiquidityLookupSetup} from './LiquidityLookupSetup';
import {useEffect,useRef,useState} from 'react';
import {useWallet} from '@solana/wallet-adapter-react';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import type {DTR} from '../lib/types';
import type {PreparedLiquidity} from '../../../lib/mainnet/prepareCompound';
import {checkLiquidityMessage} from '../lib/liquidity/liquidityExecution';
import {LiquidityTransactionReview} from './LiquidityTransactionReview';
import {Card,CardContent,CardHeader,CardTitle} from './ui/card';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Label} from './ui/label';
interface Tranche{address:string;unlockTs:string;permanent:boolean;withdrawn:boolean;}
interface State{reserve:string;creator:string;treasury:string;hasPool:boolean;reserveDecimals:number;lpDecimals:number;usdcBalanceRaw:string;reserveBalanceRaw:string;lpBalanceRaw:string;nativeEarningsUsdcRaw:string;stagedEarningsUsdcRaw:string;tranches:Tranche[];}
type Action='create'|'add'|'withdraw'|'collect'|'lock'|'extend'|'unlock'|'permanent';
const ACTIONS:[Action,string][]=[['create','Create pool'],['add','Add liquidity'],['withdraw','Withdraw'],['collect','Collect'],['lock','Lock liquidity'],['extend','Extend lock'],['unlock','Release expired lock'],['permanent','Make permanent']];
const LOCKS=[['unlocked','Unlocked'],['1-month','1 month'],['3-month','3 months'],['6-month','6 months'],['12-month','12 months'],['permanent','Permanent']];
function raw(value:string,decimals:number){if(!Number.isInteger(decimals)||decimals<0||decimals>18||!/^\d+(\.\d+)?$/.test(value))throw new Error('Enter a valid positive amount.');const [whole,fraction='']=value.split('.');if(fraction.length>decimals)throw new Error(`Use at most ${decimals} decimal places.`);const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');if(n<=0n||n>0xffffffffffffffffn)throw new Error('Amount is outside the supported range.');return n.toString();}
function display(value:string,decimals:number){const n=BigInt(value),d=10n**BigInt(decimals);return `${n/d}${decimals?'.'+(n%d).toString().padStart(decimals,'0').replace(/0+$/,''):' '}`.replace(/\.$/,'');}
async function request(body:unknown){const response=await fetch('/api/mainnet/liquidity',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throwLiquidityResponse(result,'Liquidity request unavailable.');return result;}
export function LiveLiquidityActions({dtr}:{dtr:DTR}){
 const chain=dtr.onChain!,wallet=useWallet(),[state,setState]=useState<State|null>(null),[action,setAction]=useState<Action>('add'),[lock,setLock]=useState('unlocked');
 const [buyTax,setBuyTax]=useState('0'),[sellTax,setSellTax]=useState('0');
 const [usdc,setUsdc]=useState(''),[tokens,setTokens]=useState(''),[lp,setLp]=useState(''),[sol,setSol]=useState('0.05'),[tranche,setTranche]=useState(''),[expiry,setExpiry]=useState('');
 const [setupAddresses,setSetupAddresses]=useState<string[]>([]);
 const [prepared,setPrepared]=useState<(PreparedLiquidity&{review:Record<string,string>;tranche?:string})|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const generation=useRef(0);
 useEffect(()=>{generation.current++;setState(null);setPrepared(null);setError('');},[chain.reserve,chain.manager,chain.feeDestination]);
 useEffect(()=>{generation.current++;setPrepared(null);},[action,lock,usdc,tokens,lp,sol,tranche,expiry,buyTax,sellTax]);
 const refresh=async()=>{if(busy)return;const current=++generation.current;setBusy(true);setError('');setPrepared(null);try{const value:State=await request({action:'read',reserve:chain.reserve});if(value.reserve!==chain.reserve||value.creator!==chain.manager||value.treasury!==chain.feeDestination||!Array.isArray(value.tranches))throw new Error('Liquidity identity changed; refresh the Reserve.');for(const n of [value.reserveDecimals,value.lpDecimals])if(!Number.isInteger(n)||n<0||n>18)throw new Error('Unsupported token precision.');for(const amount of [value.usdcBalanceRaw,value.reserveBalanceRaw,value.lpBalanceRaw,value.nativeEarningsUsdcRaw,value.stagedEarningsUsdcRaw])if(!/^\d{1,20}$/.test(amount))throw new Error('Invalid liquidity balance.');if(current===generation.current){setState(value);setAction(value.hasPool?'add':'create');}}catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Liquidity unavailable.');}finally{setBusy(false);}};
 const prepare=async()=>{if(!state||!wallet.publicKey||busy)return;const current=++generation.current;setBusy(true);setError('');setPrepared(null);try{
  const actor=wallet.publicKey.toBase58(),maximumSolRaw=raw(sol,9),body:any={action,reserve:chain.reserve,actor,lock,slippageBps:50,maximumSolRaw,lookupTables:savedLiquidityTables(chain.reserve)};
  if(action==='create'){body.maximumUsdcRaw=raw(usdc,6);const tax=(v:string)=>{if(!/^(?:[01](?:\.\d{1,2})?|2(?:\.0{1,2})?)$/.test(v))throw new Error('Project tax must be between zero and two percent.');return Math.round(Number(v)*100);};body.buyTaxBps=tax(buyTax);body.sellTaxBps=tax(sellTax);}
  if(action==='add'){body.maximumUsdcRaw=raw(usdc,6);body.maximumReserveRaw=raw(tokens,state.reserveDecimals);}
  if(action==='withdraw'||action==='lock')body.lpAmountRaw=raw(lp,state.lpDecimals);
  if(['extend','unlock','permanent'].includes(action)){body.tranche=new PublicKey(tranche).toBase58();if(action==='extend'){const seconds=Math.floor(new Date(expiry).getTime()/1000);if(!Number.isSafeInteger(seconds)||seconds<=Date.now()/1000)throw new Error('Choose a future lock expiry.');body.unlockTs=String(seconds);}}
  const result=await request(body) as PreparedLiquidity&{review:Record<string,string>;tranche?:string};
  if(result.action!==action||result.reserve!==chain.reserve||result.creator!==chain.manager||result.treasury!==chain.feeDestination||result.confirmationText!==action.toUpperCase()||result.expiresAtMs<=Date.now()||result.executionEnabled!==false||!result.simulation?.passed)throw new Error('Liquidity review changed or has expired.');
  if(!/^\d{1,20}$/.test(result.totalSolRaw)||BigInt(result.totalSolRaw)>BigInt(maximumSolRaw))throw new Error('Simulated SOL cost exceeds your cap.');
  const transaction=await checkLiquidityMessage(result);if(transaction.signatures.some(s=>s.some(b=>b!==0)))throw new Error('Expected an unsigned transaction.');
  const allowed=action==='collect'?[actor]:[state.creator,state.treasury,...(action==='create'?[SSR_POOL_PAYER.toBase58()]:[])];if(result.requiredSigners.some(k=>!allowed.includes(k)))throw new Error('Unexpected signing wallet.');
  // Deserialize here as well to ensure the rendered bytes remain a valid packet.
  VersionedTransaction.deserialize(Buffer.from(result.transactionBase64,'base64'));
  if(current===generation.current)setPrepared(result);
 }catch(e){if(current===generation.current){if(e instanceof LiquiditySetupNeeded)setSetupAddresses(e.addresses);setError(e instanceof Error?e.message:'Could not prepare liquidity.');}}finally{setBusy(false);}};
 return <Card><CardHeader><CardTitle>Pool and liquidity locks</CardTitle></CardHeader><CardContent className="space-y-4">
  <Button variant="outline" disabled={busy} onClick={()=>void refresh()}>{busy?'Checking…':'Refresh live liquidity'}</Button>
  {state&&<><p className="text-sm">Creator treasury: {display(state.usdcBalanceRaw,6)} USDC · {display(state.reserveBalanceRaw,state.reserveDecimals)} {dtr.ticker} · {display(state.lpBalanceRaw,state.lpDecimals)} unlocked LP tokens.</p>
   {!state.hasPool&&<p className="text-sm text-muted-foreground">Pool creation requires the approved Raydium payer and creator treasury to sign the same funding and creation transaction.</p>}<>
    <div className="flex flex-wrap gap-2">{ACTIONS.filter(([id])=>state.hasPool?id!=='create':id==='create').map(([id,label])=><Button key={id} variant={action===id?'default':'outline'} disabled={busy} onClick={()=>setAction(id)}>{label}</Button>)}</div>
    {action==='create'&&<><Label htmlFor="liquidity-initial-usdc">USDC for the initial pool</Label><Input id="liquidity-initial-usdc" value={usdc} onChange={e=>setUsdc(e.target.value)} inputMode="decimal" disabled={busy}/><p className="text-xs text-muted-foreground">The Reserve Token side is calculated from current backing value. The review includes both Token-2022 transfers and all setup costs.</p><Label htmlFor="liquidity-buy-tax">Optional project Buy tax (%)</Label><Input id="liquidity-buy-tax" value={buyTax} onChange={e=>setBuyTax(e.target.value)} inputMode="decimal" disabled={busy}/><Label htmlFor="liquidity-sell-tax">Optional project Sell tax (%)</Label><Input id="liquidity-sell-tax" value={sellTax} onChange={e=>setSellTax(e.target.value)} inputMode="decimal" disabled={busy}/><p className="text-xs text-muted-foreground">Optional taxes apply through SSR. SSR receives 25% of each project tax; zero tax means zero revenue from that tax.</p></>}
    {action==='add'&&<><Label htmlFor="liquidity-usdc-cap">Maximum USDC to add</Label><Input id="liquidity-usdc-cap" value={usdc} onChange={e=>setUsdc(e.target.value)} inputMode="decimal" disabled={busy}/><Label htmlFor="liquidity-reserve-cap">Maximum {dtr.ticker} to add</Label><Input id="liquidity-reserve-cap" value={tokens} onChange={e=>setTokens(e.target.value)} inputMode="decimal" disabled={busy}/></>}
    {(action==='withdraw'||action==='lock')&&<><Label htmlFor="liquidity-lp-amount">Unlocked LP tokens</Label><Input id="liquidity-lp-amount" value={lp} onChange={e=>setLp(e.target.value)} inputMode="decimal" disabled={busy}/></>}
    {(action==='create'||action==='add'||action==='lock')&&<><p className="text-sm">Lock for this addition</p><div className="flex flex-wrap gap-2">{LOCKS.filter(([id])=>action!=='lock'||id!=='unlocked').map(([id,label])=><Button key={id} variant={lock===id?'default':'outline'} disabled={busy} onClick={()=>setLock(id)}>{label}</Button>)}</div><p className="text-xs text-muted-foreground">Timed terms are 30, 90, 180 or 365 days. Timed custody uses SSR’s upgradeable program. Permanent liquidity uses Raydium’s irreversible lock.</p></>}
    {['extend','unlock','permanent'].includes(action)&&<><p className="text-sm">Choose a locked addition</p><div className="flex flex-wrap gap-2">{state.tranches.filter(t=>!t.withdrawn&&!t.permanent).map((t,i)=><Button key={t.address} variant={tranche===t.address?'default':'outline'} disabled={busy} onClick={()=>setTranche(t.address)}>Addition {i+1} · {new Date(Number(t.unlockTs)*1000).toLocaleDateString()}</Button>)}</div>{action==='extend'&&<><Label htmlFor="liquidity-expiry">New expiry</Label><Input id="liquidity-expiry" type="datetime-local" value={expiry} onChange={e=>setExpiry(e.target.value)} disabled={busy}/></>}</>}
    {action==='collect'&&<p className="text-sm">Collect sends creator DEX earnings to the fixed creator treasury and SSR’s share to the protocol treasury. It does not withdraw liquidity.</p>}
    <Label htmlFor="liquidity-sol-cap">Maximum network and setup cost (SOL)</Label><Input id="liquidity-sol-cap" value={sol} onChange={e=>setSol(e.target.value)} inputMode="decimal" disabled={busy}/>
    <p className="text-xs text-muted-foreground">Add and Withdraw allow 0.5% price movement within the displayed limits. Review runs a simulation; it does not move funds.</p>
    <Button disabled={busy||!wallet.publicKey} onClick={()=>void prepare()}>Prepare and review</Button>
   </>
  </>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {setupAddresses.length>0&&chain.feeDestination&&<LiquidityLookupSetup reserve={chain.reserve} treasury={chain.feeDestination} addresses={setupAddresses}/>}
  {prepared&&state&&<div className="space-y-3">
   <p className="text-sm">Simulation passed. Estimated total cost: {display(prepared.totalSolRaw,9)} SOL.</p>
   {prepared.review.usdcDebitRaw&&<p className="text-sm">Initial funding: {display(prepared.review.usdcDebitRaw,6)} USDC and {display(prepared.review.reserveDebitRaw,state.reserveDecimals)} {dtr.ticker}. NAV: {prepared.review.navUsdc} USDC per token.</p>}
   {prepared.solCostsByWallet?.map(cost=><p key={cost.wallet} className="text-xs text-muted-foreground">{cost.wallet.slice(0,6)}…{cost.wallet.slice(-4)} pays {display(cost.lamports,9)} SOL.</p>)}
   {prepared.review.lpAddedRaw&&<p className="text-sm">Liquidity added: {display(prepared.review.lpAddedRaw,state.lpDecimals)} LP tokens. Lock: {prepared.review.lock}.</p>}
   {prepared.review.minimumUsdcRaw&&<p className="text-sm">Receive at least {display(prepared.review.minimumUsdcRaw,6)} USDC and {display(prepared.review.minimumReserveRaw,state.reserveDecimals)} {dtr.ticker}.</p>}
   {prepared.review.distributableUsdcRaw&&<p className="text-sm">{display(prepared.review.distributableUsdcRaw,6)} USDC available for distribution between the fixed treasuries.</p>}
   <LiquidityTransactionReview plan={prepared}/>
  </div>}
 </CardContent></Card>;
}
