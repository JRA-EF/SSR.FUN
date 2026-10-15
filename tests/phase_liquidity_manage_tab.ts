import {expect} from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import {checkLiveState,checkPrepared,fromRaw,summarizeLiquidity,toRaw,type LiveLiquidityState} from '../src/merge/lib/liquidity/liveLiquidityClient';

const ROOT=path.resolve(__dirname,'..');
const ids={reserve:'R',creator:'C',treasury:'T'};
const NOW=Date.UTC(2026,9,14);
function state(over:Partial<LiveLiquidityState>={}):LiveLiquidityState{
 return {...ids,pool:'P',hasPool:true,paused:false,executionEnabled:true,reserveDecimals:6,lpDecimals:9,
  usdcBalanceRaw:'0',reserveBalanceRaw:'0',lpBalanceRaw:'1000000000',nativeEarningsUsdcRaw:'1500000',stagedEarningsUsdcRaw:'500000',
  poolUsdcRaw:'5000000000',poolReserveRaw:'4000000000',lpSupplyRaw:'4000000000',tranches:[],...over};
}
function plan(over:Record<string,unknown>={}){
 return {action:'add',...ids,confirmationText:'ADD',expiresAtMs:Date.now()+20000,executionEnabled:true,simulation:{passed:true},totalSolRaw:'1000',...over};
}

describe('Manage Reserve liquidity tab (live)',()=>{
 it('accepts a released plan -- regression: the client used to demand executionEnabled===false',()=>{
  expect(()=>checkPrepared(plan(),{action:'add',...ids,maximumSolRaw:'5000'})).to.not.throw();
  expect(()=>checkPrepared(plan({executionEnabled:false}),{action:'add',...ids,maximumSolRaw:'5000'})).to.not.throw();
  expect(()=>checkPrepared(plan({executionEnabled:undefined}),{action:'add',...ids,maximumSolRaw:'5000'})).to.throw('changed');
 });
 it('rejects a plan for another action, treasury, or over the SOL cap',()=>{
  expect(()=>checkPrepared(plan({action:'withdraw'}),{action:'add',...ids,maximumSolRaw:'5000'})).to.throw('changed');
  expect(()=>checkPrepared(plan({treasury:'X'}),{action:'add',...ids,maximumSolRaw:'5000'})).to.throw('changed');
  expect(()=>checkPrepared(plan({totalSolRaw:'6000'}),{action:'add',...ids,maximumSolRaw:'5000'})).to.throw('cap');
 });
 it('no client component still requires an unreleased plan for live liquidity',()=>{
  for(const f of ['src/merge/components/LiquidityLookupSetup.tsx','src/merge/components/LiveLiquidityActions.tsx','src/merge/components/LiveLiquiditySection.tsx'])
   expect(fs.readFileSync(path.join(ROOT,f),'utf8')).to.not.match(/executionEnabled\s*!==\s*false/);
 });
 it('validates the read payload',()=>{
  expect(()=>checkLiveState(state(),ids)).to.not.throw();
  expect(()=>checkLiveState({...state(),creator:'Z'},ids)).to.throw('identity');
  expect(()=>checkLiveState({...state(),poolUsdcRaw:'-1'},ids)).to.throw('balance');
 });
 it('derives pool liquidity, price, earnings, position and locks',()=>{
  const day=86400;
  const s=summarizeLiquidity(state({tranches:[
   {address:'A',unlockTs:String(NOW/1000+30*day),permanent:false,withdrawn:false,lpRaw:'1000000000'},
   {address:'B',unlockTs:String(NOW/1000-day),permanent:false,withdrawn:false,lpRaw:'0'},
   {address:'C',unlockTs:'0',permanent:true,withdrawn:false,lpRaw:'0'},
   {address:'D',unlockTs:'0',permanent:false,withdrawn:true,lpRaw:'0'},
  ]}),1.0,NOW);
  expect(s.tvlUsd).to.equal(10000);
  expect(s.marketPrice).to.equal(1.25);
  expect(s.premiumPct).to.be.closeTo(25,1e-9);
  expect(s.earningsUsdc).to.equal(2);
  expect(s.positionLp).to.equal(2000000000n);
  expect(s.sharePct).to.equal(50);
  expect(s.positionUsdc).to.equal(2500);
  expect(s.lockedPct).to.equal(50);
  expect(s.activeTimed.map(t=>t.address)).to.deep.equal(['A']);
  expect(s.expiredTimed).to.have.length(0); // empty escrow is not a lock
  expect(s.permanentCount).to.equal(1);
  expect(s.nextUnlockMs).to.equal(NOW+30*day*1000);
 });
 it('round-trips raw amounts',()=>{
  expect(toRaw('12.5',6)).to.equal('12500000');
  expect(fromRaw('12500000',6)).to.equal('12.5');
  expect(()=>toRaw('1.1234567',6)).to.throw('decimal');
  expect(()=>toRaw('0',6)).to.throw();
 });
});
