/**
 * DEC-0251: the creator's fee terms for a new pool, chosen once in the
 * liquidity launch (Manage Reserve -> Liquidity) and fixed on-chain when the
 * pool is created: the optional project Buy/Sell tax (the same 0-2% sliders
 * Create Reserve had before DEC-0229) and the optional holder share of the
 * creator's 80% that is fed back into the Reserve's backing over 24 hours.
 * Secondary-market (DEX) trades only -- never a mint or a redemption.
 */
import {AlertCircle} from 'lucide-react';
import {formatUsdc} from '@/lib/calculations';
import {EXAMPLE_TRADE_USD as EXAMPLE_USD,exampleSplit,type FeeTermsValue} from '../lib/liquidity/feeTerms';
import {Label} from './ui/label';
import {Slider} from './ui/slider';

const pct=(n:number)=>`${n.toFixed(2)}%`;
const choice=(active:boolean)=>`text-left rounded-lg border p-3 transition-colors ${active?'border-primary/50 bg-primary/10':'border-border hover:bg-muted'}`;

function TaxSlider({id,label,value,onChange,disabled,note}:{id:string;label:string;value:number;onChange:(v:number)=>void;disabled?:boolean;note:string}){
 return <div className="space-y-3">
  <Label htmlFor={id} className="flex justify-between"><span>{label}</span><span className="font-merge-mono text-primary">{pct(value)}</span></Label>
  <Slider id={id} value={[value]} max={2} step={0.05} disabled={disabled} onValueChange={v=>onChange(v[0])}/>
  <p className="text-xs text-muted-foreground">{note}</p>
 </div>;
}

export function LiquidityFeeTerms({value,onChange,disabled}:{value:FeeTermsValue;onChange:(v:FeeTermsValue)=>void;disabled?:boolean}){
 const set=(patch:Partial<FeeTermsValue>)=>onChange({...value,...patch});
 const onBuys=exampleSplit(value.buyTaxPct,value),onSells=exampleSplit(value.sellTaxPct,value);
 const cell=(n:number)=><td className="py-1.5 text-right font-merge-mono">{formatUsdc(n)}</td>;
 return <div className="space-y-5">
  <div className="space-y-1">
   <Label className="text-xs uppercase tracking-wider text-muted-foreground">Your pool earnings</Label>
   <p className="text-xs text-muted-foreground">You earn the pool's 0.75% creator fee (Raydium keeps 5% of it) plus any tax you set below. SSR takes 20% of what you earn; the other 80% is yours.</p>
  </div>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
   {/* DEC-0240/0251: secondary-market (DEX) project tax only -- never on a mint or redemption. */}
   <TaxSlider id="liquidity-buy-tax" label="Buy tax" value={value.buyTaxPct} disabled={disabled} onChange={v=>set({buyTaxPct:v})}
    note="Charged on DEX trades into your Reserve Token routed through SSR. Default 0%."/>
   <TaxSlider id="liquidity-sell-tax" label="Sell tax" value={value.sellTaxPct} disabled={disabled} onChange={v=>set({sellTaxPct:v})}
    note="Charged on DEX trades out of your Reserve Token routed through SSR. Default 0%."/>
  </div>

  <div className="space-y-2">
   <Label className="text-xs uppercase tracking-wider text-muted-foreground">Feed earnings back into the Reserve?</Label>
   <div role="radiogroup" aria-label="Feed earnings back into the Reserve" className="grid grid-cols-1 md:grid-cols-2 gap-3">
    <button type="button" role="radio" aria-checked={!value.shareWithHolders} disabled={disabled} onClick={()=>set({shareWithHolders:false})} className={choice(!value.shareWithHolders)}>
     <p className="text-sm font-medium">No, I keep my 80%</p>
     <p className="text-xs text-muted-foreground mt-1">All of your share goes to your creator treasury.</p>
    </button>
    <button type="button" role="radio" aria-checked={value.shareWithHolders} disabled={disabled} onClick={()=>set({shareWithHolders:true})} className={choice(value.shareWithHolders)}>
     <p className="text-sm font-medium">Yes, share part of it with holders</p>
     <p className="text-xs text-muted-foreground mt-1">That part is added to the Reserve's backing over 24 hours, so every Reserve Token is backed by a little more.</p>
    </button>
   </div>
   {value.shareWithHolders&&<div className="space-y-3 pt-2">
    <Label htmlFor="liquidity-holder-share" className="flex justify-between"><span>Share of your 80% for holders</span><span className="font-merge-mono text-primary">{value.holderSharePct.toFixed(0)}%</span></Label>
    <Slider id="liquidity-holder-share" value={[value.holderSharePct]} min={5} max={100} step={5} disabled={disabled} onValueChange={v=>set({holderSharePct:v[0]})}/>
    <p className="text-xs text-muted-foreground">SSR swaps this USDC into the Reserve's assets at their target weights and adds them to the vaults, a little every hour. No new tokens are created, so the backing per token grows.</p>
   </div>}
  </div>

  <div className="rounded-lg border border-border p-3">
   <p className="text-xs text-muted-foreground mb-2">Example: what one {formatUsdc(EXAMPLE_USD)} trade earns</p>
   <table className="w-full text-sm">
    <thead><tr className="text-xs text-muted-foreground"><th className="text-left font-normal"></th><th className="text-right font-normal">Into {pct(value.buyTaxPct)} tax</th><th className="text-right font-normal">Out of {pct(value.sellTaxPct)} tax</th></tr></thead>
    <tbody>
     <tr><td className="py-1.5">You</td>{cell(onBuys.creator)}{cell(onSells.creator)}</tr>
     {value.shareWithHolders&&<tr><td className="py-1.5">Holders' backing</td>{cell(onBuys.holders)}{cell(onSells.holders)}</tr>}
     <tr><td className="py-1.5">SSR</td>{cell(onBuys.ssr)}{cell(onSells.ssr)}</tr>
    </tbody>
   </table>
   <p className="text-xs text-muted-foreground mt-2">Taxes apply only to trades routed through SSR. Every trade on any venue also pays the 0.15% Reserve Token transfer fee to SSR, and the pool's 0.25% trading fee goes to liquidity providers.</p>
  </div>

  <div className="bg-primary/10 text-foreground p-3 rounded text-sm flex items-start gap-2">
   <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-primary"/>
   <span>These terms are permanent once the pool launches: the taxes, and whether and how much you share with holders, can never be changed.</span>
  </div>
 </div>;
}
