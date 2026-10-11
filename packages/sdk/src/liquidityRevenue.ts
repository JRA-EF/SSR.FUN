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
