/** Secondary-market fee policy. No signing or submission; Compound policy: DEC-0233; live spending is not enabled. */
import { PublicKey, TransactionInstruction, SystemProgram, type AccountMeta } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
export const LIQUIDITY_REVENUE_SEED = 'liquidity_revenue';
export const PROJECT_TAX_MAX_BPS = 200;
export function findLiquidityRevenue(reserve: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(LIQUIDITY_REVENUE_SEED),reserve.toBuffer()],programId)[0];
}
export function splitProjectTax(usdc: bigint, taxBps: number) {
  if(usdc<0n || !Number.isInteger(taxBps) || taxBps<0 || taxBps>PROJECT_TAX_MAX_BPS) throw new Error('Invalid secondary-market tax');
  const total=(usdc*BigInt(taxBps)+9999n)/10000n;
  const creator=total*3n/4n;
  return { total, protocol:total-creator, creator };
}
export function splitNativeCreatorRevenue(netUsdc: bigint, retainedRate: bigint, carry=0n) {
  if(netUsdc<0n || retainedRate<0n || retainedRate>50_000n) throw new Error('Unsupported Raydium retention');
  const denominator=7500n*(1_000_000n-retainedRate);
  if(carry<0n || carry>=denominator) throw new Error('Invalid revenue remainder');
  const numerator=netUsdc*500n*1_000_000n+carry;
  const protocol=numerator/denominator;
  return { protocol, creator:netUsdc-protocol, remainder:numerator%denominator };
}
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false):AccountMeta=>({pubkey,isWritable,isSigner});
const u64=(value:bigint)=>{if(value<0n||value>0xffffffffffffffffn)throw new Error('Amount outside u64');const b=Buffer.alloc(8);b.writeBigUInt64LE(value);return b;};
const DISCRIMINATORS = {
  configure: Buffer.from([218,58,113,200,121,81,159,178]),
  distribute: Buffer.from([16,135,176,113,20,129,246,198]),
  swap: Buffer.from([250,157,51,80,53,172,78,30]),
};
export function buildConfigureLiquidityRevenue(input:{programId:PublicKey;manager:PublicKey;protocolConfig:PublicKey;reserve:PublicKey;pool:PublicKey;ammConfig:PublicKey;creatorFeeShare:PublicKey;buyTaxBps:number;sellTaxBps:number}) {
  splitProjectTax(0n,input.buyTaxBps);splitProjectTax(0n,input.sellTaxBps);
  const b=Buffer.alloc(4);b.writeUInt16LE(input.buyTaxBps);b.writeUInt16LE(input.sellTaxBps,2);
  return new TransactionInstruction({programId:input.programId,data:Buffer.concat([DISCRIMINATORS.configure,b]),keys:[meta(input.manager,true,true),meta(input.protocolConfig),meta(input.reserve),meta(findLiquidityRevenue(input.reserve,input.programId),true),meta(input.pool),meta(input.ammConfig),meta(input.creatorFeeShare),meta(SystemProgram.programId)]});
}
export function buildDistributeLiquidityRevenue(input:{programId:PublicKey;protocolConfig:PublicKey;reserve:PublicKey;staging:PublicKey;protocolDestination:PublicKey;creatorDestination:PublicKey;ammConfig:PublicKey;creatorFeeShare:PublicKey}) {
 return new TransactionInstruction({programId:input.programId,data:DISCRIMINATORS.distribute,keys:[meta(input.protocolConfig),meta(findLiquidityRevenue(input.reserve,input.programId),true),meta(input.staging,true),meta(input.protocolDestination,true),meta(input.creatorDestination,true),meta(input.ammConfig),meta(input.creatorFeeShare),meta(TOKEN_PROGRAM_ID)]});
}
export function buildSwapWithProjectTax(input:{programId:PublicKey;user:PublicKey;protocolConfig:PublicKey;reserve:PublicKey;userUsdc:PublicKey;protocolDestination:PublicKey;creatorDestination:PublicKey;raydiumProgram:PublicKey;nativeSwapAccounts:AccountMeta[];buy:boolean;amountIn:bigint;minimumNetOut:bigint}) {
 if(input.nativeSwapAccounts.length!==13 || input.amountIn<=0n || input.minimumNetOut<=0n)throw new Error('Invalid taxed swap');
 return new TransactionInstruction({programId:input.programId,data:Buffer.concat([DISCRIMINATORS.swap,Buffer.from([input.buy?1:0]),u64(input.amountIn),u64(input.minimumNetOut)]),keys:[meta(input.user,false,true),meta(input.protocolConfig),meta(findLiquidityRevenue(input.reserve,input.programId)),meta(input.userUsdc,true),meta(input.protocolDestination,true),meta(input.creatorDestination,true),meta(input.raydiumProgram),meta(TOKEN_PROGRAM_ID),...input.nativeSwapAccounts]});
}

