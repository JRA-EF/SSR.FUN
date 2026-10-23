// 2026-10-23 liquidity UI pass: live trust badges on the Reserve page, the
// fresh-Reserve hint in the pool launch, and readable button-links.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_liquidity_ui_polish.ts
import {expect} from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import {FRESH_RESERVE_HINT,launchErrorText,livePoolBadgeSource,type LiveLiquidityState} from '../src/merge/lib/liquidity/liveLiquidityClient';

const ROOT=path.resolve(__dirname,'..');
const read=(p:string)=>fs.readFileSync(path.join(ROOT,p),'utf8');
const NOW=Date.UTC(2026,9,23,14);
function state(over:Partial<LiveLiquidityState>={}):LiveLiquidityState{
 return {reserve:'R',creator:'C',treasury:'T',pool:'P',hasPool:true,paused:false,executionEnabled:true,reserveDecimals:6,lpDecimals:9,
  usdcBalanceRaw:'0',reserveBalanceRaw:'0',lpBalanceRaw:'0',nativeEarningsUsdcRaw:'0',stagedEarningsUsdcRaw:'0',
  // SSRES pool on 2026-10-23: 252.67421 USDC + 261.792066 SSRES.
  poolUsdcRaw:'252674210',poolReserveRaw:'261792066',lpSupplyRaw:'257148247',tranches:[],...over};
}
const tranche=(lpRaw:string,unlockMs:number,permanent=false,withdrawn=false)=>({address:'L'+lpRaw,unlockTs:String(Math.floor(unlockMs/1000)),permanent,withdrawn,lpRaw});

describe('Live liquidity trust badges (DEC-0218)',()=>{
 it('shows nothing while the Reserve has no pool',()=>{
  expect(livePoolBadgeSource(state({hasPool:false}),NOW)).to.equal(null);
 });
 it('carries the real pool address and both sides of the pool',()=>{
  const pool=livePoolBadgeSource(state({lpBalanceRaw:'1000'}),NOW)!;
  expect(pool.poolAddress).to.equal('P');
  expect(pool.quoteUsd).to.be.closeTo(252.67421,1e-9);
  expect(pool.baseTokens).to.be.closeTo(261.792066,1e-9);
 });
 it('reads as unlocked whenever the creator treasury can withdraw LP now',()=>{
  expect(livePoolBadgeSource(state({lpBalanceRaw:'1000'}),NOW)!.lock.mode).to.equal('none');
  const expired=state({tranches:[tranche('257148147',NOW-1000)]});
  expect(livePoolBadgeSource(expired,NOW)!.lock.mode,'an expired lock is withdrawable').to.equal('none');
 });
 it('reads as locked until the earliest active timed lock ends',()=>{
  const s=state({tranches:[tranche('200',NOW+90*86_400_000),tranche('257147947',NOW+30*86_400_000)]});
  const lock=livePoolBadgeSource(s,NOW)!.lock;
  expect(lock.mode).to.equal('timed');
  expect(lock.unlockTs).to.equal(Math.floor((NOW+30*86_400_000)/1000)*1000);
 });
 it('reads as locked forever only when nothing is withdrawable or time-locked',()=>{
  const s=state({tranches:[tranche('0',0,true)]});
  expect(livePoolBadgeSource(s,NOW)!.lock.mode).to.equal('permanent');
  const withdrawn=state({tranches:[tranche('0',0,true,true)]});
  expect(livePoolBadgeSource(withdrawn,NOW)!.lock.mode).to.equal('none');
 });
 it('renders on the Reserve page from the live read, for every viewer',()=>{
  const page=read('src/merge/pages/DTRDetail.tsx');
  expect(page).to.include('<ReserveLiquidityBadges dtr={dtr}');
  const module=read('src/merge/components/LiquidityModule.tsx');
  expect(module).to.include('livePoolBadgeSource(liveState)');
  expect(module,'banner and badges share one read').to.include('readLivePool(reserve)');
 });
});

describe('Pool launch on a freshly created Reserve',()=>{
 it('asks the creator to wait 2-3 minutes before showing the raw error',()=>{
  expect(FRESH_RESERVE_HINT).to.match(/wait 2-3 minutes/);
  expect(launchErrorText('Reserve NAV is unavailable')).to.equal(`${FRESH_RESERVE_HINT} Details: Reserve NAV is unavailable`);
  expect(launchErrorText('A seeded Token-2022 Reserve without an active transfer hook is required')).to.include(FRESH_RESERVE_HINT);
 });
 it('does not tell the creator to wait when the fix is theirs',()=>{
  for(const m of ['Creator treasury has insufficient USDC','Connect the creator wallet to prepare pool creation','Pool launch SOL cost exceeds your cap','Pool already exists or the protocol is paused'])
   expect(launchErrorText(m),m).to.equal(m);
 });
 it('shows the hint, not the raw error, when the pool state cannot be read',()=>{
  const section=read('src/merge/components/LiveLiquiditySection.tsx');
  expect(section).to.include("Liquidity isn't ready for this Reserve yet.");
  expect(section).to.include('{FRESH_RESERVE_HINT}');
 });
});

describe('Button-shaped links stay readable',()=>{
 it('keeps the global link colour in the base layer so button text utilities win',()=>{
  const css=read('src/index.css');
  const layered=css.match(/@layer base \{\s*a \{\s*color: var\(--accent-ink\);/);
  expect(layered,'a { color } must sit inside @layer base').to.not.equal(null);
  expect(css.replace(/@layer base \{[\s\S]*?\n\}/g,''),'no unlayered a { color } left').to.not.match(/(^|\n)a \{\s*color:/);
 });
});
