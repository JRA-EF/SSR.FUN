// 2026-10-23: a launch starts at NAV $1.00 and seeds held assets at full value.
// SSRES (HZMn...eTCo) committed $500 (100 USDC + $400 of $SSR the creator
// already held). The held $SSR was sized at the BUY quote and the 5% shortfall
// tolerance skipped the top-up, so it seeded 731,621.63 $SSR worth $369.73 and
// minted 500 tokens against $469.73 -> NAV $0.939.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_launch_nav_parity.ts
import {expect} from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import {initialTokensForSeedValue} from '../lib/mainnet/buildSeed';
import {midPriceTargetRaw} from '../src/merge/lib/createReserveClient';

const read=(p:string)=>fs.readFileSync(path.resolve(__dirname,'..',p),'utf8');

describe('Seed mints one Reserve Token per dollar actually deposited',()=>{
 it('SSRES: $469.47 deposited -> 469.47 tokens, not the 500 committed',()=>{
  expect(initialTokensForSeedValue(469_470_000n,500_000_000n)).to.equal(469_470_000n);
 });
 it('a basket worth more than committed mints more, still at $1.00',()=>{
  expect(initialTokensForSeedValue(512_000_000n,500_000_000n)).to.equal(512_000_000n);
 });
 it('keeps the committed figure when the value looks like a broken price (over 2x off) or is missing',()=>{
  expect(initialTokensForSeedValue(200_000_000n,500_000_000n)).to.equal(500_000_000n);
  expect(initialTokensForSeedValue(1_100_000_000n,500_000_000n)).to.equal(500_000_000n);
  expect(initialTokensForSeedValue(0n,500_000_000n)).to.equal(500_000_000n);
 });
 it('the server, not the browser, decides the count, and returns it',()=>{
  const src=read('lib/mainnet/buildSeed.ts');
  expect(src).to.include('initialTokensForSeedValue(depositValueUsdcRaw, input.initialReserveTokens)');
  expect(src).to.include('initialReserveTokens: initialReserveTokens.toString()');
 });
});

describe('Held assets are seeded at their full mid-price value',()=>{
 it('SSRES: $400 at the $0.00050536 mid is 791,523 $SSR (the buy quote gave 731,621-768,407)',()=>{
  const raw=midPriceTargetRaw(400_000_000n,0.00050536,6);
  expect(Number(raw)/1e6).to.be.closeTo(400/0.00050536,0.01);
 });
 it('is 0 (use the buy quote) when the price is unknown',()=>{
  expect(midPriceTargetRaw(400_000_000n,null,6)).to.equal(0n);
  expect(midPriceTargetRaw(400_000_000n,0,6)).to.equal(0n);
  expect(midPriceTargetRaw(400_000_000n,Number.NaN,6)).to.equal(0n);
 });
 it('handles high-priced, high-decimal assets without overflow or precision loss',()=>{
  // $250 of an 8-decimal asset at $65,000.
  expect(midPriceTargetRaw(250_000_000n,65_000,8)).to.equal(384_615n);
 });
 it('only tops up the gap of an asset the creator already held; tolerance stays for assets this launch bought',()=>{
  const src=read('src/merge/lib/createReserveClient.ts');
  expect(src).to.include('if (balances[i] > 0n && jupiterSwap.midPriceUsd)');
  expect(src).to.include('(boughtByThisLaunch && isWithinAcceptableShortfallTolerance(existingRaw, targetRaw, SHORTFALL_WARN_PCT))');
  const page=read('src/merge/pages/CreateDTR.tsx');
  expect(page.match(/midPriceUsd: fetchMidPriceUsd/g)?.length,'launch and Resume both pass the price').to.equal(2);
 });
});
