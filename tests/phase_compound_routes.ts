import { expect } from 'chai';
import { compareCompoundRoutes, approveCompoundRoute, assertCompoundApproval, validateCompoundQuote,
  type CompoundContext, type CompoundQuote, type CompoundRoute, type CompoundCostKind } from '../packages/sdk/src/compoundRoutes';
const NOW = 1_000_000;
const context: CompoundContext = {creator:'creator',reserve:'reserve',pool:'pool',reserveMint:'reserve-mint',
  lpMint:'lp',budgetUsdcRaw:100_000_000n,snapshotSlot:123,stateFingerprint:'account-snapshot',slippageBps:100,
  lpDestination:'creator-lp-account',lockPolicyId:'unlocked-tranche'};
function quote(route: CompoundRoute, lp=1000n): CompoundQuote {
 const kinds: CompoundCostKind[] = route === 'mint' ? ['mintFee','basketExecution','transferFee','priceImpact','networkFee','accountRent'] : ['poolTradeFee','projectTax','transferFee','priceImpact','networkFee','accountRent'];
 return {id:route+'-id',route,context:{...context},quotedAtMs:NOW,expiresAtMs:NOW+20_000,
  planFingerprint:route+'-instructions',acquisitionUsdcRaw:53_000_000n,depositUsdcRaw:46_000_000n,
  leftoverUsdcRaw:1_000_000n,acquiredReserveRaw:51_000_000n,depositReserveGrossRaw:50_000_000n,
  depositReserveNetRaw:49_925_000n,leftoverReserveRaw:1_000_000n,expectedLpRaw:lp,minimumLpRaw:lp*99n/100n,
  maximumSolCostRaw:10000n,costs:kinds.map(kind=>({kind,unit:kind==='networkFee'||kind==='accountRent'?'SOL':'USDC',amountRaw:0n}))};
}
const providers=(mint=quote('mint'),pool=quote('pool',1100n))=>({mint:async()=>mint,pool:async()=>pool});
async function compare(mint=quote('mint'),pool=quote('pool',1100n)) {return compareCompoundRoutes(context,providers(mint,pool),()=>NOW);}
describe('Compound route comparison and creator approval',()=>{
 it('requests both live providers with exactly the same budget and snapshot; permits a non-half allocation',async()=>{
  const seen:unknown[]=[];
  const result=await compareCompoundRoutes(context,{mint:async c=>{seen.push(c);return quote('mint');},pool:async c=>{seen.push(c);return quote('pool',1100n);}},()=>NOW);
  expect(seen[0]).eq(seen[1]);expect(result.quotes).length(2);expect(result.recommended).eq('pool');
  expect(result.quotes[0].acquisitionUsdcRaw).eq(53_000_000n);
 });
 it('suggests the highest protected LP output rather than the biggest headline token amount',async()=>{
  const mint=quote('mint',1200n);mint.acquiredReserveRaw=51_000_001n;mint.leftoverReserveRaw++;
  const result=await compare(mint,quote('pool',1100n));expect(result.recommended).eq('mint');
 });
 it('keeps one route available if the other cannot obtain a complete quote; never invents a fallback',async()=>{
  const result=await compareCompoundRoutes(context,{mint:async()=>{throw new Error('No constituent route');},pool:async()=>quote('pool')},()=>NOW);
  expect(result.quotes).length(1);expect(result.unavailable.mint).eq('No constituent route');
  expect(()=>approveCompoundRoute(result,'mint','creator',NOW)).throws('unavailable');
 });
 it('returns no suggestion or spendable route when both quotes fail',async()=>{
  const broken=async()=>{throw new Error('Quote unavailable');};
  const result=await compareCompoundRoutes(context,{mint:broken,pool:broken},()=>NOW);
  expect(result.quotes).length(0);expect(result.recommended).eq(null);
 });
 it('rechecks freshness after both provider calls finish',async()=>{
  const result=await compareCompoundRoutes(context,providers(),()=>NOW+20_000);
  expect(result.quotes).length(0);expect(result.unavailable.mint).include('expired');
 });
 it('rejects incomplete fees, invented balanced budgets, wrong destinations, and unprotected liquidity',()=>{
  const mutations:((q:CompoundQuote)=>void)[]=[
   q=>{q.costs=q.costs.filter(c=>c.kind!=='transferFee');}, q=>{q.leftoverUsdcRaw++;},
   q=>{q.depositReserveGrossRaw++;},q=>{q.context.pool='other';},q=>{q.context.lpDestination='service';},
   q=>{q.minimumLpRaw=1n;},q=>{q.depositReserveNetRaw=q.depositReserveGrossRaw+1n;},
   q=>{q.maximumSolCostRaw=-1n;},q=>{q.expiresAtMs=NOW+60_000;},q=>{q.quotedAtMs=NOW+1;},
  ];
  for(const mutate of mutations){const q=quote('mint');mutate(q);expect(()=>validateCompoundQuote(q,context,NOW)).throws();}
 });
 it('rejects mismatched strategy responses from providers',async()=>{
  const result=await compareCompoundRoutes(context,{mint:async()=>quote('pool'),pool:async()=>quote('mint')},()=>NOW);
  expect(result.quotes).length(0);
 });
 it('requires explicit creator approval of the selected route, not the suggestion',async()=>{
  const result=await compare();const selected=result.quotes.find(q=>q.route==='mint')!;
  expect(result.recommended).eq('pool');
  expect(()=>approveCompoundRoute(result,'mint','intruder',NOW)).throws('creator');
  const approval=approveCompoundRoute(result,'mint','creator',NOW);
  expect(()=>assertCompoundApproval(selected,approval,context,'creator',NOW)).not.throws();
  expect(()=>assertCompoundApproval(result.quotes[1],approval,context,'creator',NOW)).throws('again');
 });
 it('binds approval to amounts, costs, lock policy, custody destination and account state',async()=>{
  const result=await compare();const original=result.quotes[0];const approval=approveCompoundRoute(result,'mint','creator',NOW);
  const mutations:((q:CompoundQuote)=>void)[]=[q=>{q.planFingerprint='new-plan';},q=>{q.expectedLpRaw++;},
   q=>{q.maximumSolCostRaw++;},q=>{q.costs=[...q.costs,{kind:'accountRent',unit:'SOL',amountRaw:1n}];},
   q=>{q.context.lockPolicyId='permanent';},q=>{q.context.lpDestination='service';},q=>{q.context.stateFingerprint='new-state';}];
  for(const mutate of mutations){const changed={...original,context:{...original.context},costs:original.costs.map(c=>({...c}))};mutate(changed);expect(()=>assertCompoundApproval(changed,approval,context,'creator',NOW)).throws();}
  expect(()=>assertCompoundApproval(original,approval,context,'other',NOW)).throws('wallet');
  expect(()=>assertCompoundApproval(original,approval,context,'creator',NOW+20_000)).throws('expired');
 });
 it('copies and freezes provider data so later mutation cannot change a reviewed plan',async()=>{
  const mint=quote('mint');const result=await compare(mint);const before=result.quotes[0].expectedLpRaw;
  mint.expectedLpRaw=9999n;mint.context.pool='other';(mint.costs[0] as {amountRaw:bigint}).amountRaw=100n;
  expect(result.quotes[0].expectedLpRaw).eq(before);expect(result.quotes[0].context.pool).eq('pool');
  expect(result.quotes[0].costs[0].amountRaw).eq(0n);
 });
});
