import {PublicKey,type AddressLookupTableAccount} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount,unpackMint} from '@solana/spl-token';
import {findReserveAsset,findReserveVault,findVaultAuthority} from '@ssr/sdk';
import {LIQUIDITY_USDC,SSR_POOL_PAYER,RAYDIUM_CPMM} from '../../src/merge/lib/liquidity/raydiumCpmm';
import {type CompoundReadDeps,transferGross} from './compoundQuotes';
import {readLiquidityState,type LiquidityState} from './liquidityLifecycle';
import {prepareAtomicRevenuePool,integerSqrt} from './atomicPool';
import {simulateLiquidityTransaction} from './prepareCompound';
import {loadLiquidityTables} from './liquidityLookup';
import {appendTrancheLock,type TrancheChoice} from './liquidityTranches';
import {poolPayerRefund,POOL_PAYER_REFUND_MARGIN_LAMPORTS} from './poolPayer';
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
interface Price{usdPrice?:number|null;decimals?:number|null;blockId?:number|null;}
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
 const scaled=(mint:PublicKey,decimals:number)=>{if(!nonUsdc.length)return 1000000000000n;const p=values.get(mint.toBase58());check(p&&p.decimals===decimals&&typeof p.usdPrice==='number'&&Number.isFinite(p.usdPrice)&&p.usdPrice>0&&p.usdPrice<1e12&&Number.isSafeInteger(p.blockId)&&p.blockId!>=batch.context.slot-150&&p.blockId!<=batch.context.slot+150,'A fresh price is required for every backing asset');const raw=BigInt(p!.usdPrice!.toFixed(12).replace('.',''));check(raw>0n,'Backing asset price is below supported precision');return raw;};
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
export async function prepareCreateLiquidity(deps:CompoundReadDeps & {executionEnabled:boolean;prices:(mints:string[])=>Promise<Map<string,Price>>},p:{reserve:PublicKey;actor:PublicKey;usdcRaw:bigint;maximumSolRaw:bigint;buyTaxBps:number;sellTaxBps:number;holderShareBps:number;lock:TrancheChoice;lookupTables?:PublicKey[]}){
 const now=deps.now??Date.now,expiresAtMs=now()+25000,s=await readLiquidityState(deps,p.reserve);
 check(!s.registered&&!s.paused,'Pool already exists or the protocol is paused');check(p.actor.equals(s.creator),'Connect the creator wallet to prepare pool creation');
 check(PublicKey.isOnCurve(s.treasury.toBytes())&&PublicKey.isOnCurve(s.creator.toBytes()),'Program treasuries require their own multisig execution adapter');
 check(p.usdcRaw>0n&&p.usdcRaw<=s.usdcBalance,'Creator treasury has insufficient USDC');
 const nav=await initialReserveAtNav(deps,s,p.usdcRaw,deps.prices),reserveAmountRaw=transferGross(nav.netReserve,s.fee),maximumReserveDebitRaw=s.treasury.equals(SSR_POOL_PAYER)?reserveAmountRaw:transferGross(reserveAmountRaw,s.fee);
 check(maximumReserveDebitRaw<=s.reserveBalance,'Creator treasury has insufficient Reserve Tokens to initialize at NAV');
 const minimumLpRaw=integerSqrt(nav.netReserve*p.usdcRaw)-100n;
 const built=await prepareAtomicRevenuePool({connection:deps.connection,program:deps.program,programId:deps.programId,reserve:s.reserve,reserveMint:s.mint,manager:s.creator,treasury:s.treasury,protocolConfig:s.protocolConfig,reserveAmountRaw,usdcAmountRaw:p.usdcRaw,maximumReserveDebitRaw,minimumLpRaw,openTime:0n,buyTaxBps:p.buyTaxBps,sellTaxBps:p.sellTaxBps,holderShareBps:p.holderShareBps});
 const [m0,m1]=[s.mint,LIQUIDITY_USDC].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));const vault=(mint:PublicKey)=>PublicKey.findProgramAddressSync([Buffer.from('pool_vault'),s.pool.toBuffer(),mint.toBuffer()],RAYDIUM_CPMM)[0];
 const locked=await appendTrancheLock(deps,{...s,registered:{vault0:vault(m0),vault1:vault(m1)}},built.instructions,built.expectedLpRaw,p.lock);
 const tables:AddressLookupTableAccount[]=await loadLiquidityTables(deps.connection,s.reserve,p.lookupTables);
 // DEC-0240: the creator refunds SSR's pool payer inside this transaction. Pass 1 refunds the creator's SOL cap to
 // measure the payer's real cost (the payer holds only a small float); pass 2 refunds exactly that cost plus a margin.
 const simulate=(refundLamports:bigint)=>simulateLiquidityTransaction({connection:deps.connection,instructions:[poolPayerRefund(s.creator,refundLamports),...built.instructions],treasury:s.treasury,creator:s.creator,feePayer:SSR_POOL_PAYER,solPayers:[s.creator,s.treasury],lookupTables:tables,action:'create',reserve:s.reserve,pool:s.pool,expiresAtMs,executionEnabled:deps.executionEnabled,maximumSol:p.maximumSolRaw,now,
  watch:[{address:s.ata(LIQUIDITY_USDC),program:TOKEN_PROGRAM_ID,minimum:s.usdcBalance-p.usdcRaw},{address:s.ata(s.mint,TOKEN_2022_PROGRAM_ID),program:TOKEN_2022_PROGRAM_ID,minimum:s.reserveBalance-maximumReserveDebitRaw},{address:s.ata(s.lp),program:TOKEN_PROGRAM_ID,minimum:locked?0n:minimumLpRaw}]});
 const payerCost=(r:Awaited<ReturnType<typeof simulate>>)=>BigInt(r.solCostsByWallet?.find(c=>c.wallet===SSR_POOL_PAYER.toBase58())?.lamports??'0');
 check(p.maximumSolRaw>POOL_PAYER_REFUND_MARGIN_LAMPORTS,'Choose a higher SOL cost cap');
 const first=await simulate(p.maximumSolRaw-POOL_PAYER_REFUND_MARGIN_LAMPORTS);
 const measured=payerCost(first)+p.maximumSolRaw;
 check(measured>0n&&measured<=p.maximumSolRaw,'Pool launch SOL cost exceeds your cap');
 const prepared=await simulate(measured);
 const payerNetCostLamports=payerCost(prepared);
 check(payerNetCostLamports<=0n,'Pool launch refund does not cover the pool payer; nothing was submitted');
 return {...prepared,payerNetCostLamports:payerNetCostLamports.toString(),review:{navUsdc:nav.navUsdc.toString(),usdcDebitRaw:p.usdcRaw.toString(),reserveDebitRaw:maximumReserveDebitRaw.toString(),lpAddedRaw:built.expectedLpRaw.toString(),lock:p.lock,buyTaxBps:String(p.buyTaxBps),sellTaxBps:String(p.sellTaxBps),holderShareBps:String(p.holderShareBps),initialLpOwner:s.treasury.toBase58()},tranche:locked?.tranche.toBase58()};
}
