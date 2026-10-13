/** Read-only Compound quotes. No keys, signatures, custody or submissions.
 * Raydium integer math mirrors cp-swap b3187ae. SOL amounts are explicit
 * planning caps, not simulated transaction fees; the executor must replace
 * these with exact costs and obtain fresh approval before spending. */
import { createHash } from 'node:crypto';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  unpackMint, unpackAccount, getTransferFeeConfig, getEpochFee, calculateFee, getAccountLenForMint, getTransferHook,
  type TransferFee } from '@solana/spl-token';
import { compareCompoundRoutes, validateCompoundContext, computeEffectiveFeeSplit, PROTOCOL_MIN_MINT_FEE_BPS,
  findLiquidityRevenue, findReserve, findReserveAsset, findReserveVault, findVaultAuthority, findProtocolConfig,
  type CompoundContext, type CompoundQuote, type CompoundRoute, type CompoundCost } from '@ssr/sdk';
import { decodePool, decodeConfig, effectiveCreatorShare, creatorShareAddress,
  RAYDIUM_CPMM, SSR_CPMM_CONFIG, LIQUIDITY_USDC } from '../../src/merge/lib/liquidity/raydiumCpmm';
import { fetchJupiterQuoteWithRetry } from './jupiter';

const U64 = 0xffffffffffffffffn, D = 1_000_000n;
const ceil = (a: bigint, b: bigint) => (a+b-1n)/b;
const min = (a: bigint,b: bigint) => a<b?a:b;
function check(ok: unknown, message: string): asserts ok { if(!ok) throw new Error(message); }
function raw(value: unknown): bigint {
  check(typeof value === 'string' && /^\d+$/.test(value), 'Malformed live quote amount');
  const n=BigInt(value); check(n<=U64,'Live quote amount exceeds token limits'); return n;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v)).digest('hex');
}
export function transferNet(gross: bigint, fee: TransferFee | null): bigint {
  return gross-(fee?calculateFee(fee,gross):0n);
}
export function transferGross(net: bigint, fee: TransferFee | null): bigint {
  if(!fee||!fee.transferFeeBasisPoints) return net;
  const bps=BigInt(fee.transferFeeBasisPoints);
  const extra=bps===10_000n?fee.maximumFee:min(ceil(net*bps,10_000n-bps),fee.maximumFee);
  check(net+extra<=U64,'Transfer amount exceeds token limits');
  return net+extra;
}
export interface CompoundAsset {
  mint: string; decimals: number; balance: bigint; transferFee: TransferFee|null;
  tokenProgram?: string; reserveAsset?:string; vault?:string;
}
export interface CompoundSnapshot {
  context: CompoundContext;
  readAtMs: number;
  epoch: bigint;
  chainTime?:bigint;
  usdc: bigint; tokens: bigint; lpSupply: bigint; reserveSupply: bigint;
  mintFeeBps: bigint; buyTaxBps: number; protocolRate: bigint; fundRate: bigint;
  reserveTransferFee: TransferFee|null;
  assets: CompoundAsset[];
  mintAllowed: boolean;
  /** Explicit pre-execution allowances, not claimed actual costs. */
  accountRentRaw: bigint;
  treasury?:string; protocolTreasury?:string; reserveDecimals?:number; lpDecimals?:number;
  treasuryUsdcRaw?:bigint; treasuryReserveRaw?:bigint; treasuryLpRaw?:bigint;
  poolAccounts?: {pool:PublicKey;mint0:PublicKey;mint1:PublicKey;vault0:PublicKey;vault1:PublicKey;program0:PublicKey;program1:PublicKey};
}
export interface CompoundQuoteInput {
  reserve: PublicKey; pool: PublicKey; creator: PublicKey;
  budgetUsdcRaw: bigint; slippageBps: number;
  lpDestination: PublicKey; lockPolicyId: string;
}
export interface CompoundReadDeps {
  connection: Connection;
  program: { coder: { accounts: { decode(name: string,data: Buffer): any } } };
  programId: PublicKey;
  now?: () => number;
}
/** Discover only; all financial state is subsequently re-read in ONE contextual
 * RPC batch (including Clock/epoch), then identities and registrations checked. */
