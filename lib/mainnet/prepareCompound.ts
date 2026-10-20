import {LiquidityLookupRequired,loadLiquidityTables} from './liquidityLookup';
import {appendTrancheLock,type TrancheChoice} from './liquidityTranches';
/** Treasury-authorized atomic Compound construction and read-only simulation.
 * No signing/submission. Larger plans fail rather than secretly spending a
 * first leg; staged execution requires its own reviewed recovery plan. */
import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,type Connection,type AddressLookupTableAccount} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,unpackAccount} from '@solana/spl-token';
import {buildAuthorizeLiquidityAddition,assertCompoundApproval,validateCompoundQuote,buildCpmmDeposit,cpmmSwapAccounts,buildSwapWithProjectTax,buildSwapWithProjectTaxV2,findLiquidityTerms,findProtocolConfig,findMintAuthority,buildDirectMultiAssetMintInstructions,
  type CompoundApproval,type CompoundQuote} from '@ssr/sdk';
import {poolAcquisition,transferGross,compoundPlanFingerprint,type CompoundSnapshot,type CompoundReadDeps,readCompoundSnapshot} from './compoundQuotes';
import {LIQUIDITY_USDC,SSR_CPMM_CONFIG,RAYDIUM_CPMM} from '../../src/merge/lib/liquidity/raydiumCpmm';
import {buildJupiterSwapInstructionsWithRetry,type JupiterQuote,type JupiterInstructionJson} from './jupiter';

export const JUPITER_PROGRAM=new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const fail=(message:string):never=>{throw new Error(message);};
const assert=(ok:unknown,message:string)=>{if(!ok)fail(message);};
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
/** A blockhash lands for ~150 slots (~60 s); a review never outlives this much of it. */
export const BLOCKHASH_REVIEW_LIMIT_MS=55_000;
/** Plain-language reason for a failed simulation, from its program logs. */
export function simulationReason(logs:string[]|null|undefined):string{
  const lines=logs??[];
  if(lines.some(l=>/insufficient lamports/i.test(l)))return 'a wallet in this transaction does not have enough SOL';
  if(lines.some(l=>/insufficient funds/i.test(l)))return 'a token balance is too low';
  const anchor=[...lines].reverse().find(l=>/Error Message:/.test(l));
  return anchor?anchor.replace(/^.*Error Message:\s*/,'').replace(/\.$/,''):'a program rejected it';
}
export const messageDigest=(message:Uint8Array)=>createHash('sha256').update(message).digest('hex');
export interface PreparedLiquidity {
  action:'compound'|'collect'|'add'|'withdraw'|'create'|'lock'|'extend'|'unlock'|'permanent'|'setup';
  reserve:string;pool:string;creator:string;treasury:string;
  transactionBase64:string;messageHash:string;requiredSigners:string[];
  blockhash:string;lastValidBlockHeight:number;expiresAtMs:number;
  /** Server clock when the review was returned, so the browser can measure the window on its own clock. */
  serverNowMs?:number;
  networkFeeRaw:string;accountRentRaw:string;totalSolRaw:string;
  solCostsByWallet?:{wallet:string;lamports:string}[];
  simulation:{slot:number;unitsConsumed:number;passed:true};
  executionEnabled:boolean;
  /** Exact prepared message needs a separate explicit final confirmation. */
  confirmationText:string;
  quoteId?:string;
}
export interface PrepareCompoundDeps extends CompoundReadDeps {
  jupiterApiKey?:string;
  buildJupiter?:typeof buildJupiterSwapInstructionsWithRetry;
  executionEnabled:boolean;
}
export interface CompoundPlanInput {quote:CompoundQuote;approval:CompoundApproval;acquisitionPlan:any;lookupTables?:PublicKey[];}
function jsonInstruction(w:JupiterInstructionJson){
  assert(typeof w?.data==='string'&&w.data.length<=8192&&Array.isArray(w.accounts)&&w.accounts.length<=128,'Invalid Jupiter instruction');
  return new TransactionInstruction({programId:new PublicKey(w.programId),data:Buffer.from(w.data,'base64'),keys:w.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable}))});
}
/** Jupiter's shared_accounts_exact_out_route ABI ends with outAmount:u64,
 * quotedInAmount:u64, slippageBps:u16, platformFeeBps:u8. Pin the discriminator
 * and account roles; reject dynamic caps, arbitrary signers and cleanup. */
