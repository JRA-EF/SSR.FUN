import {useEffect,useRef,useState} from 'react';
import {useConnection,useWallet} from '@solana/wallet-adapter-react';
import type {PreparedLiquidity} from '../../../lib/mainnet/prepareCompound';
import {signLiquidityPlan,submitLiquidityPlan,reconcileLiquidity,readPendingLiquidity} from '../lib/liquidity/liquidityExecution';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Label} from './ui/label';

/** Wallets sign the same reviewed bytes. Recovery remains available after expiry. */
export function LiquidityTransactionReview({plan}:{plan:PreparedLiquidity}){
 const {connection}=useConnection(),wallet=useWallet();
 const [confirmation,setConfirmation]=useState(''),[serialized,setSerialized]=useState(plan.transactionBase64);
 const [missing,setMissing]=useState(plan.requiredSigners),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[signature,setSignature]=useState<string|null>(null);
 const generation=useRef(0);
 useEffect(()=>{generation.current++;setConfirmation('');setSerialized(plan.transactionBase64);setMissing(plan.requiredSigners);setMessage('');setSignature(null);
  try{const saved=readPendingLiquidity(localStorage,plan);if(saved){setSignature(saved.signature);setMessage(`Saved transaction: ${saved.state}. Check its status before another submission.`);}}catch(e){setMessage(e instanceof Error?e.message:'Saved transaction could not be read.');}
 },[plan]);
 const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await work();}catch(e){setMessage(e instanceof Error?e.message:'Could not complete this step.');}finally{setBusy(false);}};
 const sign=()=>run(async()=>{const current=generation.current;const result=await signLiquidityPlan({plan,transactionBase64:serialized,confirmation,wallet});if(current!==generation.current)return;setSerialized(result.transactionBase64);setMissing(result.missingSigners);setMessage(result.missingSigners.length?'Signature saved. Connect the next required wallet.':'All required wallets have signed. Ready to submit.');});
 const submit=()=>run(async()=>{const result=await submitLiquidityPlan({connection,storage:localStorage,plan,transactionBase64:serialized,releaseCheck:async()=>{const response=await fetch('/api/mainnet/liquidity-release',{cache:'no-store'});if(!response.ok)return false;const release=await response.json();return release.executionEnabled===true;}});setSignature(result.signature);setMessage(result.message);});
 const reconcile=()=>run(async()=>{const result=await reconcileLiquidity(connection,localStorage,plan);setMessage(result?`Transaction ${result.state}.`:'No saved transaction for this Reserve and treasury.');if(result)setSignature(result.signature);});
 return <div className="space-y-3">
  <p className="text-sm">Required wallets: {plan.requiredSigners.map(k=>`${k.slice(0,6)}…${k.slice(-4)}`).join(', ')}</p>
  {!plan.executionEnabled&&<p className="text-sm text-muted-foreground">Wallet execution is awaiting the verified program release.</p>}
  <Label htmlFor={`confirm-${plan.messageHash}`}>Type {plan.confirmationText} to approve this exact transaction</Label>
  <Input id={`confirm-${plan.messageHash}`} value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy||!plan.executionEnabled} autoComplete="off"/>
  <div className="flex flex-wrap gap-2">
   <Button onClick={()=>void sign()} disabled={busy||!plan.executionEnabled||confirmation!==plan.confirmationText||!wallet.publicKey||!missing.includes(wallet.publicKey.toBase58())}>Sign with connected wallet</Button>
   <Button onClick={()=>void submit()} disabled={busy||!plan.executionEnabled||missing.length>0}>Submit approved transaction</Button>
   <Button variant="outline" onClick={()=>void reconcile()} disabled={busy}>Check saved transaction</Button>
  </div>
  {message&&<p role="status" className="text-sm">{message}</p>}
  {signature&&<a className="text-sm underline" href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noopener noreferrer">View transaction</a>}
 </div>;
}
