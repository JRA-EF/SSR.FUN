import {expect} from 'chai';
import {PublicKey} from '@solana/web3.js';
import {compareCompoundRoutes,validateCompoundQuote} from '@ssr/sdk';
import {createLiveCompoundProviders,poolAcquisition,transferGross,transferNet, type CompoundSnapshot} from '../lib/mainnet/compoundQuotes';
import {decodeLiveCompoundResponse} from '../src/merge/lib/liquidity/compoundQuoteClient';
import {LIQUIDITY_USDC} from '../src/merge/lib/liquidity/raydiumCpmm';
import {parseCompoundQuoteRequest} from '../api/mainnet/compound-quotes';
const usdc=LIQUIDITY_USDC.toBase58(), token=new PublicKey('11111111111111111111111111111112').toBase58();
const NOW=1_800_000_000_000;
function snapshot(count=1):CompoundSnapshot {
  return {context:{creator:token,reserve:token,pool:token,reserveMint:token,lpMint:token,
    budgetUsdcRaw:100_000_000n,snapshotSlot:1000,stateFingerprint:'account-hash',slippageBps:100,lpDestination:token,lockPolicyId:'unlocked'},
    readAtMs:NOW,epoch:100n,usdc:1_000_000_000n,tokens:1_000_000_000n,lpSupply:1_000_000_000n,reserveSupply:1_000_000_000n,
    mintFeeBps:50n,buyTaxBps:0,protocolRate:120_000n,fundRate:40_000n,
    reserveTransferFee:{epoch:0n,maximumFee:1_000_000_000n,transferFeeBasisPoints:15},
    assets:Array.from({length:count},(_,i)=>({mint:new PublicKey(Uint8Array.from({length:32},(_,j)=>j===31?i+20:0)).toBase58(),decimals:6,balance:1_000_000_000n/BigInt(count),transferFee:null})),
    mintAllowed:true,accountRentRaw:2_039_280n};
}
function deps(s:CompoundSnapshot,extra:any={}) {
  return {jupiterApiKey:'test-only',now:()=>NOW,prices:new Map(s.assets.map(a=>[a.mint,{usdPrice:1,blockId:1000,decimals:a.decimals}])),
    quote:async(p:any)=>({kind:'ok' as const,value:{inputMint:usdc,outputMint:p.outputMint,swapMode:'ExactOut',slippageBps:p.slippageBps,
      outAmount:p.amount.toString(),inAmount:p.amount.toString(),otherAmountThreshold:((p.amount*101n+99n)/100n).toString(),priceImpactPct:'0',contextSlot:1000,
      routePlan:[{swapInfo:{ammKey:'external-pool'}}]}}),...extra};
}
function wire(value:any):any{return JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));}
async function rejects(fn:()=>Promise<any>,message?:string){try{await fn();throw new Error('unexpected success');}catch(e){expect(String(e)).not.contain('unexpected success');if(message)expect(String(e)).contain(message);}}
describe('Live Compound quote providers (offline RPC/Jupiter fixtures)',()=>{
  it('grosses up capped, uncapped and 100% transfer fees exactly',()=>{
    for(const bps of [0,15,25,9999,10000])for(const cap of [3n,10_000n])for(const net of [1n,999n,1_000_000n]){
      const fee={epoch:0n,maximumFee:cap,transferFeeBasisPoints:bps};
      const gross=transferGross(net,fee);expect(transferNet(gross,fee)).eq(net);
      if(gross>0n)expect(transferNet(gross-1n,fee)<net).eq(true);
    }
  });
  it('mirrors native fee rounding and includes LP-retained fees in post-swap reserves',()=>{
    const s=snapshot(),q=poolAcquisition(s,100_000_000n);
    expect(q.tradeFee).eq(250_000n);expect(q.creatorFee).eq(750_000n);
    expect(q.usdc).eq(1_099_210_000n);expect(q.tokens).eq(s.tokens-q.output);
    expect(q.received).eq(transferNet(q.output,s.reserveTransferFee));
  });
  it('uses gross USDC as the optional project-tax base and taxes only the pool route',async()=>{
    const s=snapshot();s.buyTaxBps=200;
    expect(poolAcquisition(s,100_000_000n).projectTax).eq(2_000_000n);
    const p=createLiveCompoundProviders(s,deps(s));const [mint,pool]=await Promise.all([p.mint(),p.pool()]);
    expect(pool.costs.find(c=>c.kind==='projectTax')!.amountRaw>0n).eq(true);
    expect(mint.costs.some(c=>c.kind==='projectTax')).eq(false);
  });
  it('solves a balanced post-acquisition allocation instead of assuming half the budget',async()=>{
    const s=snapshot(),q=await createLiveCompoundProviders(s,deps(s)).pool();
    validateCompoundQuote(q,s.context,NOW);
    expect(q.acquisitionUsdcRaw).not.eq(s.context.budgetUsdcRaw/2n);
    const after=poolAcquisition(s,q.acquisitionUsdcRaw);
    expect(q.depositUsdcRaw*after.tokens-q.depositReserveNetRaw*after.usdc<after.tokens+after.usdc).eq(true);
    expect(q.depositReserveGrossRaw+q.leftoverReserveRaw).eq(q.acquiredReserveRaw);
    expect(q.costs.find(c=>c.kind==='transferFee')!.amountRaw>q.depositReserveGrossRaw-q.depositReserveNetRaw).eq(true);
  });
  for(const count of [1,5,10])it(`quotes real proportional requirements for a ${count}-asset basket, with bounded calls`,async()=>{
    const s=snapshot(count),base=deps(s);let calls=0;
    const quote=await createLiveCompoundProviders(s,{...base,quote:async p=>{calls++;return base.quote(p);}}).mint();
    validateCompoundQuote(quote,s.context,NOW);
    expect(calls).at.most(8*count);expect(calls).greaterThan(0);
    expect(quote.acquisitionUsdcRaw+quote.depositUsdcRaw+quote.leftoverUsdcRaw).eq(s.context.budgetUsdcRaw);
    expect(quote.costs.find(c=>c.kind==='mintFee')!.amountRaw>0n).eq(true);
  });
  it('keeps pool quotes available when prices, API access or exact-output basket routes are unavailable',async()=>{
    const s=snapshot(),d=deps(s,{prices:new Map(),jupiterApiKey:''});
    const comparison=await compareCompoundRoutes(s.context,createLiveCompoundProviders(s,d),()=>NOW);
    expect(comparison.quotes.map(q=>q.route)).deep.eq(['pool']);expect(comparison.unavailable.mint).contain('valuation');
  });
  it('does not replace unsupported ExactOut routes with a fabricated mint quote',async()=>{
    const s=snapshot();await rejects(()=>createLiveCompoundProviders(s,deps(s,{quote:async()=>({kind:'specific-error',message:'ExactOut unsupported'})})).mint(),'ExactOut unsupported');
  });
  it('rejects malformed, stale, redirected or over-budget Jupiter quote responses',async()=>{
    for(const mutate of [
      (q:any)=>q.outputMint=usdc,(q:any)=>q.outAmount='1',(q:any)=>q.contextSlot=1,
      (q:any)=>q.otherAmountThreshold='18446744073709551616',(q:any)=>q.priceImpactPct='NaN',
      (q:any)=>q.routePlan=[{swapInfo:{ammKey:token}}],(q:any)=>q.slippageBps=500,
    ]){const s=snapshot(),d=deps(s);await rejects(()=>createLiveCompoundProviders(s,{...d,quote:async p=>{const r=await d.quote(p);mutate(r.value);return r;}}).mint());}
  });
  it('expires the shared account snapshot during slow basket quotes rather than restarting its clock',async()=>{
    const s=snapshot();await rejects(()=>createLiveCompoundProviders(s,deps(s,{now:()=>NOW+26_000})).pool(),'expired');
    await rejects(()=>createLiveCompoundProviders(s,deps(s,{now:()=>NOW+21_000})).mint(),'timed out');
  });
  it('fails closed for inactive minting, fee-on-transfer backing and dust budgets',async()=>{
    const s=snapshot();s.mintAllowed=false;await rejects(()=>createLiveCompoundProviders(s,deps(s)).mint(),'unavailable');
    s.mintAllowed=true;s.assets[0].transferFee=s.reserveTransferFee;await rejects(()=>createLiveCompoundProviders(s,deps(s)).mint(),'Fee-on-transfer');
    s.context.budgetUsdcRaw=2n;await rejects(()=>createLiveCompoundProviders(s,deps(s)).pool());
  });
  it('revalues the basket with current quotes rather than a constant basket execution assumption',async()=>{
    const s=snapshot(),d=deps(s),a=await createLiveCompoundProviders(s,d).mint();
    const b=await createLiveCompoundProviders(s,{...d,quote:async p=>{const r=await d.quote(p);r.value.inAmount=(p.amount*2n).toString();r.value.otherAmountThreshold=(p.amount*202n/100n+1n).toString();return r;}}).mint();
    expect(b.expectedLpRaw<a.expectedLpRaw).eq(true);
    expect(b.costs.find(c=>c.kind==='priceImpact')!.amountRaw>0n).eq(true);
  });
  it('decodes bigint wire values and rejects changed budget/destinations or missing execution gate',async()=>{
    const s=snapshot(),comparison=await compareCompoundRoutes(s.context,createLiveCompoundProviders(s,deps(s)),()=>NOW);
    const response=wire({comparison,executionReady:false}),request={...s.context,lockPolicyId:'unlocked' as const};
    expect(decodeLiveCompoundResponse(response,request,NOW).quotes.length).eq(2);
    expect(()=>decodeLiveCompoundResponse(response,{...request,budgetUsdcRaw:1n},NOW)).throws('budget');
    expect(()=>decodeLiveCompoundResponse(response,{...request,lpDestination:usdc},NOW)).throws('destination');
    expect(()=>decodeLiveCompoundResponse({...response,executionReady:true},request,NOW)).throws();
    response.comparison.quotes[0].expectedLpRaw='-1';expect(()=>decodeLiveCompoundResponse(response,request,NOW)).throws();
  });
  it('accepts only bounded read-only requests with supported lock policy',()=>{
    const body={reserve:token,pool:token,creator:token,lpDestination:token,budgetUsdcRaw:'1000000',slippageBps:100,lockPolicyId:'unlocked'};
    expect(parseCompoundQuoteRequest(body).budgetUsdcRaw).eq(1_000_000n);
    for(const changed of [{budgetUsdcRaw:'-1'},{budgetUsdcRaw:'18446744073709551616'},{slippageBps:501},{lockPolicyId:'partial-60-percent'},{pool:'invalid'}])expect(()=>parseCompoundQuoteRequest({...body,...changed})).throws();
  });
});