export function validateCompoundJupiterInstruction(w:JupiterInstructionJson,q:JupiterQuote,treasury:PublicKey,outputProgram:PublicKey):TransactionInstruction {
  const ix=jsonInstruction(w),d=ix.data,disc=createHash('sha256').update('global:shared_accounts_exact_out_route').digest().subarray(0,8);
  assert(ix.programId.equals(JUPITER_PROGRAM)&&d.length>=32&&d.subarray(0,8).equals(disc),'Unsupported Jupiter exact-output instruction');
  assert(d.readBigUInt64LE(d.length-19)===BigInt(q.outAmount)&&d.readBigUInt64LE(d.length-11)===BigInt(q.inAmount)&&d.readUInt16LE(d.length-3)===q.slippageBps&&d[d.length-1]===0,'Jupiter instruction changed the approved spending cap');
  const outputMint=new PublicKey(String(q.outputMint));
  const expected:[[number,PublicKey],[number,PublicKey],[number,PublicKey],[number,PublicKey],[number,PublicKey]]=[
    [2,treasury],[3,getAssociatedTokenAddressSync(LIQUIDITY_USDC,treasury,true)],
    [6,getAssociatedTokenAddressSync(outputMint,treasury,true,outputProgram)],[7,LIQUIDITY_USDC],[8,outputMint]];
  for(const [index,key] of expected)assert(ix.keys[index]?.pubkey.equals(key),'Jupiter redirected the treasury swap');
  assert(ix.keys[2].isSigner&&ix.keys.every(k=>!k.isSigner||k.pubkey.equals(treasury)),'Unexpected Jupiter signer');
  return ix;
}
/** Complete message, actual fee quote and RPC simulation of the whole atomic
 * transaction. No signature means no live funds can move. */
