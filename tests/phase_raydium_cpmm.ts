import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { RAYDIUM_CPMM, SSR_POOL_PAYER, SSR_CPMM_CONFIG, LIQUIDITY_USDC, permissionAddress, verifyPermission, decodeConfig, effectiveCreatorShare, netCreatorEarnings, decodePool, RaydiumPermissionedCpmmAdapter, prepareRevenuePool } from '../src/merge/lib/liquidity/raydiumCpmm';
function account(kind: string, size: number): AccountInfo<Buffer> {
  const data = Buffer.alloc(size);
  createHash('sha256').update('account:' + kind).digest().copy(data,0,0,8);
  return { data, owner: RAYDIUM_CPMM, executable:false,lamports:1,rentEpoch:0 };
}
const treasury = new PublicKey('11111111111111111111111111111112');
const reserve = new PublicKey('11111111111111111111111111111113');
function permission() { const a=account('Permission',280); SSR_POOL_PAYER.toBuffer().copy(a.data,8); return a; }
function config() { const a=account('AmmConfig',236);a.data.writeUInt16LE(9,10);a.data.writeBigUInt64LE(2500n,12);a.data.writeBigUInt64LE(7500n,108);a.data.writeBigUInt64LE(50000n,116);return a; }
function pool() {
  const a=account('PoolState',637);
  for(const [offset,key] of [[8,SSR_CPMM_CONFIG],[40,treasury],[72,reserve],[104,LIQUIDITY_USDC],[168,reserve],[200,LIQUIDITY_USDC],[232,TOKEN_2022_PROGRAM_ID],[264,TOKEN_PROGRAM_ID]] as const) key.toBuffer().copy(a.data,offset);
  a.data[389]=2;a.data[390]=1;a.data.writeBigUInt64LE(1_000_000n,405); return a;
}
describe('Raydium permissioned CPMM adapter',()=>{
  it('derives the permission account actually granted by Raydium',()=>expect(permissionAddress().toBase58()).eq('HqMmvmtRUHup5ACL7mTf5bCj6STYB6ZUMgnd4CN8LmLB'));
  it('rejects missing, wrong-owner, wrong-discriminator and wrong-authority permissions',()=>{
    expect(()=>verifyPermission(null)).throws();
    for(const mutate of [(a:AccountInfo<Buffer>)=>{a.owner=treasury;},(a:AccountInfo<Buffer>)=>{a.data[0]^=1;},(a:AccountInfo<Buffer>)=>{treasury.toBuffer().copy(a.data,8);}]) {const a=permission();mutate(a);expect(()=>verifyPermission(a)).throws();}
  });
  it('fails closed if config economics or availability change',()=>{
    expect(decodeConfig(config()).creatorFeeShareRate).eq(50000n);
    const a=config();a.data[9]=1;expect(()=>decodeConfig(a)).throws();a.data[9]=0;a.data.writeBigUInt64LE(8000n,108);expect(()=>decodeConfig(a)).throws();
  });
  it('uses the per-treasury override and validates its identity',()=>{
    const a=account('CreatorFeeShare',145);treasury.toBuffer().copy(a.data,9);SSR_CPMM_CONFIG.toBuffer().copy(a.data,41);a.data.writeBigUInt64LE(0n,73);
    expect(effectiveCreatorShare(a,treasury,50000n)).eq(0n);
    expect(effectiveCreatorShare(null,treasury,50000n)).eq(50000n);
    expect(()=>effectiveCreatorShare(a,reserve,50000n)).throws();
  });
  it('retains 5% of the creator bucket with integer rounding in favour of the creator',()=>{
    expect(netCreatorEarnings(7500n,50000n)).eq(7125n);expect(netCreatorEarnings(1n,50000n)).eq(1n);
    expect(()=>netCreatorEarnings(100n,1000001n)).throws();
  });
  it('requires the expected Reserve/USDC pair, fixed treasury and USDC-only earnings',()=>{
    expect(decodePool(pool(),reserve,treasury).accruedUsdc).eq(1000000n);
    expect(()=>decodePool(pool(),treasury,treasury)).throws();expect(()=>decodePool(pool(),reserve,reserve)).throws();
    const a=pool();a.data[389]=0;expect(()=>decodePool(a,reserve,treasury)).throws();
  });
  it('builds permissionless collection to treasury ATAs, with current share accounts and no Compound',async()=>{
    const adapter=new RaydiumPermissionedCpmmAdapter({getAccountInfo:async()=>pool(),getMultipleAccountsInfo:async()=>[permission(),config(),null]});
    const result=await adapter.prepareCollect({payer:SSR_POOL_PAYER,pool:reserve,reserveMint:reserve,treasury});
    expect(result.netUsdcRaw).eq(950000n);
    expect(result.instruction.keys[8].pubkey.equals(getAssociatedTokenAddressSync(reserve,treasury,true,TOKEN_2022_PROGRAM_ID))).eq(true);
    expect(result.instruction.keys[9].pubkey.equals(getAssociatedTokenAddressSync(LIQUIDITY_USDC,treasury,true,TOKEN_PROGRAM_ID))).eq(true);
    expect(result.instruction.keys.length).eq(16);
    expect([...result.instruction.data]).deep.eq([...createHash('sha256').update('global:collect_creator_fee_permissionless').digest().subarray(0,8)]);
    expect((await adapter.readReadiness(treasury)).compoundBlocker).eq('LIVE_COMPOUND_EXECUTOR');
  });
});


