/** Exact-message co-signing and durable atomic-transaction recovery.
 * A network timeout never authorizes a second spend or a new blockhash. */
import {Buffer} from 'buffer';
import {VersionedTransaction,type PublicKey,type Connection} from '@solana/web3.js';
export interface LiquidityExecutionPlan {
 action:string;reserve:string;treasury:string;transactionBase64:string;messageHash:string;requiredSigners:string[];
 blockhash:string;lastValidBlockHeight:number;expiresAtMs:number;executionEnabled:boolean;confirmationText:string;
}
export interface PendingLiquidity {plan:LiquidityExecutionPlan;transactionBase64:string;signature:string;state:'pending'|'confirmed'|'failed'|'expired';}
export interface LiquidityStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;}
export type LiquidityExclusive = <T>(name:string,work:()=>Promise<T>)=>Promise<T>;
const browserExclusive:LiquidityExclusive = async(name,work)=>{
 if(typeof navigator==='undefined'||!navigator.locks)throw new Error('This browser cannot safely coordinate liquidity submissions across tabs');
 return navigator.locks.request(name,{mode:'exclusive'},work);
};
const key=(p:LiquidityExecutionPlan)=>`ssr-liquidity-pending:${p.reserve}:${p.treasury}`;
const encode=(tx:VersionedTransaction)=>Buffer.from(tx.serialize()).toString('base64');
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
export function signatureBase58(bytes:Uint8Array):string {
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=(n<<8n)+BigInt(b);
 let result='';while(n>0n){result=alphabet[Number(n%58n)]+result;n/=58n;}
 for(const b of bytes){if(b!==0)break;result='1'+result;}return result;
}
export async function checkLiquidityMessage(plan:LiquidityExecutionPlan,serialized=plan.transactionBase64):Promise<VersionedTransaction>{
 if(typeof serialized!=='string'||serialized.length>1644)throw new Error('Invalid liquidity transaction');
 const bytes=Buffer.from(serialized,'base64');
 if(bytes.length>1232||bytes.toString('base64')!==serialized||!Array.isArray(plan.requiredSigners)||!Number.isSafeInteger(plan.lastValidBlockHeight)||plan.lastValidBlockHeight<0)throw new Error('Invalid liquidity transaction');
 const tx=VersionedTransaction.deserialize(bytes);
 if(await digest(tx.message.serialize())!==plan.messageHash||tx.message.recentBlockhash!==plan.blockhash)throw new Error('Liquidity transaction changed; review again');
 const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
 if(signers.map(s=>s.toBase58()).join(',')!==plan.requiredSigners.join(','))throw new Error('Liquidity authorities changed');
 for(let i=0;i<signers.length;i++)if(tx.signatures[i].some(b=>b!==0)){
  const publicKey=await crypto.subtle.importKey('raw',Uint8Array.from(signers[i].toBytes()),{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,Uint8Array.from(tx.signatures[i]),Uint8Array.from(tx.message.serialize())))throw new Error('Invalid liquidity signature');
 }
 return tx;
}
function current(p:LiquidityExecutionPlan,now:number){
 if(!p.executionEnabled)throw new Error('Liquidity execution has not been released');
 if(!Number.isSafeInteger(p.expiresAtMs)||now>=p.expiresAtMs)throw new Error('Liquidity review expired before it was sent, so nothing was submitted or spent. Prepare it again for a fresh review.');
}
export async function signLiquidityPlan(p:{plan:LiquidityExecutionPlan;transactionBase64?:string;confirmation:string;wallet:{publicKey:PublicKey|null;signTransaction?:(tx:VersionedTransaction)=>Promise<VersionedTransaction>};now?:()=>number}){
 const now=p.now??Date.now;current(p.plan,now());
 if(p.confirmation!==p.plan.confirmationText)throw new Error(`Type ${p.plan.confirmationText} to approve this transaction`);
 const walletKey=p.wallet.publicKey?.toBase58();
 if(!walletKey||!p.plan.requiredSigners.includes(walletKey)||!p.wallet.signTransaction)throw new Error('Connect one of the required signing wallets');
 const tx=await checkLiquidityMessage(p.plan,p.transactionBase64),previous=tx.signatures.map(s=>Uint8Array.from(s));
 const signed=await p.wallet.signTransaction(tx);current(p.plan,now());
 if(p.wallet.publicKey?.toBase58()!==walletKey)throw new Error('Signing wallet changed');
 const verified=await checkLiquidityMessage(p.plan,encode(signed));
 for(let i=0;i<previous.length;i++)if(previous[i].some(b=>b!==0)&&!previous[i].every((b,j)=>verified.signatures[i][j]===b))throw new Error('Wallet removed an existing co-signature');
 const index=p.plan.requiredSigners.indexOf(walletKey);
 if(!verified.signatures[index].some(b=>b!==0))throw new Error('Wallet did not sign this transaction');
 return {transactionBase64:encode(verified),missingSigners:p.plan.requiredSigners.filter((_,i)=>!verified.signatures[i].some(b=>b!==0))};
}
export function readPendingLiquidity(storage:LiquidityStorage,plan:LiquidityExecutionPlan):PendingLiquidity|null{
 const raw=storage.getItem(key(plan));if(!raw)return null;
 let record:PendingLiquidity;try{record=JSON.parse(raw);}catch{throw new Error('Saved liquidity transaction needs reconciliation before another spend');}
 if(!record?.plan||record.plan.reserve!==plan.reserve||record.plan.treasury!==plan.treasury||!['pending','confirmed','failed','expired'].includes(record.state)||typeof record.signature!=='string')throw new Error('Saved liquidity transaction is invalid; do not submit again');
 return record;
}
async function reconcileUnlocked(connection:Pick<Connection,'getSignatureStatuses'|'getBlockHeight'>,storage:LiquidityStorage,plan:LiquidityExecutionPlan):Promise<PendingLiquidity|null>{
 const record=readPendingLiquidity(storage,plan);if(!record||record.state!=='pending')return record;
 const tx=await checkLiquidityMessage(record.plan,record.transactionBase64);
 if(signatureBase58(tx.signatures[0])!==record.signature)throw new Error('Saved signature does not match the pending transaction');
 const [height,statuses]=await Promise.all([connection.getBlockHeight('finalized'),connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})]);
 const status=statuses.value[0];
 if(status?.confirmationStatus==='confirmed'||status?.confirmationStatus==='finalized')record.state=status.err?'failed':'confirmed';
 else if(!status&&height>record.plan.lastValidBlockHeight){
  // Query once more AFTER observing finalized expiry, avoiding a stale status race.
  const final=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];
  if(!final)record.state='expired';
  else if(final.confirmationStatus==='confirmed'||final.confirmationStatus==='finalized')record.state=final.err?'failed':'confirmed';
 }
 storage.setItem(key(plan),JSON.stringify(record));return record;
}
export async function reconcileLiquidity(connection:Pick<Connection,'getSignatureStatuses'|'getBlockHeight'>,storage:LiquidityStorage,plan:LiquidityExecutionPlan,exclusive:LiquidityExclusive=browserExclusive){
 return exclusive(key(plan),()=>reconcileUnlocked(connection,storage,plan));
}
export async function submitLiquidityPlan(p:{connection:Pick<Connection,'getSignatureStatuses'|'getBlockHeight'|'sendRawTransaction'>;storage:LiquidityStorage;plan:LiquidityExecutionPlan;transactionBase64:string;now?:()=>number;releaseCheck:()=>Promise<boolean>;exclusive?:LiquidityExclusive}){
 return (p.exclusive??browserExclusive)(key(p.plan),async()=>{
 const now=p.now??Date.now;current(p.plan,now());
 const previous=await reconcileUnlocked(p.connection,p.storage,p.plan);
 if(previous?.state==='pending')throw new Error('A liquidity transaction is still pending; reconcile it before another spend');
 if(previous?.plan.messageHash===p.plan.messageHash)throw new Error('This transaction already has a recorded outcome; refresh balances');
 if(!await p.releaseCheck())throw new Error('Liquidity execution is currently disabled');
 const tx=await checkLiquidityMessage(p.plan,p.transactionBase64);
 if(tx.signatures.some(s=>s.every(b=>b===0)))throw new Error('All required wallets must sign before submission');
 current(p.plan,now());if(await p.connection.getBlockHeight('confirmed')>p.plan.lastValidBlockHeight)throw new Error('Transaction expired before submission');
 current(p.plan,now());
 const signature=signatureBase58(tx.signatures[0]),record:PendingLiquidity={plan:p.plan,transactionBase64:p.transactionBase64,signature,state:'pending'};
 // Persist BEFORE networking. A storage failure prevents submission entirely.
 p.storage.setItem(key(p.plan),JSON.stringify(record));
 try{const returned=await p.connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:2});if(returned!==signature)throw new Error('RPC signature differs');}
 catch{return {signature,state:'pending' as const,message:'Submission outcome is unknown. Check the saved transaction before trying again.'};}
 return {signature,state:'pending' as const,message:'Submitted. Awaiting confirmation.'};
 });
}
