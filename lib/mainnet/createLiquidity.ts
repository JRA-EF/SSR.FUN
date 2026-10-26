import {PublicKey,TransactionInstruction,type AddressLookupTableAccount,type Connection} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {compileV0} from './buildCommon';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount,unpackMint} from '@solana/spl-token';
import {findReserveAsset,findReserveVault,findVaultAuthority} from '@ssr/sdk';
import {LIQUIDITY_USDC,SSR_POOL_PAYER,RAYDIUM_CPMM,MIN_TRADE_TAX_BPS} from '../../src/merge/lib/liquidity/raydiumCpmm';
import {type CompoundReadDeps,transferGross} from './compoundQuotes';
import {readLiquidityState,type LiquidityState} from './liquidityLifecycle';
import {prepareAtomicRevenuePool,integerSqrt} from './atomicPool';
import {simulateLiquidityTransaction} from './prepareCompound';
import {loadLiquidityTables} from './liquidityLookup';
import {appendTrancheLock,type TrancheChoice} from './liquidityTranches';
import {poolPayerRefund,POOL_PAYER_REFUND_MARGIN_LAMPORTS} from './poolPayer';
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
interface Price{usdPrice?:number|null;decimals?:number|null;blockId?:number|null;}
/** Jupiter re-stamps a price only when the asset trades, so a thinly traded asset's latest price is often minutes old.
 * The launch price only seeds the creator's own pool, so ~10 minutes of age is accepted (Compound keeps its 150-slot rule). */
