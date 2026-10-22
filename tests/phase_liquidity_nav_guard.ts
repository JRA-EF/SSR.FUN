import {expect} from 'chai';
import {readFileSync} from 'node:fs';
import {NAV_DEVIATION_LIMIT_PCT,navDeviation} from '../src/merge/lib/liquidity/liveLiquidityClient';

describe('Add liquidity warns when the pool is away from backing value',()=>{
 it('stays quiet within 1% of NAV and when no price is known',()=>{
  expect(NAV_DEVIATION_LIMIT_PCT).eq(1);
  expect(navDeviation(null)).eq(null);expect(navDeviation(Number.NaN)).eq(null);
  expect(navDeviation(0)).eq(null);expect(navDeviation(1)).eq(null);expect(navDeviation(-1)).eq(null);
 });
 it('reports direction and size beyond 1%',()=>{
  expect(navDeviation(1.01)).deep.eq({direction:'above',pct:1.01});
  expect(navDeviation(-2.5)).deep.eq({direction:'below',pct:2.5});
  // LIQUID on 2026-10-21: pool ~$8.89 against ~$1.06 backing.
  expect(navDeviation(((8.89-1.06)/1.06)*100)?.direction).eq('above');
 });
 it('blocks both the review and the mint step until the creator acknowledges the gap',()=>{
  const src=readFileSync('src/merge/components/LiveLiquidityActions.tsx','utf8');
  expect(src).contain('navDeviation(summary.premiumPct)');
  expect(src).contain('blocked=deviation!==null&&!accepted');
  expect(src).contain('<LiquidityMintStep dtr={dtr} state={state} plan={mint} disabled={busy||blocked}');
  expect(src).contain('<Button disabled={busy||blocked||!usdc||mint.mintRaw>0n}');
 });
});
