import {expect} from 'chai';
import {createHash} from 'node:crypto';
import {Keypair,VersionedTransaction,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {buildCpmmDeposit,buildCpmmWithdraw,cpmmSwapAccounts,approveCompoundRoute,compareCompoundRoutes,type CpmmAccounts} from '@ssr/sdk';
import {simulationReason,simulateLiquidityTransaction,validateCompoundPlan,validateCompoundJupiterInstruction,JUPITER_PROGRAM} from '../lib/mainnet/prepareCompound';
import {createLiveCompoundProviders,type CompoundSnapshot} from '../lib/mainnet/compoundQuotes';
import {parsePrepareCompound} from '../api/mainnet/prepare-compound';
import {validatePreparedCompound} from '../src/merge/lib/liquidity/compoundPreparationClient';
import {buildJupiterSwapInstructionsWithRetry} from '../lib/mainnet/jupiter';
import {cpmmLpMint} from '@ssr/sdk';
import {LIQUIDITY_USDC} from '../src/merge/lib/liquidity/raydiumCpmm';
const key=()=>Keypair.generate().publicKey;
const NOW=1_800_000_000_000;
const treasury=key(),creator=key(),reserve=key(),pool=key(),rt=key();
const accounts:CpmmAccounts={pool,mint0:LIQUIDITY_USDC,mint1:rt,program0:TOKEN_PROGRAM_ID,program1:TOKEN_2022_PROGRAM_ID,vault0:key(),vault1:key()};
const wire=(v:any)=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));
async function rejects(fn:()=>Promise<unknown>,message:string){let error:unknown;try{await fn();}catch(e){error=e;}expect(String(error)).contain(message);}
function snapshot():CompoundSnapshot{return {context:{creator:creator.toBase58(),reserve:reserve.toBase58(),pool:pool.toBase58(),reserveMint:rt.toBase58(),lpMint:key().toBase58(),budgetUsdcRaw:100_000_000n,snapshotSlot:100,stateFingerprint:'state',slippageBps:50,lpDestination:key().toBase58(),lockPolicyId:'unlocked'},readAtMs:NOW,epoch:1n,usdc:1_000_000_000n,tokens:1_000_000_000n,lpSupply:1_000_000_000n,reserveSupply:1_000_000_000n,mintFeeBps:50n,buyTaxBps:100,protocolRate:120000n,fundRate:40000n,reserveTransferFee:{epoch:0n,maximumFee:1000000n,transferFeeBasisPoints:15},assets:[],mintAllowed:false,accountRentRaw:0n};}
function simulationFixture(){
 const c:any={getLatestBlockhash:async()=>({blockhash:key().toBase58(),lastValidBlockHeight:1000}),getRecentPrioritizationFees:async()=>[],getFeeForMessage:async()=>({value:11400}),getBalance:async()=>10000000,
 simulateTransaction:async()=>({context:{slot:102},value:{err:null,unitsConsumed:250000,accounts:[{lamports:7949320}]}})};
 const p={connection:c,instructions:[buildCpmmDeposit(accounts,treasury,100n,200n,300n)],treasury,creator,action:'compound' as const,reserve,pool,expiresAtMs:NOW+25000,executionEnabled:false,now:()=>NOW,maximumSol:5_000_000n};
 return {c,p};
}
describe('Atomic Compound preparation',()=>{
 it('encodes native LP output and both gross deposit caps in the verified account order',()=>{
  const ix=buildCpmmDeposit(accounts,treasury,123n,456n,789n);
  expect(ix.data.subarray(0,8).equals(createHash('sha256').update('global:deposit').digest().subarray(0,8))).eq(true);
  expect([8,16,24].map(n=>ix.data.readBigUInt64LE(n))).deep.eq([123n,456n,789n]);
  expect(ix.keys.length).eq(13);expect(ix.keys[0].pubkey.equals(treasury)&&ix.keys[0].isSigner).eq(true);
  expect(ix.keys[4].pubkey.equals(getAssociatedTokenAddressSync(LIQUIDITY_USDC,treasury))).eq(true);
  expect(ix.keys[5].pubkey.equals(getAssociatedTokenAddressSync(rt,treasury,false,TOKEN_2022_PROGRAM_ID))).eq(true);
 });
 it('encodes withdrawal net minima and rejects zero/overflow amounts',()=>{
  const ix=buildCpmmWithdraw(accounts,treasury,123n,456n,789n);
  expect(ix.data.subarray(0,8).equals(createHash('sha256').update('global:withdraw').digest().subarray(0,8))).eq(true);
  expect(ix.keys.length).eq(14);expect(ix.data.readBigUInt64LE(24)).eq(789n);
  expect(()=>buildCpmmDeposit(accounts,treasury,0n,1n,1n)).throws();
  expect(()=>buildCpmmDeposit(accounts,treasury,1n,1n<<64n,1n)).throws();
  expect(()=>buildCpmmWithdraw(accounts,treasury,1n,0n,1n)).throws();
 });
 it('reverses native swap roles correctly and rejects unrelated input mints',()=>{
  const buy=cpmmSwapAccounts(accounts,treasury,key(),LIQUIDITY_USDC),sell=cpmmSwapAccounts(accounts,treasury,key(),rt);
  expect(buy[6].pubkey.equals(accounts.vault0)&&sell[6].pubkey.equals(accounts.vault1)).eq(true);
  expect(sell[8].pubkey.equals(TOKEN_2022_PROGRAM_ID)).eq(true);
  expect(()=>cpmmSwapAccounts(accounts,treasury,key(),key())).throws();
 });
 it('revalidates the selected pool plan against current state, transfer fee and post-swap ratio',async()=>{
  const s=snapshot();let plan:any;
  const q=await createLiveCompoundProviders(s,{jupiterApiKey:'',prices:new Map(),now:()=>NOW,recordPlan:(_id,p)=>plan=p}).pool();
  expect(()=>validateCompoundPlan(s,q,plan)).not.throws();
  expect(()=>validateCompoundPlan({...s,context:{...s.context,stateFingerprint:'changed'}},q,plan)).throws('state changed');
  expect(()=>validateCompoundPlan(s,q,{...plan,amount:1n})).throws('plan changed');
  expect(()=>validateCompoundPlan(s,{...q,depositReserveNetRaw:q.depositReserveNetRaw-1n},plan)).throws('transfer fee');
  expect(()=>validateCompoundPlan({...s,context:{...s.context,lpMint:key().toBase58()}},q,plan)).throws('destination');
 });
 it('requires the original content-bound approval when decoding a preparation request',async()=>{
  const s=snapshot();let plan:any;
  const providers=createLiveCompoundProviders(s,{jupiterApiKey:'',prices:new Map(),now:()=>NOW,recordPlan:(_id,p)=>plan=p});
  const comparison=await compareCompoundRoutes(s.context,providers,()=>NOW),quote=comparison.quotes[0];
  const approval=approveCompoundRoute(comparison,'pool',creator.toBase58(),NOW);
  const body=wire({quote,approval,acquisitionPlan:plan});
  expect(parsePrepareCompound(body,NOW).acquisitionPlan.amount).eq(quote.acquisitionUsdcRaw);
  expect(()=>parsePrepareCompound({...body,approval:{...approval,creator:treasury.toBase58()}},NOW)).throws('Creator');
  expect(()=>parsePrepareCompound({...body,acquisitionPlan:{amount:'-1'}},NOW)).throws('Invalid');
  expect(()=>parsePrepareCompound(body,NOW+26000)).throws('expired');
 });
 it('returns an unsigned exact message with creator AND treasury approval and measured SOL costs',async()=>{
  const {p}=simulationFixture(),r=await simulateLiquidityTransaction(p);
  expect(r.requiredSigners).deep.eq([treasury.toBase58(),creator.toBase58()]);
  expect(r.networkFeeRaw).eq('11400');expect(r.accountRentRaw).eq('2039280');expect(r.executionEnabled).eq(false);
  const tx=VersionedTransaction.deserialize(Buffer.from(r.transactionBase64,'base64'));
  expect(tx.signatures.every(s=>s.every(n=>n===0))).eq(true);
  expect(r.messageHash).eq(createHash('sha256').update(tx.message.serialize()).digest('hex'));
 });
 it('explains a failed simulation in plain words, from its logs',async()=>{
  expect(simulationReason(['Program 11111111111111111111111111111111 invoke [2]','Transfer: insufficient lamports 66089760, need 150000000'])).eq('a wallet in this transaction does not have enough SOL');
  expect(simulationReason(['Program log: Error: insufficient funds'])).eq('a token balance is too low');
  expect(simulationReason(['Program log: AnchorError occurred. Error Code: X. Error Number: 6000. Error Message: Pool already exists.'])).eq('Pool already exists');
  expect(simulationReason(null)).eq('a program rejected it');
  const {p,c}=simulationFixture();c.simulateTransaction=async()=>({value:{err:{InstructionError:[7,{Custom:1}]},logs:['Transfer: insufficient lamports 1, need 2']}});
  await rejects(()=>simulateLiquidityTransaction(p),'does not have enough SOL');
 });
 it('starts the signing window after simulation and never lets it outlive the blockhash',async()=>{
  const run=async(simulatedAt:number,reviewWindowMs?:number)=>{const {p,c}=simulationFixture();let clock=NOW;const bh=c.getLatestBlockhash,sim=c.simulateTransaction;
   c.getLatestBlockhash=async()=>{clock=NOW+2000;return bh();};c.simulateTransaction=async()=>{clock=NOW+simulatedAt;return sim();};
   return simulateLiquidityTransaction({...p,expiresAtMs:NOW+30000,reviewWindowMs,now:()=>clock});};
  const fast=await run(3000,45000);expect(fast.serverNowMs).eq(NOW+3000);expect(fast.expiresAtMs).eq(NOW+48000);
  const slow=await run(20000,45000);expect(slow.expiresAtMs).eq(NOW+2000+55000);
  const fixed=await run(3000);expect(fixed.expiresAtMs).eq(NOW+30000);
 });
 it('rejects failed simulation, unknown fee, unexpected signer, expired or oversized plans',async()=>{
  {const {p,c}=simulationFixture();c.simulateTransaction=async()=>({value:{err:{InstructionError:[1,'failure']}}});await rejects(()=>simulateLiquidityTransaction(p),'simulation failed');}
  {const {p,c}=simulationFixture();c.getFeeForMessage=async()=>({value:null});await rejects(()=>simulateLiquidityTransaction(p),'fee unavailable');}
  {const {p}=simulationFixture();await rejects(()=>simulateLiquidityTransaction({...p,expiresAtMs:NOW}),'expired');}
  {const {p}=simulationFixture();p.instructions.push(new TransactionInstruction({programId:key(),keys:[{pubkey:key(),isSigner:true,isWritable:false}],data:Buffer.alloc(0)}));await rejects(()=>simulateLiquidityTransaction(p),'Unexpected transaction signer');}
  {const {p}=simulationFixture();p.instructions.push(new TransactionInstruction({programId:key(),keys:[],data:Buffer.alloc(1400)}));await rejects(()=>simulateLiquidityTransaction(p),'transaction');}
 });
 it('rejects SOL cap breaches and simulations that hide full network fees',async()=>{
  {const {p}=simulationFixture();await rejects(()=>simulateLiquidityTransaction({...p,maximumSol:1n}),'exceeds');}
  {const {p,c}=simulationFixture();c.simulateTransaction=async()=>({value:{err:null,accounts:[{lamports:10000000}]}});await rejects(()=>simulateLiquidityTransaction(p),'complete fees');}
 });
 it('permits a separate permissionless Collect payer without requiring creator signatures',async()=>{
  const {p}=simulationFixture(),payer=key();
  const r=await simulateLiquidityTransaction({...p,instructions:[],feePayer:payer,action:'collect'});
  expect(r.requiredSigners).deep.eq([payer.toBase58()]);
 });
 it('pins Jupiter ExactOut caps, mints, destinations and signing authority',()=>{
  const q:any={inputMint:LIQUIDITY_USDC.toBase58(),outputMint:rt.toBase58(),inAmount:'100',outAmount:'95',slippageBps:50};
  const data=Buffer.alloc(40);createHash('sha256').update('global:shared_accounts_exact_out_route').digest().copy(data,0,0,8);
  data.writeBigUInt64LE(95n,data.length-19);data.writeBigUInt64LE(100n,data.length-11);data.writeUInt16LE(50,data.length-3);
  const keys=Array.from({length:11},()=>({pubkey:key().toBase58(),isSigner:false,isWritable:true}));
  for(const [i,k] of [[2,treasury],[3,getAssociatedTokenAddressSync(LIQUIDITY_USDC,treasury)],[6,getAssociatedTokenAddressSync(rt,treasury,false,TOKEN_2022_PROGRAM_ID)],[7,LIQUIDITY_USDC],[8,rt]] as const)keys[i].pubkey=k.toBase58();
  keys[2].isSigner=true;
  const w={programId:JUPITER_PROGRAM.toBase58(),accounts:keys,data:data.toString('base64')};
  expect(()=>validateCompoundJupiterInstruction(w,q,treasury,TOKEN_2022_PROGRAM_ID)).not.throws();
  expect(()=>validateCompoundJupiterInstruction(w,{...q,inAmount:'101'},treasury,TOKEN_2022_PROGRAM_ID)).throws('cap');
  keys[6].pubkey=key().toBase58();expect(()=>validateCompoundJupiterInstruction(w,q,treasury,TOKEN_2022_PROGRAM_ID)).throws('redirected');
 });
 it('rejects missing simulated token balances rather than claiming protected LP output',async()=>{
  const {p}=simulationFixture();
  await rejects(()=>simulateLiquidityTransaction({...p,watch:[{address:key(),program:TOKEN_PROGRAM_ID,minimum:1n}]}),'expected token account');
 });
 it('checks the browser review message, authority, execution gate and costs',async()=>{
  const {p}=simulationFixture(),s=snapshot();s.context.lpMint=cpmmLpMint(pool).toBase58();s.context.lpDestination=getAssociatedTokenAddressSync(cpmmLpMint(pool),treasury).toBase58();
  const q=await createLiveCompoundProviders(s,{jupiterApiKey:'',prices:new Map(),now:()=>NOW}).pool();
  const prepared=await simulateLiquidityTransaction({...p,quoteId:q.id});
  expect((await validatePreparedCompound(prepared,q,treasury.toBase58(),NOW)).messageHash).eq(prepared.messageHash);
  await rejects(()=>validatePreparedCompound({...prepared,messageHash:'changed'},q,treasury.toBase58(),NOW),'transaction changed');
  await rejects(()=>validatePreparedCompound({...prepared,executionEnabled:true},q,treasury.toBase58(),NOW),'not been released');
  await rejects(()=>validatePreparedCompound({...prepared,networkFeeRaw:'1'},q,treasury.toBase58(),NOW),'cost');
  await rejects(()=>validatePreparedCompound(prepared,q,key().toBase58(),NOW),'destination');
  await rejects(()=>validatePreparedCompound(prepared,q,treasury.toBase58(),NOW+26000),'stale');
 });

 it('builds Jupiter instructions without dynamic slippage or an empty credential header',async()=>{
  const previous=globalThis.fetch;const requests:any[]=[];
  globalThis.fetch=(async(_url:any,options:any)=>{requests.push(options);return new Response(JSON.stringify({swapInstruction:{programId:JUPITER_PROGRAM.toBase58(),accounts:[],data:''}}),{status:200});}) as any;
  try{
   const args={quote:{inAmount:'100',outAmount:'95',priceImpactPct:'0'},userPublicKey:treasury.toBase58(),apiKey:''};
   await buildJupiterSwapInstructionsWithRetry({...args,dynamicSlippage:false,useSharedAccounts:true});
   expect(JSON.parse(requests[0].body)).include({dynamicSlippage:false,useSharedAccounts:true,wrapAndUnwrapSol:false});
   expect(requests[0].headers).not.have.property('x-api-key');
   await buildJupiterSwapInstructionsWithRetry({...args,apiKey:'fixture-key'});
   expect(JSON.parse(requests[1].body).dynamicSlippage).eq(true);
   expect(requests[1].headers['x-api-key']).eq('fixture-key');
  }finally{globalThis.fetch=previous;}
 });

});
