import {expect} from 'chai';
import {readFileSync} from 'node:fs';

// 2026-10-21 live test: the mint confirmed and the add review was prepared, but it was never approved.
// The mint box disappears once the treasury holds enough, so nothing said the review was the one step left.
describe('After minting the missing tokens, the liquidity review is clearly the one step left',()=>{
 const step=readFileSync('src/merge/components/LiquidityMintStep.tsx','utf8');
 const forms=readFileSync('src/merge/components/LiveLiquidityActions.tsx','utf8');
 const section=readFileSync('src/merge/components/LiveLiquiditySection.tsx','utf8');
 it('the mint step hands its amount and signature to the form',()=>{
  expect(step).contain('onMinted:(minted:MintedHandoff)=>void');
  expect(step).contain('onMinted({amount,signature:signature??null})');
 });
 it('both the launch and the add form pass it on to the review, and a plain click passes nothing',()=>{
  expect(forms.match(/onMinted=\{m=>void refresh\(\)\.then\(\(\)=>submit\(m\)\)\}/g)?.length).eq(2);
  expect(forms.match(/lock\},minted\);/g)?.length).eq(2);
  // In the two forms whose submit takes a mint, onClick={submit} would hand it the click event as if it were one.
  expect(forms.match(/mint\.mintRaw>0n\} onClick=\{\(\)=>submit\(\)\}/g)?.length).eq(2);
  expect(forms).not.match(/mint\.mintRaw>0n\} onClick=\{submit\}/);
 });
 it('the section keeps a notice naming the confirmation word above the review, and says the tokens are safe if preparing fails',()=>{
  expect(section).contain('One step left: type ${result.confirmationText} in the review below');
  expect(section).contain("toast({title:'Mint confirmed. One step left'");
  expect(section).contain('was minted and is in the treasury, but the liquidity review could not be prepared');
  expect(section.match(/onPrepare=\{\(a,x,m\)=>void prepare\(a,x,m\)\}/g)?.length).eq(2);
 });
 it('closing the review also clears the hand-off notice',()=>{
  expect(section).contain('setPrepared(null);setNotice(null);void load();');
 });
});