export async function readCompoundSnapshot(deps: CompoundReadDeps, input: CompoundQuoteInput): Promise<CompoundSnapshot> {
  const now=deps.now??Date.now, readAtMs=now();
  const {connection,program,programId}=deps;
  const first=await connection.getAccountInfo(input.reserve,'confirmed');
  check(first && first.owner.equals(programId),'Reserve not found');
  const hint=program.coder.accounts.decode('reserve',first.data);
  const mint=new PublicKey(hint.reserveTokenMint);
  const rows=await connection.getProgramAccounts(programId,{commitment:'confirmed',filters:[
    {dataSize:111},{memcmp:{offset:8,bytes:input.reserve.toBase58()}}]});
  check(rows.length>0&&rows.length<=12,'Reserve basket registrations unavailable');
  const registrations=rows.map(row=>({key:row.pubkey,data:program.coder.accounts.decode('reserveAsset',row.account.data)})).sort((a,b)=>a.data.orderIndex-b.data.orderIndex);
  const revenue=findLiquidityRevenue(input.reserve,programId);
  const initialPool=decodePool(await connection.getAccountInfo(input.pool,'confirmed'),mint,revenue);
  const canonical=PublicKey.findProgramAddressSync([Buffer.from('pool'),SSR_CPMM_CONFIG.toBuffer(),initialPool.mint0.toBuffer(),initialPool.mint1.toBuffer()],RAYDIUM_CPMM)[0];
  check(canonical.equals(input.pool),'Compound requires the canonical pool');
  const lp=PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'),input.pool.toBuffer()],RAYDIUM_CPMM)[0];
  const treasury=new PublicKey(hint.feeConfig.feeDestination);
  const treasuryUsdc=getAssociatedTokenAddressSync(LIQUIDITY_USDC,treasury,true);
  const treasuryRt=getAssociatedTokenAddressSync(mint,treasury,true,TOKEN_2022_PROGRAM_ID);
  const assets=registrations.map(r=>new PublicKey(r.data.assetMint));
  const keys=[input.reserve,input.pool,SSR_CPMM_CONFIG,revenue,creatorShareAddress(revenue),mint,lp,
    initialPool.vault0,initialPool.vault1,SYSVAR_CLOCK_PUBKEY,treasuryUsdc,treasuryRt,input.lpDestination,
    findProtocolConfig(programId)[0],...registrations.map(r=>r.key),...assets,
    ...assets.map(m=>findReserveVault(input.reserve,m,programId)[0])];
  const batch=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed'});
  const infos=batch.value;
  const own=(i:number,owner:PublicKey)=>{const a=infos[i];check(a && a.owner.equals(owner),'Compound snapshot owner mismatch');return a;};
  const reserve=program.coder.accounts.decode('reserve',own(0,programId).data);
  check(new PublicKey(reserve.reserveTokenMint).equals(mint)&&new PublicKey(reserve.manager).equals(input.creator)&&new PublicKey(reserve.feeConfig.feeDestination).equals(treasury),'Reserve creator or treasury changed');
  check(reserve.assetCount===assets.length&&findReserve(BigInt(reserve.reserveId.toString()),programId)[0].equals(input.reserve),'Reserve basket or identity changed; refresh quotes');
  check(new Set(assets.map(a=>a.toBase58())).size===assets.length,'Duplicate basket assets');
  const pool=decodePool(infos[1],mint,revenue), config=decodeConfig(infos[2]);
  check(pool.vault0.equals(initialPool.vault0)&&pool.vault1.equals(initialPool.vault1),'Pool vaults changed');
  check((pool.mint0.equals(mint)?pool.program0:pool.program1).equals(TOKEN_2022_PROGRAM_ID),'Reserve Token must use Token-2022');
  const router=program.coder.accounts.decode('liquidityRevenue',own(3,programId).data);
  check(new PublicKey(router.reserve).equals(input.reserve)&&new PublicKey(router.pool).equals(input.pool)&&new PublicKey(router.treasury).equals(treasury),'Creator revenue registration mismatch');
  const retention=effectiveCreatorShare(infos[4],revenue,config.creatorFeeShareRate);
  check(retention<=50_000n&&BigInt(router.retainedRate.toString())===retention,'Creator fee retention changed');
  const protocol=program.coder.accounts.decode('protocolConfig',own(13,programId).data);
  check(!protocol.paused,'Protocol is paused');
  const clock=infos[9];check(clock && clock.data.length===40,'Clock unavailable');
  const epoch=clock.data.readBigUInt64LE(16), time=clock.data.readBigInt64LE(32);
  const rt=unpackMint(mint,own(5,TOKEN_2022_PROGRAM_ID),TOKEN_2022_PROGRAM_ID);
  const hook=getTransferHook(rt);
  check(rt.isInitialized&&rt.supply>0n&&(!hook||hook.programId.equals(PublicKey.default)),'Reserve must be seeded and have no active transfer hook');
  const feeFor=(m:ReturnType<typeof unpackMint>)=>{const f=getTransferFeeConfig(m);return f?getEpochFee(f,epoch):null;};
  const poolData=infos[1]!.data, usdc0=pool.mint0.equals(LIQUIDITY_USDC);
  check((poolData[329]&5)===0&&time>=poolData.readBigUInt64LE(373),'Pool swaps or liquidity deposits unavailable');
  check(new PublicKey(poolData.subarray(136,168)).equals(lp),'Pool LP mint mismatch');
  const authority=PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')],RAYDIUM_CPMM)[0];
  const balances=[0,1].map(i=>{
    const a=unpackAccount(i?pool.vault1:pool.vault0,own(7+i,i?pool.program1:pool.program0),i?pool.program1:pool.program0);
    check(a.mint.equals(i?pool.mint1:pool.mint0)&&a.owner.equals(authority)&&!a.isFrozen,'Invalid pool vault');
    const fees=poolData.readBigUInt64LE(341+i*8)+poolData.readBigUInt64LE(357+i*8)+poolData.readBigUInt64LE(397+i*8);
    check(a.amount>fees,'Pool has no usable liquidity'); return a.amount-fees;
  });
  const lpMint=unpackMint(lp,own(6,TOKEN_PROGRAM_ID),TOKEN_PROGRAM_ID), lpSupply=poolData.readBigUInt64LE(333);
  check(lpSupply>0n&&lpMint.supply<=lpSupply,'Pool LP supply mismatch');
  const funds=unpackAccount(treasuryUsdc,own(10,TOKEN_PROGRAM_ID),TOKEN_PROGRAM_ID);
  check(funds.owner.equals(treasury)&&funds.mint.equals(LIQUIDITY_USDC)&&!funds.isFrozen&&funds.amount>=input.budgetUsdcRaw,'Creator treasury has insufficient settled earnings');
  check(input.lpDestination.equals(getAssociatedTokenAddressSync(lp,treasury,true)),'LP destination must be the fixed treasury associated account');
  if(infos[12]) { const dest=unpackAccount(input.lpDestination,own(12,TOKEN_PROGRAM_ID),TOKEN_PROGRAM_ID);check(dest.owner.equals(treasury)&&dest.mint.equals(lp)&&!dest.isFrozen,'LP destination must belong to the fixed creator treasury'); }
  else check(input.lpDestination.equals(getAssociatedTokenAddressSync(lp,treasury,true)),'Missing LP destination must be the creator treasury account');
  let rent=0n;
  if(!infos[11]) rent+=BigInt(await connection.getMinimumBalanceForRentExemption(getAccountLenForMint(rt)));
  else {const a=unpackAccount(treasuryRt,own(11,TOKEN_2022_PROGRAM_ID),TOKEN_2022_PROGRAM_ID);check(a.owner.equals(treasury)&&a.mint.equals(mint)&&!a.isFrozen,'Invalid creator Reserve Token account');}
  if(!infos[12]) rent+=BigInt(await connection.getMinimumBalanceForRentExemption(165));
  const n=assets.length;
  const basket=registrations.map((r,i)=>{
    const row=program.coder.accounts.decode('reserveAsset',own(14+i,programId).data);
    check(new PublicKey(row.reserve).equals(input.reserve)&&new PublicKey(row.assetMint).equals(assets[i])&&findReserveAsset(input.reserve,assets[i],programId)[0].equals(r.key),'Basket registration changed');
    const assetInfo=infos[14+n+i];check(assetInfo,'Basket mint unavailable');
    check(assetInfo.owner.equals(TOKEN_PROGRAM_ID)||assetInfo.owner.equals(TOKEN_2022_PROGRAM_ID),'Unsupported basket token program');
    check((assetInfo.owner.equals(TOKEN_PROGRAM_ID)&&!!row.tokenProgram.splToken)||(assetInfo.owner.equals(TOKEN_2022_PROGRAM_ID)&&!!row.tokenProgram.token2022),'Basket token program registration mismatch');
    const assetMint=unpackMint(assets[i],assetInfo,assetInfo.owner), fee=feeFor(assetMint);
    // Primary funding for fee-on-transfer backing needs separately verified
    // Jupiter output-transfer semantics. The pool route remains independent.
    const hook=getTransferHook(assetMint);
    check(!hook||hook.programId.equals(PublicKey.default),'Active basket transfer hooks are unsupported');
    const vault=findReserveVault(input.reserve,assets[i],programId)[0];
    check(new PublicKey(row.vault).equals(vault)&&row.enabled&&row.orderIndex===i&&row.decimals===assetMint.decimals,'Invalid basket registration');
    const account=unpackAccount(vault,own(14+2*n+i,assetInfo.owner),assetInfo.owner);
    check(account.mint.equals(assets[i])&&account.owner.equals(findVaultAuthority(input.reserve,programId)[0])&&account.isInitialized&&!account.isFrozen&&account.amount>0n,'Invalid basket balance');
    return {mint:assets[i].toBase58(),decimals:assetMint.decimals,balance:account.amount,transferFee:fee,tokenProgram:assetInfo.owner.toBase58(),reserveAsset:r.key.toBase58(),vault:vault.toBase58()};
  });
  check(new Set(registrations.map((_,i)=>program.coder.accounts.decode('reserveAsset',infos[14+i]!.data).orderIndex)).size===assets.length,'Duplicate basket order');
  check(infos[2]!.data.readBigUInt64LE(20)+infos[2]!.data.readBigUInt64LE(28)<=D,'Invalid pool fee split');
  const context:CompoundContext={creator:input.creator.toBase58(),reserve:input.reserve.toBase58(),pool:input.pool.toBase58(),reserveMint:mint.toBase58(),lpMint:lp.toBase58(),budgetUsdcRaw:input.budgetUsdcRaw,snapshotSlot:batch.context.slot,
    stateFingerprint:digest(keys.map((key,i)=>[key.toBase58(),infos[i]?.owner.toBase58()??null,i===9?epoch.toString():infos[i]?.data.toString('base64')??null])),slippageBps:input.slippageBps,lpDestination:input.lpDestination.toBase58(),lockPolicyId:input.lockPolicyId};
  validateCompoundContext(context);
  return {context,readAtMs,epoch,chainTime:time,usdc:balances[usdc0?0:1],tokens:balances[usdc0?1:0],lpSupply,reserveSupply:rt.supply,mintFeeBps:computeEffectiveFeeSplit(BigInt(reserve.feeConfig.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS).effectiveTotalBps,
    buyTaxBps:router.buyTaxBps,protocolRate:infos[2]!.data.readBigUInt64LE(20),fundRate:infos[2]!.data.readBigUInt64LE(28),reserveTransferFee:feeFor(rt),assets:basket,mintAllowed:!!reserve.status.active,accountRentRaw:rent,
    treasury:treasury.toBase58(),protocolTreasury:new PublicKey(protocol.defaultProtocolFeeDestination).toBase58(),reserveDecimals:rt.decimals,lpDecimals:lpMint.decimals,
    treasuryUsdcRaw:funds.amount,treasuryReserveRaw:infos[11]?unpackAccount(treasuryRt,infos[11],TOKEN_2022_PROGRAM_ID).amount:0n,
    treasuryLpRaw:infos[12]?unpackAccount(input.lpDestination,infos[12],TOKEN_PROGRAM_ID).amount:0n,poolAccounts:{pool:input.pool,...pool}};
}

/** Raydium uses a special ceiling: a sub-unit deposit rounds to ZERO and fails. */
function depositAmount(lp: bigint,balance: bigint,supply: bigint): bigint {
  return lp*balance/supply===0n?0n:ceil(lp*balance,supply);
}
export function poolAcquisition(s: CompoundSnapshot,grossUsdc: bigint) {
  const projectTax=ceil(grossUsdc*BigInt(s.buyTaxBps),10_000n), input=grossUsdc-projectTax;
  const totalFee=ceil(input*10_000n,D), creatorFee=totalFee*7500n/10_000n, tradeFee=totalFee-creatorFee;
  const protocolFee=tradeFee*s.protocolRate/D, fundFee=tradeFee*s.fundRate/D;
  const curveInput=input-totalFee;
  check(curveInput>0n,'Compound amount is too small for pool fees');
  const output=curveInput*s.tokens/(s.usdc+curveInput);
  const received=transferNet(output,s.reserveTransferFee);
  return {received,output,projectTax,tradeFee,creatorFee,
    // Trade fee retained by LPs belongs to the post-swap liquidity ratio.
    usdc:s.usdc+input-creatorFee-protocolFee-fundFee,tokens:s.tokens-output,
    impact:curveInput*s.tokens/s.usdc-output};
}
function allocation(s:CompoundSnapshot,availableTokens:bigint,availableUsdc:bigint,usdc=s.usdc,tokens=s.tokens) {
  const lp=min(transferNet(availableTokens,s.reserveTransferFee)*s.lpSupply/tokens,availableUsdc*s.lpSupply/usdc);
  const net=depositAmount(lp,tokens,s.lpSupply), dollars=depositAmount(lp,usdc,s.lpSupply);
  check(lp>0n&&net>0n&&dollars>0n,'Compound budget is too small for balanced liquidity');
  const gross=transferGross(net,s.reserveTransferFee);
  check(gross<=availableTokens&&dollars<=availableUsdc,'Liquidity allocation exceeds the available balances');
  return {lp,net,gross,dollars};
}
export interface CompoundProviderDeps {
  jupiterApiKey: string;
  quote?: typeof fetchJupiterQuoteWithRetry;
  now?: ()=>number;
  /** Server-trusted prices only, never caller-provided. Used to identify
   * the all-in execution premium, not to assume fixed basket swap costs. */
  prices: Map<string,{usdPrice:number|null|undefined;blockId?:number|null;decimals?:number|null}>;
  recordPlan?: (fingerprint:string,plan:unknown)=>void;
}
function usdValue(amount:bigint,decimals:number,price:number):bigint {
  check(Number.isFinite(price)&&price>0&&decimals>=0&&decimals<=18,'Live basket valuation unavailable');
  // Decimal conversion avoids floating-point token/USDC amounts.
  const [mantissa,exp='0']=price.toString().toLowerCase().split('e');
  const [whole,fraction='']=mantissa.split('.'), exponent=Number(exp)-fraction.length+6-decimals;
  const digits=BigInt(whole+fraction)*amount;
  return exponent>=0?digits*10n**BigInt(exponent):digits/10n**BigInt(-exponent);
}
export function compoundPlanFingerprint(context:CompoundContext,route:CompoundRoute,plan:unknown,network:bigint,rent:bigint):string {
  return digest([context,route,plan,network,rent]);
}
function finish(s:CompoundSnapshot,route:CompoundRoute,acquisition:bigint,acquired:bigint,a:ReturnType<typeof allocation>,costs:CompoundCost[],plan:unknown,now:()=>number,recordPlan?:CompoundProviderDeps['recordPlan']):CompoundQuote {
  check(now()-s.readAtMs<25_000,'Live snapshot expired; refresh both routes');
  // Bounded multi-step planning allowance. Exact fees/rent await construction
  // and simulation; these are never presented as already measured costs.
  const legs=route==='mint'?s.assets.filter(a=>a.mint!==LIQUIDITY_USDC.toBase58()).length:1;
  const network=BigInt(legs+2)*2_000_000n;
  const lockAllowance=s.context.lockPolicyId==='unlocked'?0n:s.context.lockPolicyId==='permanent'?30_000_000n:10_000_000n;
  const rent=s.accountRentRaw+BigInt(legs)*10_000_000n+lockAllowance;
  costs.push({kind:'networkFee',unit:'SOL',amountRaw:network},{kind:'accountRent',unit:'SOL',amountRaw:rent});
  const planFingerprint=compoundPlanFingerprint(s.context,route,plan,network,rent);
  recordPlan?.(planFingerprint,plan);
  return {id:planFingerprint,route,context:s.context,quotedAtMs:s.readAtMs,expiresAtMs:s.readAtMs+25_000,planFingerprint,
    acquisitionUsdcRaw:acquisition,depositUsdcRaw:a.dollars,leftoverUsdcRaw:s.context.budgetUsdcRaw-acquisition-a.dollars,
    acquiredReserveRaw:acquired,depositReserveGrossRaw:a.gross,depositReserveNetRaw:a.net,leftoverReserveRaw:acquired-a.gross,
    expectedLpRaw:a.lp,minimumLpRaw:a.lp*BigInt(10_000-s.context.slippageBps)/10_000n,maximumSolCostRaw:network+rent,costs};
}
export function createLiveCompoundProviders(s:CompoundSnapshot,deps:CompoundProviderDeps) {
  const now=deps.now??Date.now, quote=deps.quote??fetchJupiterQuoteWithRetry;
  const pool=async ():Promise<CompoundQuote>=>{
    check(s.buyTaxBps>=0&&s.buyTaxBps<=200,'Invalid project tax');
    // Find the crossover between token-limited and USDC-limited deposits.
    let lo=1n,hi=s.context.budgetUsdcRaw-1n;
    while(lo<hi) {
      const mid=(lo+hi)/2n;
      let q;try{q=poolAcquisition(s,mid);}catch{lo=mid+1n;continue;}
      const net=transferNet(q.received,s.reserveTransferFee);
      if(net*q.usdc<(s.context.budgetUsdcRaw-mid)*q.tokens)lo=mid+1n;else hi=mid;
    }
    const candidates=[lo,lo>1n?lo-1n:lo].flatMap(amount=>{
      try {const q=poolAcquisition(s,amount),a=allocation(s,q.received,s.context.budgetUsdcRaw-amount,q.usdc,q.tokens);return [{amount,q,a}];}
      catch {return [];}
    }).sort((a,b)=>a.a.lp===b.a.lp?0:a.a.lp>b.a.lp?-1:1);
    check(candidates.length,'No balanced pool route fits the earnings budget');
    const {amount,q,a}=candidates[0];
    return finish(s,'pool',amount,q.received,a,[
      {kind:'poolTradeFee',unit:'USDC',amountRaw:q.tradeFee+q.creatorFee},
      {kind:'projectTax',unit:'USDC',amountRaw:q.projectTax},
      {kind:'transferFee',unit:'ReserveToken',amountRaw:q.output-q.received+a.gross-a.net},
      {kind:'priceImpact',unit:'ReserveToken',amountRaw:q.impact}],{amount,...q,deposit:a},now,deps.recordPlan);
  };
  const mint=async ():Promise<CompoundQuote>=>{
    check(s.mintAllowed,'Primary mint is unavailable for this Reserve');
    check(s.assets.every(a=>!a.transferFee||a.transferFee.transferFeeBasisPoints===0),'Fee-on-transfer reserve assets are unsupported for primary mint');
    check(s.mintFeeBps<10_000n,'Mint fee consumes the output');
    check(s.assets.every(a=>a.mint===LIQUIDITY_USDC.toBase58()||((deps.prices.get(a.mint)?.blockId??-1)>=s.context.snapshotSlot-150&&deps.prices.get(a.mint)?.decimals===a.decimals)),'Basket valuation is stale or has different decimals');
    const prices=s.assets.map(a=>a.mint===LIQUIDITY_USDC.toBase58()?1:deps.prices.get(a.mint)?.usdPrice);
    check(prices.every(p=>typeof p==='number'&&Number.isFinite(p)&&p>0),'Live basket valuation unavailable');
    let lower=0n,upper=s.context.budgetUsdcRaw*s.lpSupply/s.usdc;
    let best: {gross:bigint;fee:bigint;received:bigint;spend:bigint;expectedSpend:bigint;fair:bigint;quotes:unknown[];a:ReturnType<typeof allocation>}|null=null;
    // At most eight proportional basket batches; every batch quotes assets in
    // parallel. ExactOut unsupported/rate-limited routes fail honestly.
    for(let iteration=0;iteration<8&&upper>lower;iteration++) {
      check(now()-s.readAtMs<20_000,'Basket quoting timed out; refresh both routes');
      const target=(lower+upper+1n)/2n;
      const netDeposit=depositAmount(target,s.tokens,s.lpSupply);
      check(netDeposit>0n,'Compound budget is too small');
      const requiredTokens=transferGross(netDeposit,s.reserveTransferFee);
      const gross=ceil(requiredTokens*10_000n,10_000n-s.mintFeeBps);
      const fee=ceil(gross*s.mintFeeBps,10_000n);
      const received=gross-fee;
      const legs=await Promise.all(s.assets.map(async (asset,i)=>{
        const required=ceil(gross*asset.balance,s.reserveSupply);
        if(asset.mint===LIQUIDITY_USDC.toBase58())return {max:required,expected:required,fair:required,wire:null};
        const result=await quote({inputMint:LIQUIDITY_USDC.toBase58(),outputMint:asset.mint,amount:required,swapMode:'ExactOut',slippageBps:s.context.slippageBps,maxAccounts:64,apiKey:deps.jupiterApiKey});
        check(result.kind==='ok',result.kind==='specific-error'?result.message:'Jupiter basket quote temporarily unavailable');
        const q=result.value;
        check(q.inputMint===LIQUIDITY_USDC.toBase58()&&q.outputMint===asset.mint&&q.swapMode==='ExactOut'&&q.slippageBps===s.context.slippageBps&&raw(q.outAmount)===required,'Jupiter returned a different basket route');
        check(typeof q.contextSlot==='number'&&q.contextSlot>=s.context.snapshotSlot-150,'Jupiter quote is stale');
        const expected=raw(q.inAmount),maximum=raw(q.otherAmountThreshold);
        check(expected>0n&&maximum>=ceil(expected*BigInt(10_000+s.context.slippageBps),10_000n)&&maximum<=ceil(expected*BigInt(10_000+s.context.slippageBps),10_000n)+1n,'Invalid Jupiter input cap');
        const impact=Number(q.priceImpactPct);check(Number.isFinite(impact)&&Math.abs(impact)<=0.15,'Basket price impact is too high or unavailable');
        check(Array.isArray(q.routePlan)&&q.routePlan.length>0,'Jupiter execution plan unavailable');
        check(q.routePlan.every((hop:any)=>hop?.swapInfo?.ammKey!==s.context.pool),'Basket acquisition must not change the canonical pool');
        return {max:maximum,expected,fair:usdValue(required,asset.decimals,prices[i] as number),wire:q};
      }));
      const spend=legs.reduce((n,l)=>n+l.max,0n),expectedSpend=legs.reduce((n,l)=>n+l.expected,0n),fair=legs.reduce((n,l)=>n+l.fair,0n);
      const dollars=depositAmount(target,s.usdc,s.lpSupply);
      if(spend+dollars<=s.context.budgetUsdcRaw) {
        const a=allocation(s,received,s.context.budgetUsdcRaw-spend);
        best={gross,fee,received,spend,expectedSpend,fair,quotes:legs.map(l=>l.wire),a};lower=target;
      } else upper=target-1n;
    }
    check(best,'No balanced primary-mint route fits the earnings budget');
    const b=best;
    return finish(s,'mint',b.spend,b.received,b.a,[
      {kind:'mintFee',unit:'ReserveToken',amountRaw:b.fee},
      {kind:'basketExecution',unit:'USDC',amountRaw:b.spend-b.expectedSpend},
      {kind:'priceImpact',unit:'USDC',amountRaw:b.expectedSpend>b.fair?b.expectedSpend-b.fair:0n},
      {kind:'transferFee',unit:'ReserveToken',amountRaw:b.a.gross-b.a.net}],b,now,deps.recordPlan);
  };
  return {mint,pool};
}
export async function compareLiveCompound(s:CompoundSnapshot,deps:CompoundProviderDeps) {
  return compareCompoundRoutes(s.context,createLiveCompoundProviders(s,deps),deps.now??Date.now);
}
