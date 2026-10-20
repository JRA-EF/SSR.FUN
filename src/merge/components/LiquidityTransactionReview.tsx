import {useEffect,useRef,useState} from 'react';
import {useConnection,useWallet} from '@solana/wallet-adapter-react';
import type {PublicKey} from '@solana/web3.js';
import {CheckCircle2,Loader2} from 'lucide-react';
import type {PreparedLiquidity} from '../../../lib/mainnet/prepareCompound';
import {signLiquidityPlan,submitLiquidityPlan,reconcileLiquidity,readPendingLiquidity,walletErrorText,type LookupTableLoader,type PendingLiquidity} from '../lib/liquidity/liquidityExecution';
import {useToast} from '@/hooks/use-toast';
import {transactionConfirmedToast} from './TransactionConfirmation';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Label} from './ui/label';

/** Polls a submitted transaction until it confirms, fails or its blockhash expires (~1 minute). */
const CONFIRM_POLL_MS=2000,CONFIRM_POLL_LIMIT=60;
/**
 * One step at a time: approve (each required wallet signs the exact reviewed bytes; the last signature
 * sends it) -> waiting for Solana -> an outcome. Buttons appear only when they can do something.
 */
type Step='approve'|'send'|'confirming'|'confirmed'|'failed'|'unknown';
/** Pop-up headlines, matching the Mint/Redeem confirmations. */
const ACTION_NAMES:Record<string,string>={create:'Pool launch',add:'Liquidity addition',withdraw:'Liquidity withdrawal',collect:'Earnings collection',lock:'Liquidity lock',extend:'Lock extension',unlock:'Lock release',permanent:'Permanent lock',setup:'Setup step',compound:'Compound'};