// DEC-0251: liquidity terms v2 for pools created from that upgrade on.
// SSR takes 20% of everything the creator earns from the pool (collected
// creator fee and Buy/Sell tax); the creator may give a share of the
// remaining 80%, fixed at launch, to holders. That share is paid in USDC to
// the basket feed (the LiquidityTerms PDA's USDC ATA), released over 24
// hours, and swapped by SSR's keeper into the Reserve's assets.
export const LIQUIDITY_TERMS_SEED = 'liquidity_terms';
export const SSR_CREATOR_SHARE_BPS = 2000;
export const HOLDER_SHARE_MAX_BPS = 10_000;
export const BASKET_FEED_RELEASE_SECONDS = 86_400;
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const DISCRIMINATORS_V2 = {
  configure: Buffer.from([249,29,142,23,75,103,25,88]),
  distribute: Buffer.from([245,224,145,76,23,23,198,78]),
  swap: Buffer.from([218,221,123,238,72,114,124,210]),
  feedBegin: Buffer.from([139,58,246,245,166,201,101,189]),
  termsAccount: Buffer.from([4,203,181,73,116,168,168,255]),
};
export function findLiquidityTerms(reserve: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(LIQUIDITY_TERMS_SEED),findLiquidityRevenue(reserve,programId).toBuffer()],programId)[0];
}
/** The basket feed: the terms PDA's canonical USDC account. */
export function findBasketFeed(reserve: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([findLiquidityTerms(reserve,programId).toBuffer(),TOKEN_PROGRAM_ID.toBuffer(),USDC_MINT.toBuffer()],ASSOCIATED_TOKEN_PROGRAM)[0];
}
function checkHolderShare(holderShareBps:number){
  if(!Number.isInteger(holderShareBps)||holderShareBps<0||holderShareBps>HOLDER_SHARE_MAX_BPS)throw new Error('Holder share must be between 0% and 100% of the creator portion');
}
/** Mirrors `holder_part`: rounded down, in the creator's favour. */
export function holderPart(creatorUsdc: bigint, holderShareBps: number): bigint {
  checkHolderShare(holderShareBps);
  return creatorUsdc*BigInt(holderShareBps)/10_000n;
}
/** Mirrors `distribute_v2`: SSR 20% (with carry), then the holder share of the rest. */
export function splitCreatorRevenueV2(netUsdc: bigint, holderShareBps: number, carry=0n) {
  if(netUsdc<0n||carry<0n||carry>=10_000n)throw new Error('Invalid creator revenue');
  const numerator=netUsdc*BigInt(SSR_CREATOR_SHARE_BPS)+carry;
  const protocol=numerator/10_000n;
  const holders=holderPart(netUsdc-protocol,holderShareBps);
  return { protocol, creator:netUsdc-protocol-holders, holders, remainder:numerator%10_000n };
}
/** Mirrors `tax_split_v2` plus the holder share. */
export function splitProjectTaxV2(usdc: bigint, taxBps: number, holderShareBps: number) {
  if(usdc<0n || !Number.isInteger(taxBps) || taxBps<0 || taxBps>PROJECT_TAX_MAX_BPS) throw new Error('Invalid secondary-market tax');
  const total=(usdc*BigInt(taxBps)+9999n)/10000n;
  const creatorTotal=total*BigInt(10_000-SSR_CREATOR_SHARE_BPS)/10_000n;
  const holders=holderPart(creatorTotal,holderShareBps);
  return { total, protocol:total-creatorTotal, creator:creatorTotal-holders, holders };
}
export interface LiquidityTermsState { reserve:PublicKey; revenue:PublicKey; holderShareBps:number; locked:bigint; unlocked:bigint; streamEnd:bigint; lastUpdate:bigint; totalFed:bigint; }
export function decodeLiquidityTerms(data: Buffer): LiquidityTermsState {
  if(data.length<115||!data.subarray(0,8).equals(DISCRIMINATORS_V2.termsAccount))throw new Error('Not a LiquidityTerms account');
  return { reserve:new PublicKey(data.subarray(8,40)), revenue:new PublicKey(data.subarray(40,72)), holderShareBps:data.readUInt16LE(72),
    locked:data.readBigUInt64LE(74), unlocked:data.readBigUInt64LE(82), streamEnd:data.readBigInt64LE(90), lastUpdate:data.readBigInt64LE(98), totalFed:data.readBigUInt64LE(106) };
}
/** Mirrors `LiquidityTerms::sync`: what `basket_feed_begin` may take at `now` given the feed's balance. */
export function releasedBasketFeed(terms: LiquidityTermsState, now: bigint, feedBalance: bigint) {
  let {locked,unlocked,streamEnd}=terms;
  if(now>terms.lastUpdate&&locked>0n){
    if(now>=streamEnd){unlocked+=locked;locked=0n;}
    else{const r=locked*(now-terms.lastUpdate)/(streamEnd-terms.lastUpdate);locked-=r;unlocked+=r;}
  }
  const tracked=locked+unlocked;
  if(feedBalance<tracked){unlocked=unlocked<feedBalance?unlocked:feedBalance;const rest=feedBalance-unlocked;locked=locked<rest?locked:rest;}
  else if(feedBalance>tracked){locked+=feedBalance-tracked;streamEnd=now+BigInt(BASKET_FEED_RELEASE_SECONDS);}
  return { locked, unlocked, streamEnd };
}
export function buildConfigureLiquidityRevenueV2(input:{programId:PublicKey;manager:PublicKey;protocolConfig:PublicKey;reserve:PublicKey;pool:PublicKey;ammConfig:PublicKey;creatorFeeShare:PublicKey;buyTaxBps:number;sellTaxBps:number;holderShareBps:number}) {
  splitProjectTax(0n,input.buyTaxBps);splitProjectTax(0n,input.sellTaxBps);checkHolderShare(input.holderShareBps);
  const b=Buffer.alloc(6);b.writeUInt16LE(input.buyTaxBps);b.writeUInt16LE(input.sellTaxBps,2);b.writeUInt16LE(input.holderShareBps,4);
  return new TransactionInstruction({programId:input.programId,data:Buffer.concat([DISCRIMINATORS_V2.configure,b]),keys:[meta(input.manager,true,true),meta(input.protocolConfig),meta(input.reserve),
    meta(findLiquidityRevenue(input.reserve,input.programId),true),meta(findLiquidityTerms(input.reserve,input.programId),true),meta(findBasketFeed(input.reserve,input.programId),true),meta(USDC_MINT),
    meta(input.pool),meta(input.ammConfig),meta(input.creatorFeeShare),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM),meta(SystemProgram.programId)]});
}
export function buildDistributeLiquidityRevenueV2(input:{programId:PublicKey;protocolConfig:PublicKey;reserve:PublicKey;staging:PublicKey;protocolDestination:PublicKey;creatorDestination:PublicKey;ammConfig:PublicKey;creatorFeeShare:PublicKey}) {
 return new TransactionInstruction({programId:input.programId,data:DISCRIMINATORS_V2.distribute,keys:[meta(input.protocolConfig),meta(findLiquidityRevenue(input.reserve,input.programId),true),meta(findLiquidityTerms(input.reserve,input.programId),true),
   meta(input.staging,true),meta(input.protocolDestination,true),meta(input.creatorDestination,true),meta(findBasketFeed(input.reserve,input.programId),true),meta(input.ammConfig),meta(input.creatorFeeShare),meta(TOKEN_PROGRAM_ID)]});
}
export function buildSwapWithProjectTaxV2(input:{programId:PublicKey;user:PublicKey;protocolConfig:PublicKey;reserve:PublicKey;userUsdc:PublicKey;protocolDestination:PublicKey;creatorDestination:PublicKey;raydiumProgram:PublicKey;nativeSwapAccounts:AccountMeta[];buy:boolean;amountIn:bigint;minimumNetOut:bigint}) {
 if(input.nativeSwapAccounts.length!==13 || input.amountIn<=0n || input.minimumNetOut<=0n)throw new Error('Invalid taxed swap');
 return new TransactionInstruction({programId:input.programId,data:Buffer.concat([DISCRIMINATORS_V2.swap,Buffer.from([input.buy?1:0]),u64(input.amountIn),u64(input.minimumNetOut)]),keys:[meta(input.user,false,true),meta(input.protocolConfig),
   meta(findLiquidityRevenue(input.reserve,input.programId)),meta(findLiquidityTerms(input.reserve,input.programId),true),meta(input.userUsdc,true),meta(input.protocolDestination,true),meta(input.creatorDestination,true),
   meta(findBasketFeed(input.reserve,input.programId),true),meta(input.raydiumProgram),meta(TOKEN_PROGRAM_ID),...input.nativeSwapAccounts]});
}
/** Must be followed (after the swap route, if any) by `rebalance_swap_end` for the same Reserve and buy mint. */
export function buildBasketFeedBegin(input:{programId:PublicKey;reserve:PublicKey;keeper:PublicKey;settlementKeeperConfig:PublicKey;keeperUsdc:PublicKey;
  reserveAssetBuy:PublicKey;vaultBuy:PublicKey;mintBuy:PublicKey;keeperBuyAccount:PublicKey;ticket:PublicKey;amountIn:bigint;minOut:bigint}) {
 if(input.amountIn<=0n||input.minOut<=0n)throw new Error('Invalid basket feed amount');
 return new TransactionInstruction({programId:input.programId,data:Buffer.concat([DISCRIMINATORS_V2.feedBegin,u64(input.amountIn),u64(input.minOut)]),keys:[meta(input.reserve),meta(input.keeper,true,true),meta(input.settlementKeeperConfig),
   meta(findLiquidityRevenue(input.reserve,input.programId)),meta(findLiquidityTerms(input.reserve,input.programId),true),meta(findBasketFeed(input.reserve,input.programId),true),meta(input.keeperUsdc,true),
   meta(input.reserveAssetBuy),meta(input.vaultBuy),meta(input.mintBuy),meta(input.keeperBuyAccount),meta(input.ticket,true),meta(INSTRUCTIONS_SYSVAR),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId)]});
}
