/** Exact-message co-signing and durable atomic-transaction recovery.
 * A network timeout never authorizes a second spend or a new blockhash. */
import {Buffer} from 'buffer';
import {VersionedTransaction,SendTransactionError,SolanaJSONRPCError,type AddressLookupTableAccount,type VersionedMessage,type PublicKey,type Connection} from '@solana/web3.js';
/** Reads address lookup tables, so a wallet-rebuilt message can be compared account by account. */
export type LookupTableLoader=(keys:PublicKey[])=>Promise<AddressLookupTableAccount[]>;
export interface LiquidityExecutionPlan {
 action:string;reserve:string;treasury:string;transactionBase64:string;messageHash:string;requiredSigners:string[];
 blockhash:string;lastValidBlockHeight:number;expiresAtMs:number;executionEnabled:boolean;confirmationText:string;serverNowMs?:number;
}
/** 'rejected': the RPC explicitly refused it before broadcast (preflight or JSON-RPC error), so it can never land. */
export interface PendingLiquidity {plan:LiquidityExecutionPlan;transactionBase64:string;signature:string;state:'pending'|'confirmed'|'failed'|'expired'|'rejected';error?:string;}
/** Re-measures a server review window on this browser's clock, so a skewed clock neither shortens nor stretches it. */
export function onLocalClock<T extends {expiresAtMs:number;serverNowMs?:number}>(plan:T,receivedAtMs=Date.now()):T{
 if(!Number.isSafeInteger(plan.serverNowMs)||!Number.isSafeInteger(plan.expiresAtMs))return plan;
 return {...plan,expiresAtMs:receivedAtMs+Math.max(0,plan.expiresAtMs-plan.serverNowMs!)-1000};
}
/** An explicit JSON-RPC error means the node refused the transaction; anything else (timeout, HTTP, network) is ambiguous. */
export function definiteRejection(e:unknown):string|null{
 const name=(e as {name?:string})?.name;
 if(!(e instanceof SendTransactionError||e instanceof SolanaJSONRPCError||name==='SendTransactionError'||name==='SolanaJSONRPCError'))return null;
 const logs=(e as {logs?:string[];transactionLogs?:string[]}).logs??(e as {transactionLogs?:string[]}).transactionLogs??[];
 const message=e instanceof Error?e.message:String(e);
 return [message,...(Array.isArray(logs)?logs.slice(-8):[])].join('\n');
}
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
// Phantom rewrites single-signer transactions before signing: it replaces the compute budget and
// wraps the instructions in Lighthouse balance assertions. Accept that rewrite only when every
// reviewed instruction survives byte-for-byte, in order, with the same accounts. Rebuilding a message can
// reorder its lookup-table references or move an account between the table and the static keys, so when the
// tables are available every account is compared by its resolved address and writable flag.
const LIGHTHOUSE='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',COMPUTE_BUDGET='ComputeBudget111111111111111111111111111111';
export const MAX_WALLET_PRIORITY_LAMPORTS=2_000_000n;
function resolvedInstructions(m:VersionedMessage,tables?:AddressLookupTableAccount[]){
 let keys:string[];
 if(tables&&m.addressTableLookups.length){
  const all=m.getAccountKeys({addressLookupTableAccounts:tables});
  keys=Array.from({length:all.length},(_,i)=>`${all.get(i)!.toBase58()}:${m.isAccountWritable(i)?'w':'r'}${m.isAccountSigner(i)?'s':''}`);
 }else{
  keys=m.staticAccountKeys.map((k,i)=>`${k.toBase58()}:${m.isAccountWritable(i)?'w':'r'}${m.isAccountSigner(i)?'s':''}`);
  for(const l of m.addressTableLookups)for(const i of l.writableIndexes)keys.push(`${l.accountKey.toBase58()}#${i}:w`);
  for(const l of m.addressTableLookups)for(const i of l.readonlyIndexes)keys.push(`${l.accountKey.toBase58()}#${i}:r`);
 }
 return m.compiledInstructions.map(ix=>({program:m.staticAccountKeys[ix.programIdIndex]?.toBase58()??'',accounts:ix.accountKeyIndexes.map(i=>keys[i]),data:Buffer.from(ix.data).toString('hex')}));
}
export function isWalletGuardedRewrite(reviewed:VersionedMessage,signed:VersionedMessage,tables?:AddressLookupTableAccount[]):boolean{
 if(reviewed.version!==0||signed.version!==0||reviewed.recentBlockhash!==signed.recentBlockhash||reviewed.header.numRequiredSignatures!==signed.header.numRequiredSignatures)return false;
 if(!reviewed.staticAccountKeys[0]?.equals(signed.staticAccountKeys[0]))return false;
 const lookups=(m:VersionedMessage)=>JSON.stringify(m.addressTableLookups.map(l=>[l.accountKey.toBase58(),[...l.writableIndexes],[...l.readonlyIndexes]]));
 const resolved=!!tables&&(reviewed.addressTableLookups.length>0||signed.addressTableLookups.length>0);
 if(!resolved&&lookups(reviewed)!==lookups(signed))return false;
 const tableSet=new Set((tables??[]).map(t=>t.key.toBase58()));
 if(resolved&&[...reviewed.addressTableLookups,...signed.addressTableLookups].some(l=>!tableSet.has(l.accountKey.toBase58())))return false;
 let reviewedIxs:ReturnType<typeof resolvedInstructions>,signedIxs:ReturnType<typeof resolvedInstructions>;
 try{reviewedIxs=resolvedInstructions(reviewed,resolved?tables:undefined);signedIxs=resolvedInstructions(signed,resolved?tables:undefined);}catch{return false;}
 const core=(ixs:typeof reviewedIxs)=>JSON.stringify(ixs.filter(ix=>ix.program!==COMPUTE_BUDGET&&ix.program!==LIGHTHOUSE));
 if(reviewedIxs.some(ix=>ix.program===LIGHTHOUSE)||core(reviewedIxs)!==core(signedIxs))return false;
 let limit:bigint|null=null,price=0n;const seen=new Set<number>();
 for(const ix of signedIxs.filter(ix=>ix.program===COMPUTE_BUDGET)){
  const data=Buffer.from(ix.data,'hex'),tag=data[0];if(seen.has(tag)||ix.accounts.length)return false;seen.add(tag);
  if(tag===2&&data.length===5)limit=BigInt(data.readUInt32LE(1));
  else if(tag===3&&data.length===9)price=data.readBigUInt64LE(1);
  else if(!((tag===1||tag===4)&&data.length===5))return false;
 }
 return price*(limit??1_400_000n)/1_000_000n<=MAX_WALLET_PRIORITY_LAMPORTS;
}
export async function checkLiquidityMessage(plan:LiquidityExecutionPlan,serialized=plan.transactionBase64,loadTables?:LookupTableLoader):Promise<VersionedTransaction>{
 if(typeof serialized!=='string'||serialized.length>1644)throw new Error('Invalid liquidity transaction');
 const bytes=Buffer.from(serialized,'base64');
 if(bytes.length>1232||bytes.toString('base64')!==serialized||!Array.isArray(plan.requiredSigners)||!Number.isSafeInteger(plan.lastValidBlockHeight)||plan.lastValidBlockHeight<0)throw new Error('Invalid liquidity transaction');
 const tx=VersionedTransaction.deserialize(bytes);
 if(tx.message.recentBlockhash!==plan.blockhash)throw new Error('Liquidity transaction changed; review again');
 const rewritten=await digest(tx.message.serialize())!==plan.messageHash;
 if(rewritten){
  const reviewed=serialized===plan.transactionBase64?null:VersionedTransaction.deserialize(Buffer.from(plan.transactionBase64,'base64'));
  if(!reviewed||await digest(reviewed.message.serialize())!==plan.messageHash)throw new Error('Liquidity transaction changed; review again');
  const tableKeys=[...new Map([...reviewed.message.addressTableLookups,...tx.message.addressTableLookups].map(l=>[l.accountKey.toBase58(),l.accountKey])).values()];
  const tables=tableKeys.length&&loadTables?await loadTables(tableKeys).catch(()=>undefined):undefined;
  if(!isWalletGuardedRewrite(reviewed.message,tx.message,tables))throw new Error('Your wallet changed this transaction in a way that could not be verified against the review, so it was not sent and nothing was spent. Prepare it again.');
 }
 const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
 if(signers.map(s=>s.toBase58()).join(',')!==plan.requiredSigners.join(','))throw new Error('Liquidity authorities changed');
 for(let i=0;i<signers.length;i++)if(tx.signatures[i].some(b=>b!==0)){
  const publicKey=await crypto.subtle.importKey('raw',Uint8Array.from(signers[i].toBytes()),{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,Uint8Array.from(tx.signatures[i]),Uint8Array.from(tx.message.serialize())))throw new Error(rewritten?'Your wallet modified a transaction that was already co-signed, which voids the co-signature. Nothing was sent. Prepare it again.':'Invalid liquidity signature');
 }
 return tx;
}
function current(p:LiquidityExecutionPlan,now:number){
 if(!p.executionEnabled)throw new Error('Liquidity execution has not been released');
 if(!Number.isSafeInteger(p.expiresAtMs)||now>=p.expiresAtMs)throw new Error('Liquidity review expired before it was sent, so nothing was submitted or spent. Prepare it again for a fresh review.');
}
export async function signLiquidityPlan(p:{plan:LiquidityExecutionPlan;transactionBase64?:string;confirmation:string;wallet:{publicKey:PublicKey|null;signTransaction?:(tx:VersionedTransaction)=>Promise<VersionedTransaction>};now?:()=>number;loadTables?:LookupTableLoader}){
 const now=p.now??Date.now;current(p.plan,now());
 if(p.confirmation!==p.plan.confirmationText)throw new Error(`Type ${p.plan.confirmationText} to approve this transaction`);
 const walletKey=p.wallet.publicKey?.toBase58();
 if(!walletKey||!p.plan.requiredSigners.includes(walletKey)||!p.wallet.signTransaction)throw new Error('Connect one of the required signing wallets');
 const tx=await checkLiquidityMessage(p.plan,p.transactionBase64),previous=tx.signatures.map(s=>Uint8Array.from(s));
 const signed=await p.wallet.signTransaction(tx);current(p.plan,now());
 if(p.wallet.publicKey?.toBase58()!==walletKey)throw new Error('Signing wallet changed');
 const verified=await checkLiquidityMessage(p.plan,encode(signed),p.loadTables);
 for(let i=0;i<previous.length;i++)if(previous[i].some(b=>b!==0)&&!previous[i].every((b,j)=>verified.signatures[i][j]===b))throw new Error('Wallet removed an existing co-signature');
 const index=p.plan.requiredSigners.indexOf(walletKey);
 if(!verified.signatures[index].some(b=>b!==0))throw new Error('Wallet did not sign this transaction');
 return {transactionBase64:encode(verified),missingSigners:p.plan.requiredSigners.filter((_,i)=>!verified.signatures[i].some(b=>b!==0))};
}
export function readPendingLiquidity(storage:LiquidityStorage,plan:LiquidityExecutionPlan):PendingLiquidity|null{
 const raw=storage.getItem(key(plan));if(!raw)return null;
 let record:PendingLiquidity;try{record=JSON.parse(raw);}catch{throw new Error('Saved liquidity transaction needs reconciliation before another spend');}
 if(!record?.plan||record.plan.reserve!==plan.reserve||record.plan.treasury!==plan.treasury||!['pending','confirmed','failed','expired','rejected'].includes(record.state)||typeof record.signature!=='string')throw new Error('Saved liquidity transaction is invalid; do not submit again');
 return record;
}
async function reconcileUnlocked(connection:Pick<Connection,'getSignatureStatuses'|'getBlockHeight'>,storage:LiquidityStorage,plan:LiquidityExecutionPlan,loadTables?:LookupTableLoader):Promise<PendingLiquidity|null>{
 const record=readPendingLiquidity(storage,plan);if(!record)return null;
 // A rejection is explicit, but confirm on chain once before releasing the next spend.
 if(record.state==='rejected'){const seen=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];
  if(seen){record.state=seen.confirmationStatus==='confirmed'||seen.confirmationStatus==='finalized'?(seen.err?'failed':'confirmed'):'pending';storage.setItem(key(plan),JSON.stringify(record));}
  if(record.state!=='pending')return record;}
 if(record.state!=='pending')return record;
 const tx=await checkLiquidityMessage(record.plan,record.transactionBase64,loadTables);
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
export async function reconcileLiquidity(connection:Pick<Connection,'getSignatureStatuses'|'getBlockHeight'>,storage:LiquidityStorage,plan:LiquidityExecutionPlan,exclusive:LiquidityExclusive=browserExclusive,loadTables?:LookupTableLoader){
 return exclusive(key(plan),()=>reconcileUnlocked(connection,storage,plan,loadTables));
}
export async function submitLiquidityPlan(p:{connection:Pick<Connection,'getSignatureStatuses'|'getBlockHeight'|'sendRawTransaction'>;storage:LiquidityStorage;plan:LiquidityExecutionPlan;transactionBase64:string;now?:()=>number;releaseCheck:()=>Promise<boolean>;exclusive?:LiquidityExclusive;loadTables?:LookupTableLoader}){
 return (p.exclusive??browserExclusive)(key(p.plan),async()=>{
 const now=p.now??Date.now;current(p.plan,now());
 const previous=await reconcileUnlocked(p.connection,p.storage,p.plan,p.loadTables);
 if(previous?.state==='pending')throw new Error('A liquidity transaction is still pending; reconcile it before another spend');
 if(previous?.plan.messageHash===p.plan.messageHash)throw new Error('This transaction already has a recorded outcome; refresh balances');
 if(!await p.releaseCheck())throw new Error('Liquidity execution is currently disabled');
 const tx=await checkLiquidityMessage(p.plan,p.transactionBase64,p.loadTables);
 if(tx.signatures.some(s=>s.every(b=>b===0)))throw new Error('All required wallets must sign before submission');
 current(p.plan,now());if(await p.connection.getBlockHeight('confirmed')>p.plan.lastValidBlockHeight)throw new Error('Transaction expired before submission');
 current(p.plan,now());
 const signature=signatureBase58(tx.signatures[0]),record:PendingLiquidity={plan:p.plan,transactionBase64:p.transactionBase64,signature,state:'pending'};
 // Persist BEFORE networking. A storage failure prevents submission entirely.
 p.storage.setItem(key(p.plan),JSON.stringify(record));
 let returned:string;
 try{returned=await p.connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:2});}
 catch(e){
  const rejection=definiteRejection(e);
  if(rejection===null)return {signature,state:'pending' as const,message:'Submission outcome is unknown. Check the saved transaction before trying again.'};
  p.storage.setItem(key(p.plan),JSON.stringify({...record,state:'rejected',error:rejection}));
  return {signature,state:'rejected' as const,message:`The network rejected this transaction before broadcasting it, so nothing was spent. Prepare it again.\n${rejection}`};
 }
 if(returned!==signature)return {signature,state:'pending' as const,message:'Submission outcome is unknown. Check the saved transaction before trying again.'};
 return {signature,state:'pending' as const,message:'Submitted. Awaiting confirmation.'};
 });
}