export const LAUNCH_PRICE_MAX_AGE_SLOTS=1500;
/** USDC numeraire; external prices are used only for non-USDC backing. */
export async function initialReserveAtNav(deps:CompoundReadDeps,s:LiquidityState,usdcRaw:bigint,prices:(mints:string[])=>Promise<Map<string,Price>>){
 const rows=await deps.connection.getProgramAccounts(deps.programId,{commitment:'confirmed',filters:[{dataSize:111},{memcmp:{offset:8,bytes:s.reserve.toBase58()}}]});
 check(rows.length>0&&rows.length<=12,'Reserve basket unavailable');
 const registrations=rows.map(row=>({key:row.pubkey,row:deps.program.coder.accounts.decode('reserveAsset',row.account.data)})).sort((a,b)=>a.row.orderIndex-b.row.orderIndex);
 const mints=registrations.map(r=>new PublicKey(r.row.assetMint));check(new Set(mints.map(m=>m.toBase58())).size===mints.length,'Duplicate Reserve assets');
 const vaults=mints.map(m=>findReserveVault(s.reserve,m,deps.programId)[0]);
 const batch=await deps.connection.getMultipleAccountsInfoAndContext([s.reserve,s.mint,...registrations.map(r=>r.key),...mints,...vaults],{commitment:'confirmed'}),a=batch.value,n=mints.length;
 check(a[0]?.owner.equals(deps.programId)&&a[1]?.owner.equals(TOKEN_2022_PROGRAM_ID),'Reserve changed');
 const reserve=deps.program.coder.accounts.decode('reserve',a[0]!.data),rt=unpackMint(s.mint,a[1]!,TOKEN_2022_PROGRAM_ID);
 check(reserve.assetCount===n&&new PublicKey(reserve.reserveTokenMint).equals(s.mint)&&rt.supply>0n,'Reserve backing or supply changed');
 const nonUsdc=mints.filter(m=>!m.equals(LIQUIDITY_USDC));const values=nonUsdc.length?await prices([...nonUsdc.map(m=>m.toBase58()),LIQUIDITY_USDC.toBase58()]):new Map<string,Price>();
 const scaled=(mint:PublicKey,decimals:number)=>{if(!nonUsdc.length)return 1000000000000n;const p=values.get(mint.toBase58());check(p&&p.decimals===decimals&&typeof p.usdPrice==='number'&&Number.isFinite(p.usdPrice)&&p.usdPrice>0&&p.usdPrice<1e12&&Number.isSafeInteger(p.blockId)&&p.blockId!>=batch.context.slot-LAUNCH_PRICE_MAX_AGE_SLOTS&&p.blockId!<=batch.context.slot+150,`No recent market price is available for the reserve asset ${mint.toBase58().slice(0,4)}…${mint.toBase58().slice(-4)} (no trade or quote in the last 24 hours), so the launch price cannot be set at NAV.`);const raw=BigInt(p!.usdPrice!.toFixed(12).replace('.',''));check(raw>0n,'Backing asset price is below supported precision');return raw;};
 const usdcPrice=scaled(LIQUIDITY_USDC,6);
 let totalUsd=0n;
 registrations.forEach((r,i)=>{const registration=a[2+i];check(registration?.owner.equals(deps.programId),'Backing registration unavailable');const row=deps.program.coder.accounts.decode('reserveAsset',registration!.data),mintInfo=a[2+n+i],vaultInfo=a[2+2*n+i];
  check(new PublicKey(row.reserve).equals(s.reserve)&&new PublicKey(row.assetMint).equals(mints[i])&&findReserveAsset(s.reserve,mints[i],deps.programId)[0].equals(r.key)&&new PublicKey(row.vault).equals(vaults[i])&&row.orderIndex===i&&row.enabled,'Backing registration changed');
  check(mintInfo&&(mintInfo.owner.equals(TOKEN_PROGRAM_ID)||mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))&&vaultInfo?.owner.equals(mintInfo.owner),'Unsupported backing accounts');
  const mint=unpackMint(mints[i],mintInfo!,mintInfo!.owner),vault=unpackAccount(vaults[i],vaultInfo!,mintInfo!.owner);
  check(mint.decimals===row.decimals&&vault.mint.equals(mints[i])&&vault.owner.equals(findVaultAuthority(s.reserve,deps.programId)[0])&&vault.isInitialized&&!vault.isFrozen&&vault.amount>0n,'Invalid Reserve backing vault');
  totalUsd+=vault.amount*scaled(mints[i],mint.decimals)/10n**BigInt(mint.decimals);
 });
 check(totalUsd>0n,'Reserve NAV is unavailable');
 const numerator=usdcRaw*rt.supply*usdcPrice,denominator=1000000n*totalUsd,netReserve=(numerator+denominator-1n)/denominator;
 check(netReserve>0n&&netReserve<=0xffffffffffffffffn,'Initial Reserve amount exceeds supported limits');
 return {netReserve,navUsdc:Number(totalUsd)/Number(usdcPrice)/(Number(rt.supply)/10**rt.decimals),slot:batch.context.slot};
}
/**
 * DEC-0251: does the DEPLOYED program have liquidity terms v2 yet? Same probe as
 * DEC-0250's isRebalanceSwapLive: Anchor answers an unknown instruction with
 * InstructionFallbackNotFound (custom 101) before reading accounts. Pool creation
 * uses v1 until the upgrade executes and v2 from then on, so the frontend can ship
 * before the upgrade without breaking the live flow.
 */