describe('Revenue-routed pool creation preparation',()=>{
 it('atomically initializes the pool with the router as creator and then registers its fixed split',async()=>{
  const programId=new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9');
  const connection={getMultipleAccountsInfo:async()=>[permission(),config(),null],getAccountInfo:async(key:PublicKey)=>key.equals(reserve)?{...account('Mint',82),owner:TOKEN_2022_PROGRAM_ID}:null};
  const built=await prepareRevenuePool({connection:connection as any,programId,reserve:treasury,reserveMint:reserve,manager:treasury,payer:SSR_POOL_PAYER,protocolConfig:treasury,reserveAmountRaw:100n,usdcAmountRaw:200n,openTime:0n,buyTaxBps:0,sellTaxBps:200,holderShareBps:2500});
  expect(built.instructions).length(2);
  // DEC-0251: new pools register v2 terms -- discriminator, then buy, sell and holder share.
  expect([...built.instructions[1].data.subarray(0,8)]).deep.eq([249,29,142,23,75,103,25,88]);
  expect([built.instructions[1].data.readUInt16LE(8),built.instructions[1].data.readUInt16LE(10),built.instructions[1].data.readUInt16LE(12)]).deep.eq([0,200,2500]);
  expect(built.instructions[0].keys[1].pubkey.equals(built.revenue)).eq(true);
  expect(built.instructions[1].programId.equals(programId)).eq(true);
  expect(built.instructions[0].keys[0].pubkey.equals(SSR_POOL_PAYER)).eq(true);
  expect(built.initialLpOwner.equals(SSR_POOL_PAYER)).eq(true);
  expect(built.instructions[0].data[32]).eq(Buffer.compare(LIQUIDITY_USDC.toBuffer(),reserve.toBuffer())<0?1:2);
 });
 it('DEC-0251: before the upgrade executes, creates with the live v1 instruction and refuses a holder share',async()=>{
  const programId=new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9');
  const connection={getMultipleAccountsInfo:async()=>[permission(),config(),null],getAccountInfo:async(key:PublicKey)=>key.equals(reserve)?{...account('Mint',82),owner:TOKEN_2022_PROGRAM_ID}:null};
  const base={connection:connection as any,programId,reserve:treasury,reserveMint:reserve,manager:treasury,payer:SSR_POOL_PAYER,protocolConfig:treasury,reserveAmountRaw:100n,usdcAmountRaw:200n,openTime:0n,buyTaxBps:100,sellTaxBps:200,termsV2:false};
  const built=await prepareRevenuePool({...base,holderShareBps:0});
  expect([...built.instructions[1].data.subarray(0,8)]).deep.eq([218,58,113,200,121,81,159,178]);
  expect(built.instructions[1].data.length).eq(12);
  try{await prepareRevenuePool({...base,holderShareBps:100});expect.fail('must reject');}catch(e){expect(String(e)).include('next protocol upgrade');}
 });
 it('rejects creation by an unapproved payer before requesting funding',async()=>{
  let reads=0;
  const connection={getMultipleAccountsInfo:async()=>{reads++;return[];},getAccountInfo:async()=>null};
  try {await prepareRevenuePool({connection:connection as any,programId:treasury,reserve:treasury,reserveMint:reserve,manager:treasury,payer:treasury,protocolConfig:treasury,reserveAmountRaw:100n,usdcAmountRaw:200n,openTime:0n,buyTaxBps:0,sellTaxBps:0,holderShareBps:0});expect.fail('must reject');}catch(e){expect(String(e)).include('approved payer');}
  expect(reads).eq(0);
 });
});
