import {expect} from 'chai';
import {createHash,webcrypto} from 'node:crypto';
import {Keypair,PublicKey,TransactionMessage,TransactionInstruction,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {SendTransactionError,SolanaJSONRPCError} from '@solana/web3.js';
import {onLocalClock,definiteRejection,isWalletGuardedRewrite,checkLiquidityMessage,signLiquidityPlan,submitLiquidityPlan,reconcileLiquidity,signatureBase58,type LiquidityExecutionPlan,type LiquidityExclusive} from '../src/merge/lib/liquidity/liquidityExecution';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const NOW=1800000000000;
const exclusive:LiquidityExclusive=(()=>{const tails=new Map<string,Promise<unknown>>();return async(name:string,work:()=>Promise<any>)=>{const previous=tails.get(name)??Promise.resolve();let release!:()=>void;const next=new Promise<void>(r=>release=r);tails.set(name,next);await previous;try{return await work();}finally{release();if(tails.get(name)===next)tails.delete(name);}};})();
function fixture(){
 const a=Keypair.generate(),b=Keypair.generate();
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:a.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:b.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(0)})]}).compileToV0Message());
 const plan:LiquidityExecutionPlan={action:'compound',reserve:Keypair.generate().publicKey.toBase58(),treasury:a.publicKey.toBase58(),transactionBase64:Buffer.from(tx.serialize()).toString('base64'),messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex'),requiredSigners:tx.message.staticAccountKeys.slice(0,2).map(k=>k.toBase58()),blockhash:tx.message.recentBlockhash,lastValidBlockHeight:100,expiresAtMs:NOW+1000,executionEnabled:true,confirmationText:'COMPOUND'};
 const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
 let sends=0,height=90,status:any=null;
 const connection:any={getBlockHeight:async()=>height,getSignatureStatuses:async()=>({value:[status]}),sendRawTransaction:async(bytes:Uint8Array)=>{sends++;return signatureBase58(VersionedTransaction.deserialize(bytes).signatures[0]);}};
 tx.sign([a,b]);const signed=Buffer.from(tx.serialize()).toString('base64');
 const input={plan,transactionBase64:signed,storage,connection,now:()=>NOW,releaseCheck:async()=>true,exclusive};
 return {a,b,plan,tx,signed,storage,data,connection,input,sends:()=>sends,setHeight:(n:number)=>height=n,setStatus:(s:any)=>status=s};
}
async function rejects(f:()=>Promise<unknown>,message:string){let e:unknown;try{await f();}catch(err){e=err;}expect(String(e)).contain(message);}
describe('Liquidity wallet execution and recovery',()=>{
 it('encodes leading-zero base58 signatures correctly',()=>{expect(signatureBase58(new Uint8Array([0,0,1]))).eq('112');expect(signatureBase58(new Uint8Array([57]))).eq('z');expect(signatureBase58(new Uint8Array([58]))).eq('21');});
 it('requires typed confirmation and release before opening a wallet',async()=>{const f=fixture();let calls=0;const wallet={publicKey:f.a.publicKey,signTransaction:async(tx:VersionedTransaction)=>{calls++;tx.sign([f.a]);return tx;}};await rejects(()=>signLiquidityPlan({plan:f.plan,confirmation:'',wallet,now:()=>NOW}),'Type COMPOUND');await rejects(()=>signLiquidityPlan({plan:{...f.plan,executionEnabled:false},confirmation:'COMPOUND',wallet,now:()=>NOW}),'not been released');expect(calls).eq(0);});
 it('preserves signatures across two-wallet signing',async()=>{const f=fixture();const first=await signLiquidityPlan({plan:f.plan,confirmation:'COMPOUND',wallet:{publicKey:f.a.publicKey,signTransaction:async t=>{t.sign([f.a]);return t;}},now:()=>NOW});expect(first.missingSigners).deep.eq([f.b.publicKey.toBase58()]);const second=await signLiquidityPlan({plan:f.plan,transactionBase64:first.transactionBase64,confirmation:'COMPOUND',wallet:{publicKey:f.b.publicKey,signTransaction:async t=>{t.sign([f.b]);return t;}},now:()=>NOW});expect(second.missingSigners).deep.eq([]);});
 it('rejects changed messages, invalid signatures and removed co-signatures',async()=>{const f=fixture();const bad=VersionedTransaction.deserialize(Buffer.from(f.signed,'base64'));bad.signatures[1][0]^=1;await rejects(()=>checkLiquidityMessage(f.plan,Buffer.from(bad.serialize()).toString('base64')),'Invalid liquidity signature');bad.message.recentBlockhash=Keypair.generate().publicKey.toBase58();await rejects(()=>checkLiquidityMessage(f.plan,Buffer.from(bad.serialize()).toString('base64')),'changed');await rejects(()=>signLiquidityPlan({plan:f.plan,transactionBase64:f.signed,confirmation:'COMPOUND',wallet:{publicKey:f.a.publicKey,signTransaction:async t=>{t.signatures[1].fill(0);return t;}},now:()=>NOW}),'removed an existing');});
 it('requires every signer, a fresh release check and durable storage before sending',async()=>{const f=fixture();await rejects(()=>submitLiquidityPlan({...f.input,transactionBase64:f.plan.transactionBase64}),'All required');await rejects(()=>submitLiquidityPlan({...f.input,releaseCheck:async()=>false}),'disabled');await rejects(()=>submitLiquidityPlan({...f.input,storage:{...f.storage,setItem:()=>{throw new Error('storage unavailable');}}}),'storage unavailable');expect(f.sends()).eq(0);});
 it('serializes concurrent submissions and blocks a second spend',async()=>{const f=fixture();const results=await Promise.allSettled([submitLiquidityPlan(f.input),submitLiquidityPlan(f.input)]);expect(results.filter(r=>r.status==='fulfilled').length).eq(1);expect(f.sends()).eq(1);});
 it('persists unknown outcomes and reconciles successful confirmations without resending',async()=>{const f=fixture();f.connection.sendRawTransaction=async()=>{throw new Error('timeout');};expect((await submitLiquidityPlan(f.input)).message).contain('unknown');await rejects(()=>submitLiquidityPlan(f.input),'still pending');f.setStatus({confirmationStatus:'confirmed',err:null});expect((await reconcileLiquidity(f.connection,f.storage,f.plan,exclusive))?.state).eq('confirmed');await rejects(()=>submitLiquidityPlan(f.input),'recorded outcome');});
 it('only releases an absent signature after finalized blockhash expiry',async()=>{const f=fixture();await submitLiquidityPlan(f.input);f.setHeight(100);expect((await reconcileLiquidity(f.connection,f.storage,f.plan,exclusive))?.state).eq('pending');f.setHeight(101);f.setStatus({confirmationStatus:'processed',err:null});expect((await reconcileLiquidity(f.connection,f.storage,f.plan,exclusive))?.state).eq('pending');f.setStatus(null);expect((await reconcileLiquidity(f.connection,f.storage,f.plan,exclusive))?.state).eq('expired');});
 it('records confirmed failures and checks confirmation expiry after a slow RPC response',async()=>{const f=fixture();await submitLiquidityPlan(f.input);f.setStatus({confirmationStatus:'finalized',err:{InstructionError:[0,'Custom']}});expect((await reconcileLiquidity(f.connection,f.storage,f.plan,exclusive))?.state).eq('failed');const g=fixture();let clock=NOW;g.connection.getBlockHeight=async()=>{clock=NOW+1001;return 90;};await rejects(()=>submitLiquidityPlan({...g.input,now:()=>clock}),'review expired');expect(g.sends()).eq(0);});
});

