import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import {assertCompoundApproval,type CompoundQuote,type CompoundApproval} from '@ssr/sdk';
import type {PreparedLiquidity} from '../../../../lib/mainnet/prepareCompound';

/** Validate the exact unsigned message shown in the final review. A server
 * simulation is not permission to sign, and this client never submits it. */
export async function validatePreparedCompound(wire:PreparedLiquidity,q:CompoundQuote,treasury:string,now=Date.now()):Promise<PreparedLiquidity> {
  if(wire.action!=='compound'||wire.reserve!==q.context.reserve||wire.pool!==q.context.pool||wire.creator!==q.context.creator||wire.treasury!==treasury||wire.quoteId!==q.id||wire.confirmationText!=='COMPOUND')throw new Error('Prepared Compound destination changed');
  if(!getAssociatedTokenAddressSync(new PublicKey(q.context.lpMint),new PublicKey(treasury),true).equals(new PublicKey(q.context.lpDestination)))throw new Error('Prepared liquidity destination changed');
  if(wire.expiresAtMs!==q.expiresAtMs||wire.expiresAtMs<=now||!wire.simulation?.passed||!Number.isSafeInteger(wire.simulation.slot)||wire.simulation.slot<q.context.snapshotSlot)throw new Error('Compound simulation is stale or unavailable');
  if(typeof wire.transactionBase64!=='string'||wire.transactionBase64.length>1644)throw new Error('Invalid prepared transaction');
  const tx=VersionedTransaction.deserialize(Buffer.from(wire.transactionBase64,'base64'));
  if(tx.signatures.some(s=>s.some(b=>b!==0)))throw new Error('Expected an unsigned Compound transaction');
  const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58());
  if(!Array.isArray(wire.requiredSigners)||signers.join(',')!==wire.requiredSigners.join(',')||signers[0]!==treasury||!signers.includes(q.context.creator)||signers.some(k=>k!==treasury&&k!==q.context.creator))throw new Error('Unexpected Compound authority');
  if(tx.message.recentBlockhash!==wire.blockhash||!Number.isSafeInteger(wire.lastValidBlockHeight)||wire.lastValidBlockHeight<=0)throw new Error('Invalid transaction lifetime');
  const digest=await crypto.subtle.digest('SHA-256',Uint8Array.from(tx.message.serialize()));
  const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==wire.messageHash)throw new Error('Prepared transaction changed');
  for(const amount of [wire.networkFeeRaw,wire.accountRentRaw,wire.totalSolRaw])if(typeof amount!=='string'||!/^\d{1,20}$/.test(amount))throw new Error('Invalid simulated cost');
  if(BigInt(wire.networkFeeRaw)+BigInt(wire.accountRentRaw)!==BigInt(wire.totalSolRaw)||BigInt(wire.totalSolRaw)>q.maximumSolCostRaw)throw new Error('Simulated cost exceeds the approved allowance');
  if(wire.executionEnabled!==false)throw new Error('Live Compound execution has not been released');
  return Object.freeze(wire);
}
export async function prepareSelectedCompound(q:CompoundQuote,approval:CompoundApproval,acquisitionPlan:unknown,treasury:string,signal?:AbortSignal) {
  assertCompoundApproval(q,approval,q.context,q.context.creator);
  const response=await fetch('/api/mainnet/prepare-compound',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal,
    body:JSON.stringify({quote:q,approval,acquisitionPlan},(_key,v)=>typeof v==='bigint'?v.toString():v)});
  const wire=await response.json();
  if(!response.ok)throw new Error(typeof wire?.error==='string'?wire.error:'Could not prepare the selected route');
  return validatePreparedCompound(wire,q,treasury);
}
