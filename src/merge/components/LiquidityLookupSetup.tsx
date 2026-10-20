import {useState} from 'react';
import {useWallet} from '@solana/wallet-adapter-react';
import {PublicKey} from '@solana/web3.js';
import type {PreparedLiquidity} from '../../../lib/mainnet/prepareCompound';
import {checkLiquidityMessage,onLocalClock} from '../lib/liquidity/liquidityExecution';
import {liquidityTableKey,savedLiquidityTables} from '../lib/liquidity/liquiditySetupClient';
import {LiquidityTransactionReview} from './LiquidityTransactionReview';
import {Button} from './ui/button';
/** Each confirmed setup step prepares the next one; when setup is complete, onComplete resumes the reviewed operation. Every step still needs its own typed approval and wallet signature. */
export function LiquidityLookupSetup({reserve,treasury,addresses,onComplete}:{reserve:string;treasury:string;addresses:string[];onComplete?:()=>void}){
 const wallet=useWallet(),[prepared,setPrepared]=useState<PreparedLiquidity|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const prepare=async()=>{if(!wallet.publicKey||busy)return;setBusy(true);setPrepared(null);setMessage('');try{const actor=wallet.publicKey.toBase58(),response=await fetch('/api/mainnet/liquidity-setup',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({reserve,actor,addresses,table:savedLiquidityTables(reserve)[0],maximumSolRaw:'50000000'})});const result=await response.json();if(!response.ok)throw new Error(result.error??'Setup unavailable.');const table=new PublicKey(result.table).toBase58();
  if(result.complete===true){localStorage.setItem(liquidityTableKey(reserve),table);setMessage(onComplete?'Setup is complete. Preparing the review again…':'Setup is complete. Refresh the liquidity review to use it.');onComplete?.();return;}
  const p=onLocalClock(result.prepared as PreparedLiquidity);if(p.action!=='setup'||p.reserve!==reserve||p.treasury!==treasury||p.creator!==actor||p.requiredSigners.length!==1||p.requiredSigners[0]!==actor||p.confirmationText!=='SETUP'||typeof p.executionEnabled!=="boolean"||!p.simulation?.passed||p.expiresAtMs<=Date.now()||!/^\d{1,20}$/.test(p.totalSolRaw)||BigInt(p.totalSolRaw)>50000000n)throw new Error('Setup review changed.');
  const tx=await checkLiquidityMessage(p);if(tx.signatures.some(s=>s.some(b=>b!==0)))throw new Error('Expected an unsigned setup transaction.');localStorage.setItem(liquidityTableKey(reserve),table);setPrepared(p);setMessage(`Setup step${result.remaining>0?' (more steps follow)':''}. Estimated cost: ${(Number(p.totalSolRaw)/1e9).toFixed(9)} SOL. The next step loads automatically after this one confirms.`);
 }catch(e){setMessage(e instanceof Error?e.message:'Setup unavailable.');}finally{setBusy(false);}};
 return <div className="space-y-3"><p className="text-sm">One-time transaction setup keeps the liquidity operation atomic. Each setup step only pays account rent and network fees; it does not move liquidity assets.</p><Button variant="outline" disabled={busy||!wallet.publicKey} onClick={()=>void prepare()}>Check next setup step</Button>{message&&<p role="status" className="text-sm">{message}</p>}{prepared&&<LiquidityTransactionReview plan={prepared} onSettled={state=>{if(state==='confirmed')void prepare();}}/>}</div>;
}