const outcomeText:Record<Exclude<PendingLiquidity['state'],'pending'|'confirmed'>,string>={
 failed:'The transaction landed but failed on chain, so its changes were not applied. Check it on Solscan, then prepare it again.',
 expired:'The transaction expired without landing, so nothing was spent. Prepare it again.',
 rejected:'The network rejected this transaction before broadcasting it, so nothing was spent. Prepare it again.',
};
export function LiquidityTransactionReview({plan,onSettled,onRetry}:{plan:PreparedLiquidity;onSettled?:(state:PendingLiquidity['state'],signature:string|null)=>void;onRetry?:()=>void}){
 const {connection}=useConnection(),wallet=useWallet(),{toast}=useToast();
 const name=ACTION_NAMES[plan.action]??'Liquidity transaction';
 const [confirmation,setConfirmation]=useState(''),[serialized,setSerialized]=useState(plan.transactionBase64);
 const [missing,setMissing]=useState(plan.requiredSigners),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[signature,setSignature]=useState<string|null>(null);
 const [step,setStep]=useState<Step>('approve');
 const generation=useRef(0),[nowMs,setNowMs]=useState(Date.now());
 const loadTables:LookupTableLoader=async(keys:PublicKey[])=>(await Promise.all(keys.map(k=>connection.getAddressLookupTable(k,{commitment:'confirmed'})))).flatMap(r=>r.value?[r.value]:[]);
 useEffect(()=>{const t=setInterval(()=>setNowMs(Date.now()),1000);return()=>clearInterval(t);},[]);
 const secondsLeft=Math.max(0,Math.floor((plan.expiresAtMs-nowMs)/1000));
 const settle=(state:PendingLiquidity['state'],sig:string|null,text?:string,quiet=false)=>{
  if(state==='pending'){const detail=text??'Solana has not confirmed it yet. Check its status before trying again.';setStep('unknown');setMessage(detail);if(!quiet)toast({title:`${name} still confirming`,description:detail});return;}
  const detail=state==='confirmed'?'Confirmed on Solana.':text??outcomeText[state];
  setStep(state==='confirmed'?'confirmed':'failed');setMessage(detail);
  if(!quiet&&state==='confirmed'&&sig)toast(transactionConfirmedToast(sig,`${name} confirmed`));
  else if(!quiet&&state!=='confirmed')toast({variant:'destructive',title:state==='failed'?`${name} failed`:state==='expired'?`${name} expired`:`${name} was not sent`,description:detail.split('\n')[0]});
  onSettled?.(state,sig);
 };
 const follow=async(current:number,sig:string)=>{
  setStep('confirming');
  for(let i=0;i<CONFIRM_POLL_LIMIT&&current===generation.current;i++){
   await new Promise(r=>setTimeout(r,CONFIRM_POLL_MS));
   const record=await reconcileLiquidity(connection,localStorage,plan,undefined,loadTables).catch(()=>null);
   if(current!==generation.current)return;
   if(record&&record.state!=='pending'){settle(record.state,sig);return;}
  }
  if(current===generation.current)settle('pending',sig);
 };
 useEffect(()=>{generation.current++;const current=generation.current;setConfirmation('');setSerialized(plan.transactionBase64);setMissing(plan.requiredSigners);setMessage('');setSignature(null);setStep('approve');
  try{const saved=readPendingLiquidity(localStorage,plan);
   // A transaction for this exact review was already sent: show its outcome instead of offering to send again.
   if(saved&&saved.plan.messageHash===plan.messageHash){setSignature(saved.signature);if(saved.state==='pending')void follow(current,saved.signature);else settle(saved.state,saved.signature,saved.state==='rejected'&&saved.error?`${outcomeText.rejected}\n${saved.error}`:undefined,true);}
  }catch(e){setMessage(e instanceof Error?e.message:'Saved transaction could not be read.');}
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[plan]);
 const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await work();}catch(e){const text=walletErrorText(e);setMessage(text);toast({variant:'destructive',title:`${name} not completed`,description:text});}finally{setBusy(false);}};
 const send=async(transactionBase64:string)=>{const current=generation.current;
  const result=await submitLiquidityPlan({connection,storage:localStorage,plan,transactionBase64,loadTables,releaseCheck:async()=>{const response=await fetch('/api/mainnet/liquidity-release',{cache:'no-store'});if(!response.ok)return false;const release=await response.json();return release.executionEnabled===true;}});
  if(current!==generation.current)return;setSignature(result.signature);
  if(result.state==='rejected'){settle('rejected',result.signature,result.message);return;}
  setMessage(result.message);await follow(current,result.signature);
 };
 // The last required signature sends it straight away: the review window is short and a second click only loses time.
 const approve=()=>run(async()=>{const current=generation.current;const result=await signLiquidityPlan({plan,transactionBase64:serialized,confirmation,wallet,loadTables});if(current!==generation.current)return;setSerialized(result.transactionBase64);setMissing(result.missingSigners);
  if(result.missingSigners.length){setMessage('Signature saved. Connect the next required wallet and approve.');return;}
  setStep('send');setMessage('Approved. Sending…');await send(result.transactionBase64);});
 // Only reached when every wallet signed but sending stopped before the network saw it.
 const sendAgain=()=>run(()=>send(serialized));
 const check=()=>run(async()=>{const record=await reconcileLiquidity(connection,localStorage,plan,undefined,loadTables);if(!record){setMessage('No sent transaction was found for this review.');return;}setSignature(record.signature);settle(record.state,record.signature,record.state==='rejected'&&record.error?`${outcomeText.rejected}\n${record.error}`:undefined);});
 const link=signature&&<a className="text-sm underline" href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noopener noreferrer">View transaction</a>;
 const isLast=missing.length===1&&!!wallet.publicKey&&missing[0]===wallet.publicKey.toBase58();

 if(step==='confirming')return <div className="space-y-2" role="status"><p className="text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/>Sent. Waiting for Solana to confirm (usually a few seconds)…</p>{link}</div>;
 if(step==='confirmed')return <div className="space-y-2" role="status"><p className="text-sm flex items-center gap-2 text-primary"><CheckCircle2 className="w-4 h-4"/>{message}</p>{link}</div>;
 if(step==='failed')return <div className="space-y-2"><p role="alert" className="text-sm text-destructive whitespace-pre-wrap break-words">{message}</p>{link}{onRetry&&<Button variant="outline" onClick={onRetry}>Prepare again</Button>}</div>;
 if(step==='unknown')return <div className="space-y-2"><p role="status" className="text-sm">{message}</p>{link}<Button variant="outline" onClick={()=>void check()} disabled={busy}>{busy?'Checking…':'Check status'}</Button></div>;

 const expired=secondsLeft<=0;
 return <div className="space-y-3">
  {plan.requiredSigners.length>1&&<p className="text-sm">Required wallets: {plan.requiredSigners.map(k=>`${k.slice(0,6)}…${k.slice(-4)}${missing.includes(k)?'':' (signed)'}`).join(', ')}</p>}
  {!plan.executionEnabled&&<p className="text-sm text-muted-foreground">Wallet execution is awaiting the verified program release.</p>}
  {step==='approve'&&<>
   <p className="text-xs text-muted-foreground">{expired?'This review has expired. Prepare it again.':`This review can be approved for ${secondsLeft} more seconds.`}</p>
   <Label htmlFor={`confirm-${plan.messageHash}`}>Type {plan.confirmationText} to approve this exact transaction</Label>
   <Input id={`confirm-${plan.messageHash}`} value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy||!plan.executionEnabled||expired} autoComplete="off"/>
   {expired&&onRetry?<Button variant="outline" onClick={onRetry}>Prepare again</Button>
    :<Button onClick={()=>void approve()} disabled={busy||!plan.executionEnabled||confirmation!==plan.confirmationText||!wallet.publicKey||!missing.includes(wallet.publicKey.toBase58())}>
     {busy?<><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin"/>Approve in your wallet…</>:isLast?'Approve and send':'Approve with connected wallet'}</Button>}
  </>}
  {step==='send'&&!busy&&(expired&&onRetry?<Button variant="outline" onClick={onRetry}>Prepare again</Button>:<Button onClick={()=>void sendAgain()} disabled={!plan.executionEnabled||expired}>Send approved transaction</Button>)}
  {message&&<p role="status" className="text-sm whitespace-pre-wrap break-words">{message}</p>}
  {link}
 </div>;
}