describe('Wallet-guarded rewrites (Phantom Lighthouse)',()=>{
 const LIGHTHOUSE=new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
 const guard=(account:PublicKey,tag:number)=>new TransactionInstruction({programId:LIGHTHOUSE,keys:[{pubkey:account,isSigner:false,isWritable:false}],data:Buffer.from([tag,1,2,3])});
 function single(){
  const a=Keypair.generate(),target=Keypair.generate().publicKey,blockhash=Keypair.generate().publicKey.toBase58();
  const core=[SystemProgram.transfer({fromPubkey:a.publicKey,toPubkey:target,lamports:5}),new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:a.publicKey,isSigner:true,isWritable:false}],data:Buffer.from('memo')})];
  const build=(ixs:TransactionInstruction[])=>new VersionedTransaction(new TransactionMessage({payerKey:a.publicKey,recentBlockhash:blockhash,instructions:ixs}).compileToV0Message());
  const tx=build([ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}),...core]);
  const plan:LiquidityExecutionPlan={action:'setup',reserve:Keypair.generate().publicKey.toBase58(),treasury:a.publicKey.toBase58(),transactionBase64:Buffer.from(tx.serialize()).toString('base64'),messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex'),requiredSigners:[a.publicKey.toBase58()],blockhash,lastValidBlockHeight:100,expiresAtMs:NOW+1000,executionEnabled:true,confirmationText:'SETUP'};
  // What Phantom returned for CgHF's setup transactions: one price instruction, guards around the core.
  const phantom=build([ComputeBudgetProgram.setComputeUnitPrice({microLamports:200_000}),guard(a.publicKey,0),...core,guard(Keypair.generate().publicKey,1)]);
  return {a,core,build,tx,plan,phantom};
 }
 const wallet=(a:Keypair,replacement:VersionedTransaction)=>({publicKey:a.publicKey,signTransaction:async()=>{replacement.sign([a]);return replacement;}});
 it('accepts Phantom adding Lighthouse guards and replacing the compute budget, then submits it',async()=>{const t=single();
  const r=await signLiquidityPlan({plan:t.plan,confirmation:'SETUP',wallet:wallet(t.a,t.phantom),now:()=>NOW});expect(r.missingSigners).deep.eq([]);
  let sent:Uint8Array|null=null;const data=new Map<string,string>();
  const out=await submitLiquidityPlan({plan:t.plan,transactionBase64:r.transactionBase64,storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v);}},connection:{getBlockHeight:async()=>90,getSignatureStatuses:async()=>({value:[null]}),sendRawTransaction:async(b:any)=>{sent=b;return signatureBase58(VersionedTransaction.deserialize(b).signatures[0]);}} as any,now:()=>NOW,releaseCheck:async()=>true,exclusive});
  expect(out.message).contain('Submitted');expect(Buffer.from(sent!).equals(Buffer.from(t.phantom.serialize()))).eq(true);});
 it('rejects a rewrite that alters, drops or adds a non-guard instruction',async()=>{const t=single();
  const altered=t.build([guard(t.a.publicKey,0),SystemProgram.transfer({fromPubkey:t.a.publicKey,toPubkey:Keypair.generate().publicKey,lamports:5}),t.core[1]]);
  const dropped=t.build([guard(t.a.publicKey,0),t.core[0]]);
  const added=t.build([...t.core,SystemProgram.transfer({fromPubkey:t.a.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]);
  for(const bad of [altered,dropped,added])await rejects(()=>signLiquidityPlan({plan:t.plan,confirmation:'SETUP',wallet:wallet(t.a,bad),now:()=>NOW}),'changed');});
 it('caps the priority fee a wallet may add',()=>{const t=single();
  expect(isWalletGuardedRewrite(t.tx.message,t.phantom.message)).eq(true);
  expect(isWalletGuardedRewrite(t.tx.message,t.build([ComputeBudgetProgram.setComputeUnitPrice({microLamports:2_000_000}),...t.core]).message)).eq(false);
  expect(isWalletGuardedRewrite(t.tx.message,t.build([ComputeBudgetProgram.setComputeUnitLimit({units:100_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:2_000_000}),...t.core]).message)).eq(true);});
 it('still rejects a different blockhash even with identical instructions',async()=>{const t=single();
  const other=new VersionedTransaction(new TransactionMessage({payerKey:t.a.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:t.core}).compileToV0Message());
  await rejects(()=>signLiquidityPlan({plan:t.plan,confirmation:'SETUP',wallet:wallet(t.a,other),now:()=>NOW}),'changed');});
});
describe('Submission outcomes and review clocks',()=>{
 const rejection=()=>new SendTransactionError({action:'send',signature:'',transactionMessage:'Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1',logs:['Program log: Instruction: Initialize','Program log: Error: insufficient funds']});
 it('records an explicit preflight rejection with its logs and allows a fresh preparation',async()=>{const f=fixture();f.connection.sendRawTransaction=async()=>{throw rejection();};
  const out=await submitLiquidityPlan(f.input);expect(out.state).eq('rejected');expect(out.message).contain('nothing was spent').contain('0x1').contain('insufficient funds');
  const saved=JSON.parse([...f.data.values()][0]);expect(saved.state).eq('rejected');expect(saved.error).contain('insufficient funds');
  await rejects(()=>submitLiquidityPlan(f.input),'recorded outcome');
  const g=fixture();g.data.set([...f.data.keys()][0].replace(f.plan.reserve,g.plan.reserve).replace(f.plan.treasury,g.plan.treasury),JSON.stringify({...saved,plan:{...saved.plan,reserve:g.plan.reserve,treasury:g.plan.treasury}}));
  expect((await submitLiquidityPlan(g.input)).state).eq('pending');expect(g.sends()).eq(1);});
 it('treats JSON-RPC errors as definite and transport failures as unknown',async()=>{
  expect(definiteRejection(new SolanaJSONRPCError({code:-32005,message:'rate-limited'},'failed to send transaction'))).contain('rate-limited');
  expect(definiteRejection(new Error('fetch failed'))).eq(null);expect(definiteRejection(new TypeError('NetworkError'))).eq(null);
  const f=fixture();f.connection.sendRawTransaction=async()=>{throw new Error('fetch failed');};expect((await submitLiquidityPlan(f.input)).message).contain('unknown');await rejects(()=>submitLiquidityPlan(f.input),'still pending');});
 it('re-checks a rejected signature on chain before releasing another spend',async()=>{const f=fixture();f.connection.sendRawTransaction=async()=>{throw rejection();};await submitLiquidityPlan(f.input);
  f.setStatus({confirmationStatus:'confirmed',err:null});expect((await reconcileLiquidity(f.connection,f.storage,f.plan,exclusive))?.state).eq('confirmed');});
 it('measures the review window on the browser clock regardless of server clock skew',()=>{
  const plan={expiresAtMs:5_000_000+45_000,serverNowMs:5_000_000};
  expect(onLocalClock(plan,NOW).expiresAtMs).eq(NOW+44_000);
  expect(onLocalClock({expiresAtMs:NOW+9000},NOW).expiresAtMs).eq(NOW+9000);
  expect(onLocalClock({expiresAtMs:10,serverNowMs:50},NOW).expiresAtMs).eq(NOW-1000);});
 it('refuses a wallet rewrite of a transaction SSR already co-signed, without weakening the check',async()=>{
  const payer=Keypair.generate(),creator=Keypair.generate(),blockhash=Keypair.generate().publicKey.toBase58(),LIGHTHOUSE=new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
  const core=[new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:true}],data:Buffer.from('launch')})];
  const build=(ixs:TransactionInstruction[])=>new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:blockhash,instructions:ixs}).compileToV0Message());
  const tx=build(core);tx.sign([payer]);
  const plan:LiquidityExecutionPlan={action:'create',reserve:Keypair.generate().publicKey.toBase58(),treasury:creator.publicKey.toBase58(),transactionBase64:Buffer.from(tx.serialize()).toString('base64'),messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex'),requiredSigners:[payer.publicKey.toBase58(),creator.publicKey.toBase58()],blockhash,lastValidBlockHeight:100,expiresAtMs:NOW+1000,executionEnabled:true,confirmationText:'CREATE'};
  const rewritten=build([...core,new TransactionInstruction({programId:LIGHTHOUSE,keys:[{pubkey:creator.publicKey,isSigner:false,isWritable:false}],data:Buffer.from([1])})]);
  rewritten.signatures[0]=tx.signatures[0];
  await rejects(()=>signLiquidityPlan({plan,confirmation:'CREATE',wallet:{publicKey:creator.publicKey,signTransaction:async()=>{rewritten.sign([creator]);rewritten.signatures[0]=tx.signatures[0];return rewritten;}},now:()=>NOW}),'voids the co-signature');
  const ok=await signLiquidityPlan({plan,confirmation:'CREATE',wallet:{publicKey:creator.publicKey,signTransaction:async t=>{t.sign([creator]);return t;}},now:()=>NOW});expect(ok.missingSigners).deep.eq([]);});
});
