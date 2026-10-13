import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { computeEffectiveFeeSplit } from '../packages/sdk/src/feeMath';
import { computeRedemptionEntitlements } from '../packages/sdk/src/calculations';
import { splitNativeCreatorRevenue, splitProjectTax, buildConfigureLiquidityRevenue, findLiquidityRevenue } from '../packages/sdk/src/liquidityRevenue';
const key=(n:number)=>new PublicKey(Uint8Array.from({length:32},()=>n));
describe('SSR revenue policy',()=>{
 it('keeps live mint/redeem fees: configured zero stays zero (Creator ruling 2026-10-13; the DEC-0232 floor was not adopted)',()=>{
  expect(computeEffectiveFeeSplit(0n,50n).effectiveTotalBps).eq(0n);
  expect(computeEffectiveFeeSplit(30n,50n).effectiveTotalBps).eq(50n);
  expect(computeEffectiveFeeSplit(200n,50n).protocolBps).eq(100n);
  const [r]=computeRedemptionEntitlements(1_000_000n,0n,1_000_000n,[{mint:'asset',vaultBalance:1_000_000n}]);
  expect(r.entitlement).eq(1_000_000n);
 });
 it('reserves 0.05% equivalent from the native creator bucket after Raydium retention',()=>{
  const s=splitNativeCreatorRevenue(712_500n,50_000n);
  expect(s.protocol).eq(50_000n);expect(s.creator).eq(662_500n);
  expect(splitNativeCreatorRevenue(750_000n,0n).protocol).eq(50_000n);
  expect(()=>splitNativeCreatorRevenue(1n,50_001n)).throws();
 });
 it('fragmenting native collections cannot evade the protocol share',()=>{
  let carry=0n,protocol=0n;
  for(let i=0;i<10_000;i++){const s=splitNativeCreatorRevenue(1n,50_000n,carry);carry=s.remainder;protocol+=s.protocol;}
  const single=splitNativeCreatorRevenue(10_000n,50_000n);
  expect(protocol).eq(single.protocol);expect(carry).eq(single.remainder);
 });
 it('splits optional project tax 25/75; zero project tax has zero revenue',()=>{
  expect(splitProjectTax(1_000_000n,200)).deep.eq({total:20_000n,protocol:5_000n,creator:15_000n});
  expect(splitProjectTax(1_000_000n,0)).deep.eq({total:0n,protocol:0n,creator:0n});
  for(let n=0n;n<1000n;n++){const s=splitProjectTax(n,100);expect(s.protocol+s.creator).eq(s.total);}
  expect(()=>splitProjectTax(1n,201)).throws();expect(()=>splitProjectTax(-1n,0)).throws();
 });
 it('encodes the Anchor configure instruction and derives the fixed pool creator PDA',()=>{
  const ix=buildConfigureLiquidityRevenue({programId:key(1),manager:key(2),protocolConfig:key(3),reserve:key(4),pool:key(5),ammConfig:key(6),creatorFeeShare:key(7),buyTaxBps:0,sellTaxBps:200});
  expect(ix.data.subarray(0,8).equals(createHash('sha256').update('global:configure_liquidity_revenue').digest().subarray(0,8))).eq(true);
  expect(ix.data.readUInt16LE(10)).eq(200);
  expect(ix.keys[3].pubkey.equals(findLiquidityRevenue(key(4),key(1)))).eq(true);
 });
});