export async function simulateLiquidityTransaction(p:{connection:Connection;instructions:TransactionInstruction[];treasury:PublicKey;creator:PublicKey;lookupTables?:AddressLookupTableAccount[];
  feePayer?:PublicKey;solPayers?:PublicKey[];action:PreparedLiquidity['action'];reserve:PublicKey;pool:PublicKey;expiresAtMs:number;executionEnabled:boolean;quoteId?:string;
  watch?:{address:PublicKey;minimum:bigint;program:PublicKey}[];maximumSol?:bigint;now?:()=>number;
  /** When set, expiresAtMs is a preparation deadline and the signing window starts once simulation passes. */
  reviewWindowMs?:number}):Promise<PreparedLiquidity> {
  const now=p.now??Date.now;
  assert(now()<p.expiresAtMs,'Liquidity review expired; prepare again');
  const feePayer=p.feePayer??p.treasury;
  const latest=await p.connection.getLatestBlockhash('confirmed'),blockhashAtMs=now();
  const recent=await p.connection.getRecentPrioritizationFees({lockedWritableAccounts:[p.pool]});
  const priority=Math.min(50_000,Math.max(1_000,...recent.slice(-20).map(f=>f.prioritizationFee)));
  const memo=new TransactionInstruction({programId:MEMO,keys:[{pubkey:p.action==='collect'?feePayer:p.action==='unlock'?p.treasury:p.creator,isSigner:true,isWritable:false}],data:Buffer.from(`SSR ${p.action} ${p.quoteId??p.pool.toBase58()}`)});
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:priority}),...p.instructions,memo];
  const message=new TransactionMessage({payerKey:feePayer,recentBlockhash:latest.blockhash,instructions}).compileToV0Message(p.lookupTables??[]);
  const tx=new VersionedTransaction(message);
  let bytes:Uint8Array;try{bytes=tx.serialize();}catch{throw new LiquidityLookupRequired(instructions,p.reserve);}
  if(bytes!.length>1232)throw new LiquidityLookupRequired(instructions,p.reserve);
  assert(message.staticAccountKeys.length+message.addressTableLookups.reduce((n,t)=>n+t.readonlyIndexes.length+t.writableIndexes.length,0)<=64,'This route does not fit one atomic transaction; no partial acquisition was submitted');
  const signatures=message.staticAccountKeys.slice(0,message.header.numRequiredSignatures).map(k=>k.toBase58());
  assert(signatures.every(k=>k===p.treasury.toBase58()||k===p.creator.toBase58()||k===feePayer.toBase58()),'Unexpected transaction signer');
  const solPayers=[...new Map([feePayer,...(p.solPayers??[])].map(k=>[k.toBase58(),k])).values()];
  const [fee,balances,simulation]=await Promise.all([
    p.connection.getFeeForMessage(message,'confirmed'),Promise.all(solPayers.map(k=>p.connection.getBalance(k,'confirmed'))),
    p.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[...solPayers.map(k=>k.toBase58()),...(p.watch??[]).map(w=>w.address.toBase58())]}}),
  ]);
  assert(!simulation.value.err,`Liquidity simulation failed (${simulationReason(simulation.value.logs)}); nothing was submitted`);
  assert(fee.value!==null&&Number.isSafeInteger(fee.value)&&fee.value>=0,'Network fee unavailable');
  const solCostsByWallet=solPayers.map((payer,i)=>{
    const before=balances[i],after=simulation.value.accounts?.[i];
    // DEC-0240: the pool payer may end higher than it started (the creator refunds its rent), so only the fee payer may gain.
    assert(Number.isSafeInteger(before)&&after&&Number.isSafeInteger(after.lamports)&&(after.lamports<=before||payer.equals(feePayer)),'Could not measure the transaction SOL cost');
    return {wallet:payer.toBase58(),lamports:(BigInt(before)-BigInt(after!.lamports)).toString()};
  });
  const network=BigInt(fee.value!),total=solCostsByWallet.reduce((n,c)=>n+BigInt(c.lamports),0n);
  assert(total>=network,'Simulation did not expose complete fees; nothing was submitted');
  if(p.maximumSol!==undefined)assert(total<=p.maximumSol,'Exact SOL cost exceeds the selected quote; review a new quote');
  for(const [i,w] of (p.watch??[]).entries()){
    const a=simulation.value.accounts?.[i+solPayers.length];assert(a&&a.owner===w.program.toBase58(),'Simulation did not return the expected token account');
    const decoded=unpackAccount(w.address,{...a!,owner:new PublicKey(a!.owner),data:Buffer.from(a!.data[0],'base64')},w.program);
    assert(decoded.amount>=w.minimum,'Simulation violates an approved balance or liquidity minimum');
  }
  assert(now()<p.expiresAtMs,'Liquidity review expired during simulation; prepare again');
  const serverNowMs=now(),expiresAtMs=p.reviewWindowMs?Math.min(serverNowMs+p.reviewWindowMs,blockhashAtMs+BLOCKHASH_REVIEW_LIMIT_MS):p.expiresAtMs;
  return {action:p.action,reserve:p.reserve.toBase58(),pool:p.pool.toBase58(),creator:p.creator.toBase58(),treasury:p.treasury.toBase58(),
    transactionBase64:Buffer.from(bytes!).toString('base64'),messageHash:messageDigest(message.serialize()),requiredSigners:signatures,
    blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,expiresAtMs,serverNowMs,
    solCostsByWallet,networkFeeRaw:network.toString(),accountRentRaw:(total-network).toString(),totalSolRaw:total.toString(),
    simulation:{slot:simulation.context.slot,unitsConsumed:simulation.value.unitsConsumed??0,passed:true},executionEnabled:p.executionEnabled,confirmationText:p.action.toUpperCase(),quoteId:p.quoteId};
}
export function validateCompoundPlan(s:CompoundSnapshot,q:CompoundQuote,plan:any):void {
  validateCompoundQuote(q,q.context,s.readAtMs);
  const network=q.costs.filter(c=>c.kind==='networkFee'&&c.unit==='SOL').reduce((n,c)=>n+c.amountRaw,0n);
  const rent=q.costs.filter(c=>c.kind==='accountRent'&&c.unit==='SOL').reduce((n,c)=>n+c.amountRaw,0n);
  assert(q.id===q.planFingerprint&&q.planFingerprint===compoundPlanFingerprint(q.context,q.route,plan,network,rent),'Compound acquisition plan changed; approve again');
  assert(q.context.stateFingerprint===s.context.stateFingerprint,'Pool or treasury state changed; refresh and approve again');
  for(const key of ['creator','reserve','pool','reserveMint','lpMint','budgetUsdcRaw','slippageBps','lpDestination','lockPolicyId'] as const)assert(q.context[key]===s.context[key],'Compound destination or policy changed');
  assert(q.depositReserveGrossRaw===transferGross(q.depositReserveNetRaw,s.reserveTransferFee),'Deposit transfer fee changed');
  assert(['unlocked','1-month','3-month','6-month','12-month','permanent'].includes(q.context.lockPolicyId),'This executor cannot enforce the selected lock');
  if(q.route==='pool'){
    const native=poolAcquisition(s,q.acquisitionUsdcRaw);
    assert(plan?.amount===q.acquisitionUsdcRaw&&native.received===q.acquiredReserveRaw,'Pool acquisition changed');
    const lp=q.expectedLpRaw;
    assert(q.depositUsdcRaw===ceil(lp*native.usdc,s.lpSupply)&&q.depositReserveNetRaw===ceil(lp*native.tokens,s.lpSupply),'Pool deposit does not match the approved post-swap ratio');
  }else{
    assert(s.mintAllowed&&typeof plan?.gross==='bigint'&&plan.gross>0n&&plan.gross<=0xffffffffffffffffn,'Invalid mint acquisition');
    const fee=ceil(plan.gross*s.mintFeeBps,10_000n);
    assert(plan.gross-fee===q.acquiredReserveRaw,'Mint output changed');
    assert(Array.isArray(plan.quotes)&&plan.quotes.length===s.assets.length,'Incomplete basket acquisition');
    let cap=0n;
    s.assets.forEach((asset,i)=>{
      assert(!asset.transferFee||asset.transferFee.transferFeeBasisPoints===0,'Unsupported backing transfer fee');
      const required=ceil(plan.gross*asset.balance,s.reserveSupply),leg=plan.quotes[i];
      if(asset.mint===LIQUIDITY_USDC.toBase58()){assert(leg===null,'USDC basket leg must not swap');cap+=required;return;}
      assert(leg?.inputMint===LIQUIDITY_USDC.toBase58()&&leg.outputMint===asset.mint&&leg.swapMode==='ExactOut'&&leg.slippageBps===q.context.slippageBps&&BigInt(leg.outAmount)===required,'Basket instruction differs from approved requirements');
      assert(BigInt(leg.inAmount)>0n&&BigInt(leg.otherAmountThreshold)>=ceil(BigInt(leg.inAmount)*BigInt(10_000+q.context.slippageBps),10_000n)&&BigInt(leg.otherAmountThreshold)<=ceil(BigInt(leg.inAmount)*BigInt(10_000+q.context.slippageBps),10_000n)+1n,'Invalid basket cap');
      assert(Array.isArray(leg.routePlan)&&leg.routePlan.every((h:any)=>h?.swapInfo?.ammKey!==q.context.pool),'Basket changes the canonical pool');
      cap+=BigInt(leg.otherAmountThreshold);
    });
    assert(cap===q.acquisitionUsdcRaw,'Basket spending exceeds the reviewed acquisition budget');
    assert(q.depositUsdcRaw===ceil(q.expectedLpRaw*s.usdc,s.lpSupply)&&q.depositReserveNetRaw===ceil(q.expectedLpRaw*s.tokens,s.lpSupply),'Mint deposit ratio changed');
  }
}
export async function prepareCompound(deps:PrepareCompoundDeps,input:CompoundPlanInput):Promise<PreparedLiquidity> {
  const {quote:q,approval,acquisitionPlan:plan}=input,now=deps.now??Date.now;
  validateCompoundQuote(q,q.context,now());
  assertCompoundApproval(q,approval,q.context,q.context.creator,now());
  const reserve=new PublicKey(q.context.reserve),pool=new PublicKey(q.context.pool),creator=new PublicKey(q.context.creator);
  const s=await readCompoundSnapshot(deps,{reserve,pool,creator,budgetUsdcRaw:q.context.budgetUsdcRaw,slippageBps:q.context.slippageBps,lpDestination:new PublicKey(q.context.lpDestination),lockPolicyId:q.context.lockPolicyId});
  validateCompoundPlan(s,q,plan);
  assert(s.treasury&&s.protocolTreasury&&s.poolAccounts,'Treasury and pool accounts unavailable');
  const treasury=new PublicKey(s.treasury!),protocolTreasury=new PublicKey(s.protocolTreasury!),accounts=s.poolAccounts!;
  assert(PublicKey.isOnCurve(treasury.toBytes())&&PublicKey.isOnCurve(creator.toBytes()),'A program treasury requires its own multisig execution adapter');
  const reserveMint=new PublicKey(q.context.reserveMint),lpMint=new PublicKey(q.context.lpMint);
  const ata=(mint:PublicKey,program=TOKEN_PROGRAM_ID,owner=treasury)=>getAssociatedTokenAddressSync(mint,owner,true,program);
  const instructions:TransactionInstruction[]=[await buildAuthorizeLiquidityAddition(deps.program as any,{reserve,creator,owner:treasury}),createAssociatedTokenAccountIdempotentInstruction(treasury,ata(reserveMint,TOKEN_2022_PROGRAM_ID),treasury,reserveMint,TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(treasury,ata(lpMint),treasury,lpMint)];
  const tables:AddressLookupTableAccount[]=await loadLiquidityTables(deps.connection,reserve,input.lookupTables);
  if(q.route==='pool'){
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(treasury,ata(LIQUIDITY_USDC,TOKEN_PROGRAM_ID,protocolTreasury),protocolTreasury,LIQUIDITY_USDC));
    // DEC-0251: v2 pools route the holder share of the tax to the basket feed.
    const termsV2=!!(await deps.connection.getAccountInfo(findLiquidityTerms(reserve,deps.programId),'confirmed'));
    instructions.push((termsV2?buildSwapWithProjectTaxV2:buildSwapWithProjectTax)({programId:deps.programId,user:treasury,protocolConfig:findProtocolConfig(deps.programId)[0],reserve,userUsdc:ata(LIQUIDITY_USDC),protocolDestination:ata(LIQUIDITY_USDC,TOKEN_PROGRAM_ID,protocolTreasury),creatorDestination:ata(LIQUIDITY_USDC),raydiumProgram:RAYDIUM_CPMM,
      nativeSwapAccounts:cpmmSwapAccounts(accounts,treasury,SSR_CPMM_CONFIG,LIQUIDITY_USDC),buy:true,amountIn:q.acquisitionUsdcRaw,minimumNetOut:q.depositReserveGrossRaw}));
  }else{
    const results=await Promise.all(plan.quotes.map(async(leg:JupiterQuote|null,i:number)=>{
      if(!leg)return null;
      const asset=s.assets[i],program=new PublicKey(asset.tokenProgram!);
      const result=await (deps.buildJupiter??buildJupiterSwapInstructionsWithRetry)({quote:leg,userPublicKey:treasury.toBase58(),apiKey:deps.jupiterApiKey??'',dynamicSlippage:false,useSharedAccounts:true,destinationTokenAccount:ata(new PublicKey(asset.mint),program).toBase58()});
      if(result.kind!=='ok')throw new Error('Could not construct the approved Jupiter route');
      const built=result.value;assert(!built.cleanupInstruction,'Unexpected Jupiter cleanup');
      // Shared-route accounts are Jupiter-owned; only our verified destination
      // needs creation. Never execute arbitrary setup returned by a quote service.
      const assetMint=new PublicKey(asset.mint);
      const setup=[createAssociatedTokenAccountIdempotentInstruction(treasury,ata(assetMint,program),treasury,assetMint,program)];
      return {instructions:[...setup,validateCompoundJupiterInstruction(built.swapInstruction,leg,treasury,program)],tables:built.addressLookupTableAddresses};
    }));
    for(const r of results)if(r)instructions.push(...r.instructions);
    const addresses=[...new Set(results.flatMap(r=>r?.tables??[]))];
    assert(addresses.length<=16,'Too many lookup tables');
    for(const address of addresses){const result=await deps.connection.getAddressLookupTable(new PublicKey(address));assert(result.value&&result.value.isActive(),'Lookup table unavailable');tables.push(result.value!);}
    const minted=await buildDirectMultiAssetMintInstructions({program:deps.program as any,protocolConfig:findProtocolConfig(deps.programId)[0],protocolFeeDestination:protocolTreasury,reserve,reserveTokenMint:reserveMint,mintAuthority:findMintAuthority(reserve,deps.programId)[0],user:treasury,reserveTokenProgram:TOKEN_2022_PROGRAM_ID,
      reserveTokenSupplyRaw:s.reserveSupply.toString(),reserveTokensRequested:plan.gross,minReserveTokensOut:q.acquiredReserveRaw,slippageBps:0,
      assets:s.assets.map(a=>({mint:a.mint,decimals:a.decimals,reserveAsset:a.reserveAsset!,vault:a.vault!,vaultBalanceRaw:a.balance.toString(),tokenProgram:a.tokenProgram!}))});
    instructions.push(...minted.instructions);
  }
  const usdc0=accounts.mint0.equals(LIQUIDITY_USDC);
  instructions.push(buildCpmmDeposit(accounts,treasury,q.expectedLpRaw,usdc0?q.depositUsdcRaw:q.depositReserveGrossRaw,usdc0?q.depositReserveGrossRaw:q.depositUsdcRaw));
  assert(q.context.lockPolicyId==='unlocked'||s.chainTime!==undefined,'Chain time is required for a locked addition');
  const lock=await appendTrancheLock(deps,{reserve,pool,lp:lpMint,creator,treasury,time:s.chainTime??0n,registered:accounts},instructions,q.expectedLpRaw,q.context.lockPolicyId as TrancheChoice);
  const lockedWatch=lock&&lock.choice!=='permanent'?[{address:lock.escrow,program:TOKEN_PROGRAM_ID,minimum:q.expectedLpRaw}]:[];
  return simulateLiquidityTransaction({connection:deps.connection,instructions,treasury,creator,lookupTables:tables,action:'compound',reserve,pool,expiresAtMs:q.expiresAtMs,executionEnabled:deps.executionEnabled,quoteId:q.id,maximumSol:q.maximumSolCostRaw,now,
    watch:[{address:ata(LIQUIDITY_USDC),program:TOKEN_PROGRAM_ID,minimum:s.treasuryUsdcRaw!-q.context.budgetUsdcRaw},
      {address:ata(reserveMint,TOKEN_2022_PROGRAM_ID),program:TOKEN_2022_PROGRAM_ID,minimum:s.treasuryReserveRaw!},
      {address:ata(lpMint),program:TOKEN_PROGRAM_ID,minimum:s.treasuryLpRaw!+(lock?0n:q.minimumLpRaw)},...lockedWatch]});
}
