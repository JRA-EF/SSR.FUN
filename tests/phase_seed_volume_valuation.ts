import {expect} from 'chai';
import {readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {volumeEventLegs,pricingFromQuotes,valueLegsOrNull,VOLUME_EVENT_KINDS} from '../lib/reserve-activity/volumeUsd';

const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL='So11111111111111111111111111111111111111112';

describe('All-Time Volume counts the creation seed (2026-10-23)',()=>{
 it('reads the asset legs of a seed, a mint and a redemption',()=>{
  const mints=[new PublicKey(USDC),new PublicKey(WSOL)];
  expect(volumeEventLegs('reserveSeeded',{assetMints:mints,assetAmounts:[5_000_000n,1_000n]})).deep.eq({mints:[USDC,WSOL],amounts:['5000000','1000']});
  expect(volumeEventLegs('reserveTokensMinted',{assetMints:[USDC],assetAmountsIn:['2']})).deep.eq({mints:[USDC],amounts:['2']});
  expect(volumeEventLegs('reserveTokensRedeemed',{assetMints:[USDC],assetAmountsOut:['3']})).deep.eq({mints:[USDC],amounts:['3']});
  expect(volumeEventLegs('feeUsdcDistributed',{assetMints:[USDC]})).eq(null);
  expect(VOLUME_EVENT_KINDS).to.include('reserveSeeded');
 });
 it('values legs at the live price; USDC is $1; an unpriced leg counts 0',()=>{
  const pricing=pricingFromQuotes([USDC,WSOL,'Unpriced1111111111111111111111111111111111'],new Map([[WSOL,{usdPrice:150,decimals:9}],['Unpriced1111111111111111111111111111111111',{usdPrice:null,decimals:6}]]));
  expect(Object.keys(pricing).sort()).deep.eq([WSOL,USDC].sort());
  expect(valueLegsOrNull({mints:[USDC,WSOL],amounts:['10000000','100000000']},pricing)).closeTo(10+15,1e-9);
  expect(valueLegsOrNull({mints:['Unpriced1111111111111111111111111111111111',USDC],amounts:['5','1000000']},pricing)).closeTo(1,1e-9);
 });
 it('leaves a row unvalued (to retry) when no leg can be priced, never a frozen $0',()=>{
  expect(valueLegsOrNull({mints:['Unpriced1111111111111111111111111111111111'],amounts:['5']},{})).eq(null);
 });
 it('values on the Manage read and in the nightly sweep, Mainnet only',()=>{
  const route=readFileSync('lib/reserve-activity/activityRoute.ts','utf8');
  expect(route).to.match(/if \(config\.fetchPricesUsd\)[\s\S]*healMissingVolumeUsd/);
  expect(readFileSync('api/mainnet/reserve-activity.ts','utf8')).to.include('fetchPricesUsd: fetchJupiterPrices');
  expect(readFileSync('api/devnet/reserve-activity.ts','utf8')).not.to.include('fetchPricesUsd');
  expect(readFileSync('lib/reserve-activity/backfillAll.ts','utf8')).to.match(/target\.fetchPricesUsd[\s\S]*healMissingVolumeUsd/);
  // Only fills a null -- an existing valuation stays frozen (DEC-0176).
  expect(readFileSync('lib/reserve-activity/volumeUsd.ts','utf8')).to.match(/update reserve_activity_log set amount_usd[\s\S]*and amount_usd is null/);
 });
});

describe('Rebalancing is volume (DEC-0287)',()=>{
 it('decodes a rebalance swap as rebalanceVolume valued at the sold leg',()=>{
  const {summarizeActivityEvent,valueActivityEventUsd}=require('../packages/sdk/src/activityLog');
  const data={reserve:new PublicKey(USDC),mintSell:new PublicKey(WSOL),mintBuy:new PublicKey(USDC),amountIn:'2000000000',amountOut:'300000000',minOut:'1',executedBy:new PublicKey(WSOL),ts:1};
  const s=summarizeActivityEvent('rebalanceSwapExecuted',data);
  expect(s.amountKind).eq('rebalanceVolume');
  expect(s.amountRaw).eq('2000000000');
  expect(s.actor).eq(WSOL);
  const usd=valueActivityEventUsd('rebalanceSwapExecuted',data,{pricing:{[WSOL]:{decimals:9,priceUsd:150}},navUsdPerRtRawUnit:null});
  expect(usd.amountUsd).closeTo(300,1e-9);
  expect(volumeEventLegs('rebalanceSwapExecuted',data)).deep.eq({mints:[WSOL],amounts:['2000000000']});
  expect(VOLUME_EVENT_KINDS).to.include('rebalanceSwapExecuted');
 });
 it('counts rebalance volume in all-time, 24h and campaign volume',()=>{
  expect(readFileSync('lib/reserve-activity/kpis.ts','utf8').match(/'mintVolume', 'redeemVolume', 'rebalanceVolume'/g)?.length).eq(2);
  expect(readFileSync('packages/sdk/src/readOnly.ts','utf8')).to.include('event.name === "rebalanceSwapExecuted"');
  expect(readFileSync('lib/campaign/rules.ts','utf8')).to.match(/CAMPAIGN_VOLUME_KINDS = \[[^\]]*'rebalanceSwapExecuted'/);
  expect(readFileSync('lib/campaign/leaderboard.ts','utf8')).to.include('kind = ANY(${VOLUME_KINDS})');
 });
});
