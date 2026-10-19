/** OPEN-14: joint-sign atomic funding -> permissioned creation -> LP return.
 * Neither intermediate assets nor LP ownership can remain with the approved
 * payer if any step fails. The approved payer funds pool rent/creation fees. */
import {PublicKey,type Connection,type TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createTransferCheckedWithFeeInstruction,unpackMint,getTransferFeeConfig,getEpochFee,calculateFee} from '@solana/spl-token';
import {prepareRevenuePool,SSR_POOL_PAYER,LIQUIDITY_USDC} from '../../src/merge/lib/liquidity/raydiumCpmm';
import {transferGross,transferNet} from './compoundQuotes';
export function integerSqrt(n:bigint):bigint {if(n<0n)throw new Error('Negative initial liquidity');if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
export interface AtomicPoolInput {connection:Connection;program:any;programId:PublicKey;reserve:PublicKey;reserveMint:PublicKey;manager:PublicKey;treasury:PublicKey;protocolConfig:PublicKey;reserveAmountRaw:bigint;usdcAmountRaw:bigint;maximumReserveDebitRaw:bigint;minimumLpRaw:bigint;openTime:bigint;buyTaxBps:number;sellTaxBps:number;holderShareBps:number;}
export async function prepareAtomicRevenuePool(p:AtomicPoolInput){
 const [mintInfo,epoch,reserveInfo]=await Promise.all([p.connection.getAccountInfo(p.reserveMint,'confirmed'),p.connection.getEpochInfo('confirmed'),p.connection.getAccountInfo(p.reserve,'confirmed')]);
 if(!reserveInfo?.owner.equals(p.programId))throw new Error('Reserve unavailable');
 const reserve=p.program.coder.accounts.decode('reserve',reserveInfo.data);
 if(!new PublicKey(reserve.manager).equals(p.manager)||!new PublicKey(reserve.reserveTokenMint).equals(p.reserveMint)||!new PublicKey(reserve.feeConfig.feeDestination).equals(p.treasury))throw new Error('Pool creator or fixed treasury changed');
 if(!mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID))throw new Error('A new Token-2022 Reserve is required');
 const mint=unpackMint(p.reserveMint,mintInfo,TOKEN_2022_PROGRAM_ID),config=getTransferFeeConfig(mint),fee=config?getEpochFee(config,BigInt(epoch.epoch)):null;
 if(!config)throw new Error('Reserve transfer fee configuration is missing');
 if(p.usdcAmountRaw<=0n||p.usdcAmountRaw>0xffffffffffffffffn||p.reserveAmountRaw<=0n||p.reserveAmountRaw>0xffffffffffffffffn)throw new Error('Invalid initial liquidity amounts');
 const sameOwner=p.treasury.equals(SSR_POOL_PAYER);
 const debit=sameOwner?p.reserveAmountRaw:transferGross(p.reserveAmountRaw,fee);
 if(debit<=0n||debit>p.maximumReserveDebitRaw)throw new Error('Initial Reserve Token funding exceeds the reviewed cap');
 const netReserve=transferNet(p.reserveAmountRaw,fee),expectedLp=integerSqrt(netReserve*p.usdcAmountRaw)-100n;
 if(p.minimumLpRaw<=0n||expectedLp<p.minimumLpRaw)throw new Error('Initial liquidity is below the reviewed minimum');
 const built=await prepareRevenuePool({...p,payer:SSR_POOL_PAYER});
 const ata=(mint:PublicKey,owner:PublicKey,program=TOKEN_PROGRAM_ID)=>getAssociatedTokenAddressSync(mint,owner,true,program);
 const instructions:TransactionInstruction[]=[];
 for(const [m,program] of [[p.reserveMint,TOKEN_2022_PROGRAM_ID],[LIQUIDITY_USDC,TOKEN_PROGRAM_ID]] as const){
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(SSR_POOL_PAYER,ata(m,SSR_POOL_PAYER,program),SSR_POOL_PAYER,m,program));
 }
 if(!sameOwner){
  // Pin the funding-hop transfer fee so an epoch/rate change fails atomically.
  instructions.push(createTransferCheckedWithFeeInstruction(ata(p.reserveMint,p.treasury,TOKEN_2022_PROGRAM_ID),p.reserveMint,ata(p.reserveMint,SSR_POOL_PAYER,TOKEN_2022_PROGRAM_ID),p.treasury,debit,mint.decimals,fee?calculateFee(fee,debit):0n,[],TOKEN_2022_PROGRAM_ID));
  instructions.push(createTransferCheckedInstruction(ata(LIQUIDITY_USDC,p.treasury),LIQUIDITY_USDC,ata(LIQUIDITY_USDC,SSR_POOL_PAYER),p.treasury,p.usdcAmountRaw,6));
 }
 instructions.push(...built.instructions);
 if(!sameOwner){
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(SSR_POOL_PAYER,ata(built.lpMint,p.treasury),p.treasury,built.lpMint));
  instructions.push(createTransferCheckedInstruction(ata(built.lpMint,SSR_POOL_PAYER),built.lpMint,ata(built.lpMint,p.treasury),SSR_POOL_PAYER,expectedLp,9));
 }
 instructions.push(await p.program.methods.finalizeLiquidityPool().accounts({reserve:p.reserve,revenue:built.revenue,pool:built.pool,lpMint:built.lpMint,destination:ata(built.lpMint,p.treasury),payerLp:ata(built.lpMint,SSR_POOL_PAYER)}).instruction());
 return {...built,instructions,initialLpOwner:p.treasury,requiresSigners:[...new Map([SSR_POOL_PAYER,p.manager,p.treasury].map(k=>[k.toBase58(),k])).values()],
  reserveDebitRaw:debit,usdcDebitRaw:p.usdcAmountRaw,netReserveRaw:netReserve,expectedLpRaw:expectedLp,epoch:epoch.epoch,blockers:[] as string[]};
}
