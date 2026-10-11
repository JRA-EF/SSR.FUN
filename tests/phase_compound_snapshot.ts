import {expect} from 'chai';
import {createHash} from 'node:crypto';
import {BN} from '@anchor-lang/core';
import {Connection,PublicKey,SYSVAR_CLOCK_PUBKEY,type AccountInfo} from '@solana/web3.js';
import {MintLayout,AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {buildReadOnlyProgram,findReserve,findReserveAsset,findReserveVault,findVaultAuthority,findProtocolConfig,findLiquidityRevenue} from '@ssr/sdk';
import {readCompoundSnapshot} from '../lib/mainnet/compoundQuotes';
import {RAYDIUM_CPMM,SSR_CPMM_CONFIG,LIQUIDITY_USDC} from '../src/merge/lib/liquidity/raydiumCpmm';
const id=new PublicKey('8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9');
const program=buildReadOnlyProgram(new Connection('http://localhost:8899')) as any;
const key=(n:number)=>new PublicKey(Uint8Array.from({length:32},(_,i)=>i===31?n:0));
function info(data:Buffer,owner:PublicKey):AccountInfo<Buffer>{return{data,owner,lamports:1,executable:false,rentEpoch:0};}
function mintInfo(owner:PublicKey,supply=1_000_000_000n){const b=Buffer.alloc(82);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},b);return info(b,owner);}
function tokenInfo(mint:PublicKey,owner:PublicKey,amount:bigint,programId=TOKEN_PROGRAM_ID){const b=Buffer.alloc(165);AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},b);return info(b,programId);}
function native(name:string,size:number){const b=Buffer.alloc(size);createHash('sha256').update(`account:${name}`).digest().copy(b,0,0,8);return info(b,RAYDIUM_CPMM);}
async function fixture(){
  const reserve=findReserve(1n,id)[0],creator=key(10),treasury=key(11),rt=key(12),asset=key(13);
  const [m0,m1]=[LIQUIDITY_USDC,rt].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
  const pda=(...seeds:Buffer[])=>PublicKey.findProgramAddressSync(seeds,RAYDIUM_CPMM)[0];
  const pool=pda(Buffer.from('pool'),SSR_CPMM_CONFIG.toBuffer(),m0.toBuffer(),m1.toBuffer());
  const lp=pda(Buffer.from('pool_lp_mint'),pool.toBuffer()),v0=key(14),v1=key(15),router=findLiquidityRevenue(reserve,id),authority=pda(Buffer.from('vault_and_lp_mint_auth_seed'));
  const map=new Map<string,AccountInfo<Buffer>>();
  const set=(k:PublicKey,v:AccountInfo<Buffer>)=>map.set(k.toBase58(),v);
  const encode=async(name:string,value:any)=>info(await program.coder.accounts.encode(name,value),id);
  set(reserve,await encode('reserve',{schemaVersion:1,reserveId:new BN(1),manager:creator,reserveTokenMint:rt,status:{active:{}},assetCount:1,totalTargetWeightBps:10000,createdAt:new BN(0),configuredAt:new BN(0),feeConfig:{mintFeeBps:0,redemptionFeeBps:0,annualTvlFeeBps:0,managerFeeShareBps:5000,protocolFeeShareBps:5000,feeDestination:treasury,lastFeeAccrualTs:new BN(0),pendingManagerFeeShares:new BN(0),pendingProtocolFeeShares:new BN(0)},metadataUri:'',delegateCount:0,bump:0,vaultAuthorityBump:0,mintAuthorityBump:0}));
  const registration=findReserveAsset(reserve,asset,id)[0],vault=findReserveVault(reserve,asset,id)[0];
  set(registration,await encode('reserveAsset',{reserve,assetMint:asset,vault,tokenProgram:{splToken:{}},decimals:6,targetWeightBps:10000,enabled:true,orderIndex:0,bump:0}));
  set(router,await encode('liquidityRevenue',{reserve,pool,treasury,buyTaxBps:0,sellTaxBps:0,retainedRate:new BN(50000),remainder:new BN(0),bump:0}));
  set(findProtocolConfig(id)[0],await encode('protocolConfig',{schemaVersion:1,authority:creator,admin2:creator,paused:false,maxReserveAssets:12,defaultProtocolFeeBps:50,defaultProtocolFeeDestination:creator,reserveCount:new BN(2),bump:0}));
  const p=native('PoolState',637);
  for(const [offset,k] of [[8,SSR_CPMM_CONFIG],[40,router],[72,v0],[104,v1],[136,lp],[168,m0],[200,m1],[232,m0.equals(rt)?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID],[264,m1.equals(rt)?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID]] as const)k.toBuffer().copy(p.data,offset);
  p.data[389]=m0.equals(LIQUIDITY_USDC)?1:2;p.data[390]=1;p.data.writeBigUInt64LE(1_000_000_000n,333);
  // Accrued fees must be excluded from usable liquidity.
  p.data.writeBigUInt64LE(100n,341);p.data.writeBigUInt64LE(200n,357);p.data.writeBigUInt64LE(300n,397);set(pool,p);
  const config=native('AmmConfig',236);config.data.writeUInt16LE(9,10);for(const [offset,value] of [[12,2500n],[20,120000n],[28,40000n],[108,7500n],[116,50000n]] as const)config.data.writeBigUInt64LE(value,offset);set(SSR_CPMM_CONFIG,config);
  set(rt,mintInfo(TOKEN_2022_PROGRAM_ID));set(lp,mintInfo(TOKEN_PROGRAM_ID));set(asset,mintInfo(TOKEN_PROGRAM_ID));
  set(v0,tokenInfo(m0,authority,1_000_000_000n,m0.equals(rt)?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID));
  set(v1,tokenInfo(m1,authority,1_000_000_000n,m1.equals(rt)?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID));
  set(vault,tokenInfo(asset,findVaultAuthority(reserve,id)[0],1_000_000_000n));
  set(getAssociatedTokenAddressSync(LIQUIDITY_USDC,treasury,true),tokenInfo(LIQUIDITY_USDC,treasury,100_000_000n));
  const clock=Buffer.alloc(40);clock.writeBigUInt64LE(100n,16);clock.writeBigInt64LE(1800000000n,32);set(SYSVAR_CLOCK_PUBKEY,info(clock,key(30)));
  let batches=0;
  const connection={getAccountInfo:async(k:PublicKey)=>map.get(k.toBase58())??null,getProgramAccounts:async()=>[{pubkey:registration,account:map.get(registration.toBase58())}],
    getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{batches++;return{context:{slot:1000},value:keys.map(k=>map.get(k.toBase58())??null)};},getMinimumBalanceForRentExemption:async()=>2_039_280} as any;
  return {map,pool,reserve,creator,treasury,rt,lp,v0,vault,batches:()=>batches,
    run:()=>readCompoundSnapshot({connection,program,programId:id,now:()=>1800000000000},{reserve,pool,creator,budgetUsdcRaw:10_000_000n,slippageBps:100,lpDestination:getAssociatedTokenAddressSync(lp,treasury,true),lockPolicyId:'unlocked'})};
}
async function fails(f:()=>Promise<any>,text:string){let err='';try{await f();}catch(e){err=String(e);}expect(err).contain(text);}
describe('Compound contextual account snapshot',()=>{
  it('decodes actual account layouts, excludes accrued fees and binds all reads to one financial snapshot',async()=>{
    const f=await fixture(),s=await f.run();expect(f.batches()).eq(1);expect(s.epoch).eq(100n);expect(s.context.snapshotSlot).eq(1000);
    expect([s.usdc,s.tokens]).contain(999_999_400n);expect(s.mintFeeBps).eq(50n);expect(s.mintAllowed).eq(true);expect(s.assets[0].balance).eq(1_000_000_000n);
    const hash=s.context.stateFingerprint;
    const clock=f.map.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data;clock.writeBigUInt64LE(1001n,0);clock.writeBigInt64LE(1800000001n,32);expect((await f.run()).context.stateFingerprint).eq(hash);
    clock.writeBigUInt64LE(101n,16);expect((await f.run()).context.stateFingerprint).not.eq(hash);clock.writeBigUInt64LE(100n,16);
    f.map.get(f.vault.toBase58())!.data.writeBigUInt64LE(2_000_000_000n,64);expect((await f.run()).context.stateFingerprint).not.eq(hash);
  });
  it('rejects missing revenue registration rather than inventing tax/treasury defaults',async()=>{const f=await fixture();f.map.delete(findLiquidityRevenue(f.reserve,id).toBase58());await fails(f.run,'owner mismatch');});
  it('rejects account substitution, disabled pools, unsupported retention and insufficient treasury funds',async()=>{
    for(const change of [
      (f:any)=>{f.map.get(f.vault.toBase58()).owner=f.creator;},
      (f:any)=>{f.map.get(f.pool.toBase58()).data[329]=1;},
      (f:any)=>{f.map.get(SSR_CPMM_CONFIG.toBase58()).data.writeBigUInt64LE(60000n,116);},
      (f:any)=>{f.map.get(getAssociatedTokenAddressSync(LIQUIDITY_USDC,f.treasury,true).toBase58()).data.writeBigUInt64LE(1n,64);},
    ]){const f=await fixture();change(f);let failed=false;try{await f.run();}catch{failed=true;}expect(failed).eq(true);}
  });
});
