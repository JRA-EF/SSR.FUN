import {expect} from 'chai';
import {readFileSync} from 'node:fs';
import {launchTokensNeededRaw,mintShortfallRaw,mintUsdcEstimate,planLiquidityMint} from '../src/merge/lib/liquidity/liquidityMintPlan';

describe('Mint missing Reserve Tokens before adding liquidity',()=>{
 it('sizes a launch at NAV including the 0.15% transfer fee',()=>{
  // 9.6 USDC at NAV 0.98 = 9.795918.. tokens, plus 0.15% = 9.81061.. (6 decimals, rounded up).
  expect(launchTokensNeededRaw(9.6,0.98,6)).eq(9810613n);
  expect(launchTokensNeededRaw(0,0.98,6)).eq(0n);expect(launchTokensNeededRaw(10,0,6)).eq(0n);
 });
 it('mints nothing when the treasury already holds enough, and only the shortfall plus 2% headroom otherwise',()=>{
  expect(mintShortfallRaw(5_000_000n,5_000_000n)).eq(0n);expect(mintShortfallRaw(5_000_000n,9_000_000n)).eq(0n);
  // LIQUIDITY's case: 10 tokens held, a 500 USDC launch at NAV 0.98 needs ~510.97; mint covers the gap with headroom.
  const needed=launchTokensNeededRaw(500,0.98,6),mint=mintShortfallRaw(needed,10_000_000n);
  expect(mint+10_000_000n).gte(needed*102n/100n);expect(mint+10_000_000n).lt(needed*102n/100n+2n);
 });
 it('estimates the mint USDC with the mint fee and swap buffer, and flags a USDC shortfall',()=>{
  expect(mintUsdcEstimate(100_000_000n,6,1,50)).closeTo(102.5,1e-9);expect(mintUsdcEstimate(0n,6,1,50)).eq(0);
  const enough=planLiquidityMint({neededRaw:launchTokensNeededRaw(500,1,6),heldRaw:10_000_000n,usdcSide:500,usdcHeld:2000,decimals:6,nav:1,mintFeeBps:50});
  expect(enough.mintRaw>0n).eq(true);expect(enough.totalUsdc).closeTo(500+enough.mintUsdc,1e-9);expect(enough.usdcShort).eq(false);
  expect(planLiquidityMint({neededRaw:launchTokensNeededRaw(500,1,6),heldRaw:10_000_000n,usdcSide:500,usdcHeld:600,decimals:6,nav:1,mintFeeBps:50}).usdcShort).eq(true);
  expect(planLiquidityMint({neededRaw:1_000_000n,heldRaw:5_000_000n,usdcSide:1,usdcHeld:0.5,decimals:6,nav:1,mintFeeBps:0})).deep.include({mintRaw:0n,mintUsdc:0});
 });
 it('reuses the normal Mint path and only offers it to the treasury wallet',()=>{
  const src=readFileSync('src/merge/components/LiquidityMintStep.tsx','utf8');
  expect(src).contain('executeMultiAssetBuyMainnet(');expect(src).contain('wallet.publicKey?.toBase58()===state.treasury');
  // DEC-0228: the in-app flow is "mint", never buy/sell/purchase, in visible copy.
  expect(src).not.match(/(>|'|`)[^<'`]*\b(Buy|buy|Sell|sell|purchase)\b/);
  const forms=readFileSync('src/merge/components/LiveLiquidityActions.tsx','utf8');
  expect(forms.match(/<LiquidityMintStep /g)?.length).eq(2);expect(forms).contain('mint.mintRaw>0n');
 });
});