export async function isLiquidityTermsV2Live(connection:Pick<Connection,'simulateTransaction'>,payer:PublicKey,programId:PublicKey):Promise<boolean>{
 const data=createHash('sha256').update('global:configure_liquidity_revenue_v2').digest().subarray(0,8);
 const tx=compileV0(payer,'11111111111111111111111111111111',[new TransactionInstruction({programId,keys:[],data:Buffer.from(data)})],[]);
 const {value}=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});
 return !/"Custom":101\b/.test(JSON.stringify(value.err??null));
}
/** DEC-0255: does the DEPLOYED program have the backing/pool split yet? Same probe as above. */
export async function isLiquiditySplitLive(connection:Pick<Connection,'simulateTransaction'>,payer:PublicKey,programId:PublicKey):Promise<boolean>{
 const data=createHash('sha256').update('global:configure_liquidity_split').digest().subarray(0,8);
 const tx=compileV0(payer,'11111111111111111111111111111111',[new TransactionInstruction({programId,keys:[],data:Buffer.from(data)})],[]);
 const {value}=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});
 return !/"Custom":101\b/.test(JSON.stringify(value.err??null));
}
/** DEC-0257: does the DEPLOYED program carry the trade tax in the transfer fee yet? Same probe as above. */
export async function isTradeTaxLive(connection:Pick<Connection,'simulateTransaction'>,payer:PublicKey,programId:PublicKey):Promise<boolean>{
 const data=createHash('sha256').update('global:enable_trade_tax').digest().subarray(0,8);
 const tx=compileV0(payer,'11111111111111111111111111111111',[new TransactionInstruction({programId,keys:[],data:Buffer.from(data)})],[]);
 const {value}=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});
 return !/"Custom":101\b/.test(JSON.stringify(value.err??null));
}
export async function prepareCreateLiquidity(deps:CompoundReadDeps & {executionEnabled:boolean;prices:(mints:string[])=>Promise<Map<string,Price>>},p:{reserve:PublicKey;actor:PublicKey;usdcRaw:bigint;maximumSolRaw:bigint;buyTaxBps:number;sellTaxBps:number;holderShareBps:number;poolShareBps?:number;lock:TrancheChoice;lookupTables?:PublicKey[]}){
 // Preparation (reads, pricing, two simulations) gets its own deadline; the 45 s signing window starts when it ends.
 const now=deps.now??Date.now,expiresAtMs=now()+30000,s=await readLiquidityState(deps,p.reserve);
 check(!s.registered&&!s.paused,'Pool already exists or the protocol is paused');check(p.actor.equals(s.creator),'Connect the creator wallet to prepare pool creation');
 check(PublicKey.isOnCurve(s.treasury.toBytes())&&PublicKey.isOnCurve(s.creator.toBytes()),'Program treasuries require their own multisig execution adapter');
 check(p.usdcRaw>0n&&p.usdcRaw<=s.usdcBalance,'Creator treasury has insufficient USDC');
 const nav=await initialReserveAtNav(deps,s,p.usdcRaw,deps.prices),reserveAmountRaw=transferGross(nav.netReserve,s.fee),maximumReserveDebitRaw=s.treasury.equals(SSR_POOL_PAYER)?reserveAmountRaw:transferGross(reserveAmountRaw,s.fee);
 check(maximumReserveDebitRaw<=s.reserveBalance,'Creator treasury has insufficient Reserve Tokens to initialize at NAV');
 const minimumLpRaw=integerSqrt(nav.netReserve*p.usdcRaw)-100n;
 const termsV2=await isLiquidityTermsV2Live(deps.connection as any,SSR_POOL_PAYER,deps.programId);
 check(termsV2||p.holderShareBps===0,'Sharing pool earnings with holders becomes available after the next protocol upgrade');
 const poolShareBps=p.poolShareBps??0;
 check(poolShareBps===0||p.holderShareBps>0,'Adding holder earnings to the pool needs a holder share');
 check(poolShareBps===0||await isLiquiditySplitLive(deps.connection as any,SSR_POOL_PAYER,deps.programId),'Adding holder earnings to the pool becomes available after the next protocol upgrade');
 // DEC-0257: once live, the tax is charged by the Reserve Token on every route (one rate: the larger side).
 const tradeTax=termsV2&&Math.max(p.buyTaxBps,p.sellTaxBps)>0&&await isTradeTaxLive(deps.connection as any,SSR_POOL_PAYER,deps.programId);
 // DEC-0263: the program counts the tax as active only while the token's rate (protocol fee + tax) is above 25 bps;
 // at or below it the tax could be swept to SSR or overwritten. Refuse such a small tax until the program keys on the TradeTax account.
 if(tradeTax){const tax=Math.max(p.buyTaxBps,p.sellTaxBps);check(tax>=MIN_TRADE_TAX_BPS&&(s.fee?.transferFeeBasisPoints??0)+tax>25,`Trade tax must be 0 or at least ${MIN_TRADE_TAX_BPS/100}%`);}
 const built=await prepareAtomicRevenuePool({connection:deps.connection,program:deps.program,programId:deps.programId,reserve:s.reserve,reserveMint:s.mint,manager:s.creator,treasury:s.treasury,protocolConfig:s.protocolConfig,reserveAmountRaw,usdcAmountRaw:p.usdcRaw,maximumReserveDebitRaw,minimumLpRaw,openTime:0n,buyTaxBps:p.buyTaxBps,sellTaxBps:p.sellTaxBps,holderShareBps:p.holderShareBps,termsV2,poolShareBps,tradeTax});
 const [m0,m1]=[s.mint,LIQUIDITY_USDC].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));const vault=(mint:PublicKey)=>PublicKey.findProgramAddressSync([Buffer.from('pool_vault'),s.pool.toBuffer(),mint.toBuffer()],RAYDIUM_CPMM)[0];
 const locked=await appendTrancheLock(deps,{...s,registered:{vault0:vault(m0),vault1:vault(m1)}},built.instructions,built.expectedLpRaw,p.lock);
 const tables:AddressLookupTableAccount[]=await loadLiquidityTables(deps.connection,s.reserve,p.lookupTables);
 // DEC-0240: the creator refunds SSR's pool payer inside this transaction. Pass 1 refunds the creator's SOL cap to
 // measure the payer's real cost (the payer holds only a small float); pass 2 refunds exactly that cost plus a margin.
 const simulate=(refundLamports:bigint)=>simulateLiquidityTransaction({connection:deps.connection,instructions:[poolPayerRefund(s.creator,refundLamports),...built.instructions],treasury:s.treasury,creator:s.creator,feePayer:SSR_POOL_PAYER,solPayers:[s.creator,s.treasury],lookupTables:tables,action:'create',reserve:s.reserve,pool:s.pool,expiresAtMs,reviewWindowMs:45000,executionEnabled:deps.executionEnabled,maximumSol:p.maximumSolRaw,now,
  watch:[{address:s.ata(LIQUIDITY_USDC),program:TOKEN_PROGRAM_ID,minimum:s.usdcBalance-p.usdcRaw},{address:s.ata(s.mint,TOKEN_2022_PROGRAM_ID),program:TOKEN_2022_PROGRAM_ID,minimum:s.reserveBalance-maximumReserveDebitRaw},{address:s.ata(s.lp),program:TOKEN_PROGRAM_ID,minimum:locked?0n:minimumLpRaw}]});
 const payerCost=(r:Awaited<ReturnType<typeof simulate>>)=>BigInt(r.solCostsByWallet?.find(c=>c.wallet===SSR_POOL_PAYER.toBase58())?.lamports??'0');
 check(p.maximumSolRaw>POOL_PAYER_REFUND_MARGIN_LAMPORTS,'Choose a higher SOL cost cap');
 const capSol=(Number(p.maximumSolRaw)/1e9).toFixed(2);
 const first=await simulate(p.maximumSolRaw-POOL_PAYER_REFUND_MARGIN_LAMPORTS).catch((e:unknown)=>{
  // The refund is capped by the creator's SOL limit, so a low cap starves Raydium's 0.15 SOL creation fee.
  if(e instanceof Error&&/not have enough SOL/.test(e.message))throw new Error(`Launching this pool needs more SOL than your ${capSol} SOL cost limit allows: Raydium charges 0.15 SOL to create a pool, plus about 0.04 SOL of account rent. Raise the maximum network and setup cost to 0.25 SOL or more (or add SOL to your wallet). Nothing was submitted.`);
  throw e;});
 const measured=payerCost(first)+p.maximumSolRaw;
 check(measured>0n&&measured<=p.maximumSolRaw,'Pool launch SOL cost exceeds your cap');
 const prepared=await simulate(measured);
 const payerNetCostLamports=payerCost(prepared);
 check(payerNetCostLamports<=0n,'Pool launch refund does not cover the pool payer; nothing was submitted');
 return {...prepared,payerNetCostLamports:payerNetCostLamports.toString(),review:{navUsdc:nav.navUsdc.toString(),usdcDebitRaw:p.usdcRaw.toString(),reserveDebitRaw:maximumReserveDebitRaw.toString(),lpAddedRaw:built.expectedLpRaw.toString(),lock:p.lock,buyTaxBps:String(p.buyTaxBps),sellTaxBps:String(p.sellTaxBps),holderShareBps:String(p.holderShareBps),poolShareBps:String(poolShareBps),tradeTaxBps:String(tradeTax?Math.max(p.buyTaxBps,p.sellTaxBps):0),termsVersion:termsV2?'2':'1',initialLpOwner:s.treasury.toBase58()},tranche:locked?.tranche.toBase58()};
}
