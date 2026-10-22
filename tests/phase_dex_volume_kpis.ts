import {expect} from 'chai';
import {readFileSync} from 'node:fs';
import {classifyPoolSwap,poolReserves,POOL,POOL_STATE_SIZE,LIQUIDITY_REVENUE_SIZE} from '../lib/dex-volume/classify';
import {splitMarketCap,combinedAllTimeVolume} from '../src/merge/lib/protocolKpis';

describe('DEC-0254: DEX volume and pool-aware market cap',()=>{
 it('counts a swap (vaults move in opposite directions) by its USDC leg, in either direction',()=>{
  // LIQUID 2026-10-21 09:57: a wallet sold 0.137544 LIQUID; the pool paid out 1.236804 USDC.
  expect(classifyPoolSwap(34_876_447n,33_639_643n,3_765_204n,3_902_541n)).deep.eq({side:'out',usdcRaw:1_236_804n,tokenRaw:137_337n});
  expect(classifyPoolSwap(10_000_000n,12_000_000n,5_000_000n,4_100_000n)).deep.eq({side:'in',usdcRaw:2_000_000n,tokenRaw:900_000n});
 });
 it('ignores deposits, withdrawals and fee collections',()=>{
  expect(classifyPoolSwap(14_976_451n,34_876_447n,1_638_205n,3_880_562n)).eq(null); // the 09:51 add: both up
  expect(classifyPoolSwap(34_705_440n,14_914_579n,3_902_541n,1_647_509n)).eq(null); // the 10:04 withdraw: both down
  expect(classifyPoolSwap(1_000n,900n,500n,500n)).eq(null); // creator fee collected: USDC only
  expect(classifyPoolSwap(1_000n,1_000n,500n,500n)).eq(null);
 });
 it('takes accrued Raydium, fund and creator fees out of the pool reserves',()=>{
  const state=new Uint8Array(POOL_STATE_SIZE),view=new DataView(state.buffer);
  view.setBigUint64(POOL.protocolFee0,10n,true);view.setBigUint64(POOL.fundFee0,5n,true);view.setBigUint64(POOL.creatorFee0,100n,true);
  view.setBigUint64(POOL.protocolFee0+8,1n,true);
  expect(poolReserves(state,1_115n,51n)).deep.eq([1_000n,50n]);
  expect(poolReserves(state,50n,0n)).deep.eq([0n,0n]);
 });
 it('values tokens outside the pool at NAV and pooled tokens at the pool price, never twice',()=>{
  // 23.05 supply at NAV 1.06; 1.65 in a pool holding 14.91 USDC (~$9.05 each).
  const cap=splitMarketCap('23053116',1.06,{pooledTokensRaw:'1647509',poolUsdcRaw:'14914579'});
  expect(cap.navCapUsd).closeTo((23.053116-1.647509)*1.06,1e-9);expect(cap.poolCapUsd).closeTo(14.914579,1e-9);
  expect(splitMarketCap('23053116',1.06,undefined)).deep.eq({navCapUsd:23.053116*1.06,poolCapUsd:0});
  // A pool cannot hold more than the supply; no negative outside part.
  expect(splitMarketCap('100',2,{pooledTokensRaw:'500',poolUsdcRaw:'1000000'}).navCapUsd).eq(0);
  expect(splitMarketCap('1000000',0,undefined).navCapUsd).eq(0);
 });
 it('the homepage adds DEX volume to mint/redeem volume, and stays honest when either read fails',()=>{
  expect(combinedAllTimeVolume(100,25)).eq(125);expect(combinedAllTimeVolume(100,null)).eq(100);expect(combinedAllTimeVolume(null,25)).eq(null);
 });
 it('keeps DEX volume separate in every backend figure and indexes it once a day',()=>{
  expect(LIQUIDITY_REVENUE_SIZE).eq(133);
  const stats=readFileSync('api/mainnet/landing-stats.ts','utf8');
  expect(stats).contain('dexVolumeAllTimeUsd, pools');expect(stats).not.contain('volumeAllTimeUsd + ');
  const kpis=readFileSync('lib/reserve-activity/kpis.ts','utf8');
  expect(kpis).contain('totalDexVolumeUsd,');expect(kpis).contain("k in ('mintVolume', 'redeemVolume')");
  const cron=JSON.parse(readFileSync('vercel.json','utf8')).crons.find((c:{path:string})=>c.path==='/api/kpis/dex-volume-cron');
  expect(cron?.schedule).eq('30 3 * * *');
  const home=readFileSync('src/pages/Home.tsx','utf8');
  expect(home).contain('combinedAllTimeVolume(');expect(home).contain('splitMarketCap(');
 });
});
