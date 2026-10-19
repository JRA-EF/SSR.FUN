import {loadLiquidityTables} from './liquidityLookup';
import {appendTrancheLock,type TrancheChoice} from './liquidityTranches';
export type {TrancheChoice} from './liquidityTranches';
/** Canonical-pool lifecycle. Read, validate, construct and simulate only. */
import {createHash} from 'node:crypto';
import {PublicKey,SYSVAR_CLOCK_PUBKEY,type TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,unpackAccount,unpackMint,getTransferFeeConfig,getEpochFee,getTransferHook,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {buildAuthorizeLiquidityAddition,findProtocolConfig,findReserve,findLiquidityRevenue,findLiquidityTerms,findBasketFeed,decodeLiquidityTerms,cpmmLpMint,cpmmAuthority,buildCpmmDeposit,buildCpmmWithdraw,buildMakeLiquidityTranchePermanent,buildExtendLiquidityTranche,buildWithdrawLiquidityTranche,findLiquidityTranche} from '@ssr/sdk';
import {RAYDIUM_CPMM,SSR_CPMM_CONFIG,LIQUIDITY_USDC,decodePool,decodeConfig,creatorShareAddress,effectiveCreatorShare,prepareRevenueCollect} from '../../src/merge/lib/liquidity/raydiumCpmm';
import {transferNet,transferGross,type CompoundReadDeps} from './compoundQuotes';
import {simulateLiquidityTransaction} from './prepareCompound';
const check=(ok:unknown,message:string):void=>{if(!ok)throw new Error(message);};
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const min=(a:bigint,b:bigint)=>a<b?a:b;
export function canonicalLiquidityPool(mint:PublicKey){const [a,b]=[mint,LIQUIDITY_USDC].sort((x,y)=>Buffer.compare(x.toBuffer(),y.toBuffer()));return PublicKey.findProgramAddressSync([Buffer.from('pool'),SSR_CPMM_CONFIG.toBuffer(),a.toBuffer(),b.toBuffer()],RAYDIUM_CPMM)[0];}
export async function readLiquidityState(deps:CompoundReadDeps,reserve:PublicKey){
 const {connection,program,programId}=deps,first=await connection.getAccountInfo(reserve,'confirmed');
 check(first?.owner.equals(programId),'Reserve unavailable');
 const hint=program.coder.accounts.decode('reserve',first!.data),mint=new PublicKey(hint.reserveTokenMint),treasury=new PublicKey(hint.feeConfig.feeDestination);
 const pool=canonicalLiquidityPool(mint),lp=cpmmLpMint(pool),revenue=findLiquidityRevenue(reserve,programId),protocolConfig=findProtocolConfig(programId)[0];
 const [m0,m1]=[mint,LIQUIDITY_USDC].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
 const vault=(m:PublicKey)=>PublicKey.findProgramAddressSync([Buffer.from('pool_vault'),pool.toBuffer(),m.toBuffer()],RAYDIUM_CPMM)[0];
 const ata=(m:PublicKey,p=TOKEN_PROGRAM_ID,o=treasury)=>getAssociatedTokenAddressSync(m,o,true,p);
 const keys=[reserve,protocolConfig,mint,revenue,pool,SSR_CPMM_CONFIG,creatorShareAddress(revenue),lp,SYSVAR_CLOCK_PUBKEY,ata(LIQUIDITY_USDC),ata(mint,TOKEN_2022_PROGRAM_ID),ata(lp),vault(m0),vault(m1),ata(LIQUIDITY_USDC,TOKEN_PROGRAM_ID,revenue),findLiquidityTerms(reserve,programId),findBasketFeed(reserve,programId)];
 const batch=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed'}),a=batch.value;
 const owned=(i:number,owner:PublicKey)=>{check(a[i]?.owner.equals(owner),'Liquidity account owner mismatch');return a[i]!;};
 const r=program.coder.accounts.decode('reserve',owned(0,programId).data),protocol=program.coder.accounts.decode('protocolConfig',owned(1,programId).data);
 check(new PublicKey(r.reserveTokenMint).equals(mint)&&new PublicKey(r.feeConfig.feeDestination).equals(treasury)&&findReserve(BigInt(r.reserveId.toString()),programId)[0].equals(reserve),'Reserve identity or treasury changed');
 const creator=new PublicKey(r.manager),protocolTreasury=new PublicKey(protocol.defaultProtocolFeeDestination);
 const rt=unpackMint(mint,owned(2,TOKEN_2022_PROGRAM_ID),TOKEN_2022_PROGRAM_ID),hook=getTransferHook(rt),config=getTransferFeeConfig(rt);
 check(rt.isInitialized&&rt.supply>0n&&config&&(!hook||hook.programId.equals(PublicKey.default)),'A seeded Token-2022 Reserve without an active transfer hook is required');
 check(a[8]?.data.length===40,'Chain clock unavailable');
 const epoch=a[8]!.data.readBigUInt64LE(16),time=a[8]!.data.readBigInt64LE(32),fee=getEpochFee(config!,epoch);
 const balance=(i:number,m:PublicKey,p=TOKEN_PROGRAM_ID,o=treasury)=>{if(!a[i])return 0n;const t=unpackAccount(keys[i],owned(i,p),p);check(t.owner.equals(o)&&t.mint.equals(m)&&t.isInitialized&&!t.isFrozen,'Invalid liquidity token account');return t.amount;};
 const usdcBalance=balance(9,LIQUIDITY_USDC),reserveBalance=balance(10,mint,TOKEN_2022_PROGRAM_ID),lpBalance=balance(11,lp),staged=balance(14,LIQUIDITY_USDC,TOKEN_PROGRAM_ID,revenue);
 const rates=decodeConfig(a[5]),retention=effectiveCreatorShare(a[6],revenue,rates.creatorFeeShareRate);
 check(retention<=50000n,'Creator fee economics require review');
 let registered:ReturnType<typeof decodePool>|null=null,router:any=null,usdc=0n,tokens=0n,lpSupply=0n,status=0,openTime=0n,lpDecimals=9;
 if(a[4]){
  registered=decodePool(a[4],mint,revenue);const data=a[4]!.data;
  check(registered.mint0.equals(m0)&&registered.mint1.equals(m1)&&registered.vault0.equals(keys[12])&&registered.vault1.equals(keys[13])&&new PublicKey(data.subarray(136,168)).equals(lp),'Noncanonical pool accounts');
  check((m0.equals(mint)?registered.program0:registered.program1).equals(TOKEN_2022_PROGRAM_ID),'Reserve pool token program changed');
  router=program.coder.accounts.decode('liquidityRevenue',owned(3,programId).data);
  check(new PublicKey(router.reserve).equals(reserve)&&new PublicKey(router.pool).equals(pool)&&new PublicKey(router.treasury).equals(treasury)&&BigInt(router.retainedRate.toString())===retention,'Creator revenue registration changed');
  const values=[0,1].map(i=>{const amount=balance(12+i,i?m1:m0,i?registered!.program1:registered!.program0,cpmmAuthority());const fees=data.readBigUInt64LE(341+i*8)+data.readBigUInt64LE(357+i*8)+data.readBigUInt64LE(397+i*8);check(amount>fees,'Pool has no usable liquidity');return amount-fees;});
  usdc=values[m0.equals(LIQUIDITY_USDC)?0:1];tokens=values[m0.equals(mint)?0:1];lpSupply=data.readBigUInt64LE(333);status=data[329];openTime=data.readBigUInt64LE(373);
  const lpt=unpackMint(lp,owned(7,TOKEN_PROGRAM_ID));check(lpt.isInitialized&&lpt.mintAuthority?.equals(cpmmAuthority())&&lpt.supply<=lpSupply&&lpSupply>0n,'Invalid pool LP mint');lpDecimals=lpt.decimals;
 }else check(!a[3]&&!a[7],'Incomplete canonical pool registration');
 // DEC-0251: v2 pools carry their terms (holder share fixed at launch) and a basket feed.
 const terms=a[15]?decodeLiquidityTerms(owned(15,programId).data):null;
 check(!terms||(terms.reserve.equals(reserve)&&terms.revenue.equals(revenue)),'Liquidity terms registration changed');
 const feedBalance=terms?balance(16,LIQUIDITY_USDC,TOKEN_PROGRAM_ID,keys[15]):0n;
 return {reserve,mint,treasury,creator,protocolTreasury,protocolConfig,pool,lp,revenue,ata,rt,fee,time,epoch,slot:batch.context.slot,paused:!!protocol.paused,registered,router,usdc,tokens,lpSupply,status,openTime,lpDecimals,usdcBalance,reserveBalance,lpBalance,staged,retention,terms,feedBalance,
  fingerprint:createHash('sha256').update(JSON.stringify(keys.map((k,i)=>[k.toBase58(),i===8?epoch.toString():a[i]?.data.toString('base64')??null]))).digest('hex')};
}
export type LiquidityState=Awaited<ReturnType<typeof readLiquidityState>>;
export function addAmounts(s:Pick<LiquidityState,'fee'|'usdc'|'tokens'|'lpSupply'>,maxUsdc:bigint,maxReserve:bigint,slippageBps:number){
 check(maxUsdc>0n&&maxReserve>0n&&maxUsdc<=0xffffffffffffffffn&&maxReserve<=0xffffffffffffffffn,'Invalid addition caps');
 check(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=100,'Slippage must be between zero and one percent');
 const lp=min(maxUsdc*s.lpSupply/s.usdc,transferNet(maxReserve,s.fee)*s.lpSupply/s.tokens)*BigInt(10000-slippageBps)/10000n;
 check(lp>0n&&lp*s.usdc/s.lpSupply>0n&&lp*s.tokens/s.lpSupply>0n,'Addition is too small');
 const usdc=ceil(lp*s.usdc,s.lpSupply),reserve=transferGross(ceil(lp*s.tokens,s.lpSupply),s.fee);
 check(usdc<=maxUsdc&&reserve<=maxReserve,'Addition exceeds reviewed caps');return {lp,usdc,reserve};
}
export function withdrawAmounts(s:Pick<LiquidityState,'fee'|'usdc'|'tokens'|'lpSupply'>,lp:bigint,slippageBps:number){
 check(lp>0n&&lp<=s.lpSupply,'Invalid LP withdrawal');check(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=100,'Slippage must be between zero and one percent');
 const usdc=lp*s.usdc/s.lpSupply,reserve=transferNet(lp*s.tokens/s.lpSupply,s.fee),minimumUsdc=usdc*BigInt(10000-slippageBps)/10000n,minimumReserve=reserve*BigInt(10000-slippageBps)/10000n;
 check(minimumUsdc>0n&&minimumReserve>0n,'Withdrawal is too small');return {usdc,reserve,minimumUsdc,minimumReserve};
}
export interface LifecycleInput{reserve:PublicKey;actor:PublicKey;action:'create'|'add'|'withdraw'|'collect'|'lock'|'extend'|'unlock'|'permanent';maximumUsdcRaw?:bigint;maximumReserveRaw?:bigint;lpAmountRaw?:bigint;slippageBps:number;lock:TrancheChoice;tranche?:PublicKey;unlockTs?:bigint;maximumSolRaw:bigint;lookupTables?:PublicKey[];}
export async function prepareLiquidityLifecycle(deps:CompoundReadDeps & {executionEnabled:boolean},input:LifecycleInput){
 check(input.action!=='create','Use the initial pool creation flow');
 const s=await readLiquidityState(deps,input.reserve),now=deps.now??Date.now,expiresAtMs=now()+25000;
 check(s.registered,'Canonical liquidity pool is not available');
 const permissionless=input.action==='collect';check(permissionless||input.actor.equals(s.creator)||input.actor.equals(s.treasury),'Connect the creator or fixed treasury wallet');
 check(PublicKey.isOnCurve(input.actor.toBytes())&&(permissionless||PublicKey.isOnCurve(s.treasury.toBytes()))&&(['collect','unlock'].includes(input.action)||PublicKey.isOnCurve(s.creator.toBytes())),'Program treasuries require their own multisig execution adapter');
 check(!s.paused||['collect','unlock','withdraw'].includes(input.action),'Protocol is paused');
 const instructions:TransactionInstruction[]=[],watch:{address:PublicKey;minimum:bigint;program:PublicKey}[]=[],accounts={pool:s.pool,...s.registered!};
 const setup=(mint:PublicKey,program=TOKEN_PROGRAM_ID)=>instructions.push(createAssociatedTokenAccountIdempotentInstruction(input.action==='collect'?input.actor:s.treasury,s.ata(mint,program),s.treasury,mint,program));
 let review:Record<string,string>={},tranche:string|undefined;
 if(input.action==='add'){
  instructions.push(await buildAuthorizeLiquidityAddition(deps.program as any,{reserve:s.reserve,creator:s.creator,owner:s.treasury}));
  check((s.status&1)===0,'Pool additions are paused');
  const a=addAmounts(s,input.maximumUsdcRaw??0n,input.maximumReserveRaw??0n,input.slippageBps);
  check(s.usdcBalance>=input.maximumUsdcRaw!&&s.reserveBalance>=input.maximumReserveRaw!,'Treasury balance is below the selected spending caps');
  setup(s.lp);const usdc0=accounts.mint0.equals(LIQUIDITY_USDC);
  instructions.push(buildCpmmDeposit(accounts,s.treasury,a.lp,usdc0?input.maximumUsdcRaw!:input.maximumReserveRaw!,usdc0?input.maximumReserveRaw!:input.maximumUsdcRaw!));
  const locked=await appendTrancheLock(deps,s,instructions,a.lp,input.lock);tranche=locked?.tranche.toBase58();
  watch.push({address:s.ata(LIQUIDITY_USDC),minimum:s.usdcBalance-input.maximumUsdcRaw!,program:TOKEN_PROGRAM_ID},{address:s.ata(s.mint,TOKEN_2022_PROGRAM_ID),minimum:s.reserveBalance-input.maximumReserveRaw!,program:TOKEN_2022_PROGRAM_ID},{address:s.ata(s.lp),minimum:s.lpBalance+(locked?0n:a.lp),program:TOKEN_PROGRAM_ID});
  review={lpAddedRaw:a.lp.toString(),estimatedUsdcRaw:a.usdc.toString(),estimatedReserveRaw:a.reserve.toString(),maximumUsdcRaw:input.maximumUsdcRaw!.toString(),maximumReserveRaw:input.maximumReserveRaw!.toString(),lock:input.lock};
 }else if(input.action==='withdraw'){
  check((s.status&2)===0,'Pool withdrawals are paused');const lp=input.lpAmountRaw??0n;check(lp<=s.lpBalance,'Only unlocked treasury liquidity can be withdrawn');const a=withdrawAmounts(s,lp,input.slippageBps);
  setup(LIQUIDITY_USDC);setup(s.mint,TOKEN_2022_PROGRAM_ID);const usdc0=accounts.mint0.equals(LIQUIDITY_USDC);
  instructions.push(buildCpmmWithdraw(accounts,s.treasury,lp,usdc0?a.minimumUsdc:a.minimumReserve,usdc0?a.minimumReserve:a.minimumUsdc));
  watch.push({address:s.ata(LIQUIDITY_USDC),minimum:s.usdcBalance+a.minimumUsdc,program:TOKEN_PROGRAM_ID},{address:s.ata(s.mint,TOKEN_2022_PROGRAM_ID),minimum:s.reserveBalance+a.minimumReserve,program:TOKEN_2022_PROGRAM_ID});
  review={lpWithdrawnRaw:lp.toString(),minimumUsdcRaw:a.minimumUsdc.toString(),minimumReserveRaw:a.minimumReserve.toString()};
 }else if(input.action==='collect'){
  const c=await prepareRevenueCollect({connection:deps.connection,programId:deps.programId,reserve:s.reserve,reserveMint:s.mint,pool:s.pool,payer:input.actor,protocolConfig:s.protocolConfig,protocolTreasury:s.protocolTreasury,creatorTreasury:s.treasury,termsV2:!!s.terms});instructions.push(...c.instructions);review={grossNativeUsdcRaw:c.grossUsdcRaw.toString(),distributableUsdcRaw:c.netUsdcRaw.toString(),creatorTreasury:s.treasury.toBase58(),protocolTreasury:s.protocolTreasury.toBase58()};
 }else if(input.action==='lock'){
  const amount=input.lpAmountRaw??0n;check(amount>0n&&amount<=s.lpBalance&&input.lock!=='unlocked','Choose available LP tokens and a lock term');const locked=await appendTrancheLock(deps,s,instructions,amount,input.lock);tranche=locked!.tranche.toBase58();review={lpLockedRaw:amount.toString(),lock:input.lock};
 }else{
  check(input.tranche,'Choose a liquidity tranche');const info=await deps.connection.getAccountInfo(input.tranche!,'confirmed');check(info?.owner.equals(deps.programId),'Liquidity tranche unavailable');const t=deps.program.coder.accounts.decode('liquidityTranche',info!.data);
  check(new PublicKey(t.reserve).equals(s.reserve)&&new PublicKey(t.pool).equals(s.pool)&&new PublicKey(t.lpMint).equals(s.lp)&&(input.action==='unlock'||new PublicKey(t.creator).equals(s.creator))&&new PublicKey(t.beneficiary).equals(s.treasury)&&findLiquidityTranche(s.reserve,s.treasury,BigInt(t.nonce.toString()),deps.programId).equals(input.tranche!),'Liquidity tranche identity changed');
  check(!t.withdrawn&&!t.permanent,'This tranche is already released or permanently locked');tranche=input.tranche!.toBase58();
  if(input.action==='extend'){check(input.unlockTs!==undefined&&input.unlockTs>BigInt(t.unlockTs.toString())&&input.unlockTs>s.time,'New expiry must extend the existing lock');instructions.push(await buildExtendLiquidityTranche(deps.program as any,{tranche:input.tranche!,creator:s.creator,owner:s.treasury,unlockTs:input.unlockTs!}));review={unlockTs:input.unlockTs!.toString()};}
  else if(input.action==='unlock'){check(s.time>=BigInt(t.unlockTs.toString()),'Tranche has not expired');setup(s.lp);instructions.push(await buildWithdrawLiquidityTranche(deps.program as any,{tranche:input.tranche!,owner:s.treasury,lpMint:s.lp}));review={destination:s.treasury.toBase58()};}
  else instructions.push(await buildMakeLiquidityTranchePermanent(deps.program as any,{tranche:input.tranche!,creator:s.creator,owner:s.treasury,pool:s.pool,lpMint:s.lp,vault0:accounts.vault0,vault1:accounts.vault1}));
 }
 const prepared=await simulateLiquidityTransaction({connection:deps.connection,instructions,lookupTables:await loadLiquidityTables(deps.connection,s.reserve,input.lookupTables),treasury:s.treasury,creator:s.creator,feePayer:permissionless?input.actor:s.treasury,action:input.action,reserve:s.reserve,pool:s.pool,expiresAtMs,executionEnabled:deps.executionEnabled,maximumSol:input.maximumSolRaw,watch,now});
 return {...prepared,review,tranche,stateFingerprint:s.fingerprint};
}
