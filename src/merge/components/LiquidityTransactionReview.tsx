import {useEffect,useRef,useState} from 'react';
import {useConnection,useWallet} from '@solana/wallet-adapter-react';
import type {PreparedLiquidity} from '../../../lib/mainnet/prepareCompound';
import type {PublicKey} from '@solana/web3.js';
import {signLiquidityPlan,submitLiquidityPlan,reconcileLiquidity,readPendingLiquidity,type LookupTableLoader,type PendingLiquidity} from '../lib/liquidity/liquidityExecution';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Label} from './ui/label';

/** Wallets sign the same reviewed bytes. Recovery remains available after expiry. */
/** Polls a submitted transaction until it confirms, fails or its blockhash expires (~1 minute). */
const CONFIRM_POLL_MS=2000,CONFIRM_POLL_LIMIT=60;
export function LiquidityTransactionReview({plan,onSettled}:{plan:PreparedLiquidity;onSettled?:(state:PendingLiquidity['state'])=>void}){
 const {connection}=useConnection(),wallet=useWallet();
 const [confirmation,setConfirmation]=useState(''),[serialized,setSerialized]=useState(plan.transactionBase64);
 const [missing,setMissing]=useState(plan.requiredSigners),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[signature,setSignature]=useState<string|null>(null);
 const generation=useRef(0),[nowMs,setNowMs]=useState(Date.now());
 const loadTables:LookupTableLoader=async(keys:PublicKey[])=>(await Promise.all(keys.map(k=>connection.getAddressLookupTable(k,{commitment:'confirmed'})))).flatMap(r=>r.value?[r.value]:[]);
 useEffect(()=>{const t=setInterval(()=>setNowMs(Date.now()),1000);return()=>clearInterval(t);},[]);
 const secondsLeft=Math.max(0,Math.floor((plan.expiresAtMs-nowMs)/1000));
 useEffect(()=>{generation.current++;setConfirmation('');setSerialized(plan.transactionBase64);setMissing(plan.requiredSigners);setMessage('');setSignature(null);
  try{const saved=readPendingLiquidity(localStorage,plan);if(saved){setSignature(saved.signature);setMessage(`Saved transaction: ${saved.state}. Check its status before another submission.`);}}catch(e){setMessage(e instanceof Error?e.message:'Saved transaction could not be read.');}
 },[plan]);
 const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await work();}catch(e){setMessage(e instanceof Error?e.message:'Could not complete this step.');}finally{setBusy(false);}};
 const send=async(transactionBase64:string)=>{const current=generation.current;const result=await submitLiquidityPlan({connection,storage:localStorage,plan,transactionBase64,loadTables,releaseCheck:async()=>{const response=await fetch('/api/mainnet/liquidity-release',{cache:'no-store'});if(!response.ok)return false;const release=await response.json();return release.executionEnabled===true;}});setSignature(result.signature);setMessage(result.message);
  if(result.state==='rejected'){onSettled?.('rejected');return;}
  // Follow the submission to an outcome so the next stage can start on its own.
  for(let i=0;i<CONFIRM_POLL_LIMIT&&current===generation.current;i++){
   await new Promise(r=>setTimeout(r,CONFIRM_POLL_MS));
   const record=await reconcileLiquidity(connection,localStorage,plan,undefined,loadTables).catch(()=>null);
   if(!record||record.state==='pending')continue;
   if(current!==generation.current)return;
   setMessage(record.state==='confirmed'?'Confirmed on Solana.':record.state==='failed'?'The transaction landed but failed on chain. Check it on Solscan before trying again.':'The transaction expired without landing, so nothing was spent. Prepare it again.');
   onSettled?.(record.state);return;
  }
  if(current===generation.current)setMessage('Still waiting for confirmation. Use "Check saved transaction" before trying again.');};
 // Once the last required wallet signs, send straight away: the review window is short and a second click only loses time.
 const sign=()=>run(async()=>{const current=generation.current;const result=await signLiquidityPlan({plan,transactionBase64:serialized,confirmation,wallet,loadTables});if(current!==generation.current)return;setSerialized(result.transactionBase64);setMissing(result.missingSigners);
  if(result.missingSigners.length){setMessage('Signature saved. Connect the next required wallet.');return;}
  setMessage('All required wallets have signed. Submitting…');await send(result.transactionBase64);});
 const submit=()=>run(()=>send(serialized));
 const reconcile=()=>run(async()=>{const result=await reconcileLiquidity(connection,localStorage,plan,undefined,loadTables);setMessage(result?`Transaction ${result.state}.`:'No saved transaction for this Reserve and treasury.');if(result)setSignature(result.signature);if(result&&result.state!=='pending')onSettled?.(result.state);});
 return <div className="space-y-3">
  <p className="text-sm">Required wallets: {plan.requiredSigners.map(k=>`${k.slice(0,6)}…${k.slice(-4)}`).join(', ')}</p>
  {!plan.executionEnabled&&<p className="text-sm text-muted-foreground">Wallet execution is awaiting the verified program release.</p>}
  {!signature&&<p className="text-xs text-muted-foreground">{secondsLeft>0?`This review can be signed for ${secondsLeft} more seconds.`:'This review has expired. Prepare it again.'}</p>}
  <Label htmlFor={`confirm-${plan.messageHash}`}>Type {plan.confirmationText} to approve this exact transaction</Label>
  <Input id={`confirm-${plan.messageHash}`} value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy||!plan.executionEnabled} autoComplete="off"/>
  <div className="flex flex-wrap gap-2">
   <Button onClick={()=>void sign()} disabled={busy||!plan.executionEnabled||confirmation!==plan.confirmationText||!wallet.publicKey||!missing.includes(wallet.publicKey.toBase58())}>Sign with connected wallet</Button>
   <Button onClick={()=>void submit()} disabled={busy||!plan.executionEnabled||missing.length>0}>Submit approved transaction</Button>
   <Button variant="outline" onClick={()=>void reconcile()} disabled={busy}>Check saved transaction</Button>
  </div>
  {message&&<p role="status" className="text-sm whitespace-pre-wrap break-words">{message}</p>}
  {signature&&<a className="text-sm underline" href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noopener noreferrer">View transaction</a>}
 </div>;
}
