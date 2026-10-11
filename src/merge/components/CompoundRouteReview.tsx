import { useEffect, useState } from 'react';
import { approveCompoundRoute, assertCompoundApproval,
  type CompoundApproval, type CompoundComparison, type CompoundCostKind,
  type CompoundQuote, type CompoundRoute } from '@ssr/sdk';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const LABELS: Record<CompoundCostKind,string> = {
  mintFee:'Mint fee', basketExecution:'Basket slippage allowance', poolTradeFee:'Pool trading fee',
  projectTax:'Project tax', transferFee:'Token transfer fees', priceImpact:'Execution price impact / premium',
  networkFee:'Network allowance', accountRent:'Account setup allowance',
};
function units(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return 'Unavailable';
  const digits = raw.toString().padStart(decimals + 1,'0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/,'');
  return digits.slice(0,-decimals) + (fraction ? `.${fraction}` : '');
}
export function CompoundRouteReview({comparison,connectedCreator,reserveSymbol,reserveDecimals,lpDecimals,
  onApprove,onRefresh,refreshing=false}: {
  comparison: CompoundComparison | null;
  connectedCreator: string | null;
  reserveSymbol: string;
  reserveDecimals: number;
  lpDecimals: number;
  onApprove?: (approval: CompoundApproval, quote: CompoundQuote) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [selected,setSelected] = useState<CompoundApproval|null>(null);
  const [now,setNow] = useState(Date.now);
  const [error,setError] = useState<string|null>(null);
  useEffect(() => {
    if (!comparison) return;
    const timer = setInterval(() => setNow(Date.now()),1000);
    return () => clearInterval(timer);
  },[comparison]);
  const available = (route: CompoundRoute) => {
    if (!comparison || !connectedCreator || refreshing) return null;
    try { return approveCompoundRoute(comparison,route,connectedCreator,now); } catch { return null; }
  };
  const chosen = comparison?.quotes.find(q => q.route === selected?.route);
  const current = selected && chosen ? available(chosen.route) : null;
  const selectionValid = !!(current && current.quoteBinding === selected?.quoteBinding);
  const approve = () => {
    if (!comparison || !selected || !chosen || !connectedCreator || !onApprove) return;
    try {
      assertCompoundApproval(chosen,selected,comparison.context,connectedCreator,Date.now());
      setError(null);
      onApprove(selected,chosen);
    } catch {
      setSelected(null);
      setError('This quote changed or expired. Refresh the routes and select one again.');
    }
  };
  return <Card>
    <CardHeader><CardTitle>Compare Compound routes</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Compare minting new Reserve Tokens with obtaining existing tokens from the pool. Each route uses your creator earnings to form balanced liquidity. You choose the route before approving any spending.</p>
      {!comparison ? <p className="text-xs text-muted-foreground">Live route quotes are unavailable in this design preview. No earnings will be spent.</p> : <>
        <p className="text-sm font-merge-mono">Earnings available: {units(comparison.context.budgetUsdcRaw,6)} USDC</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(['mint','pool'] as const).map(route => {
            const quote = comparison.quotes.find(q => q.route === route);
            const approval = available(route);
            return <div key={route} className="rounded-xl border border-border p-4 space-y-3">
              <h4 className="font-semibold">{route === 'mint' ? 'Mint at NAV' : 'Obtain from pool'}{comparison.recommended === route && <span className="ml-2 text-xs text-primary">Suggested</span>}</h4>
              {!quote ? <p className="text-xs text-muted-foreground">A complete quote is unavailable for this route. Refresh to try again.</p> : <>
                <dl className="text-xs space-y-1">
                  <div><dt>Reserve Tokens added after transfer fees</dt><dd className="font-merge-mono">{units(quote.depositReserveNetRaw,reserveDecimals)} {reserveSymbol}</dd></div>
                  <div><dt>USDC added</dt><dd className="font-merge-mono">{units(quote.depositUsdcRaw,6)} USDC</dd></div>
                  <div><dt>Expected liquidity tokens / minimum</dt><dd className="font-merge-mono">{units(quote.expectedLpRaw,lpDecimals)} / {units(quote.minimumLpRaw,lpDecimals)}</dd></div>
                  <div><dt>Leftover earnings and tokens</dt><dd className="font-merge-mono">{units(quote.leftoverUsdcRaw,6)} USDC · {units(quote.leftoverReserveRaw,reserveDecimals)} {reserveSymbol}</dd></div>
                  <div><dt>Maximum additional network and account budget</dt><dd className="font-merge-mono">{units(quote.maximumSolCostRaw,9)} SOL</dd></div>
                </dl>
                <ul className="text-xs text-muted-foreground space-y-1">{quote.costs.map((cost,i) => <li key={i}>{LABELS[cost.kind]}: {units(cost.amountRaw,cost.unit === 'USDC' ? 6 : cost.unit === 'SOL' ? 9 : reserveDecimals)} {cost.unit === 'ReserveToken' ? reserveSymbol : cost.unit}</li>)}</ul>
                <p className="text-xs text-muted-foreground">USDC and token costs are already reflected in the quote. Mint execution premium includes venue fees. SOL amounts are planning allowances; exact costs must be checked before spending.</p>
                {!approval && <p className="text-xs text-muted-foreground">Refresh an expired quote, or connect the creator wallet to select this route.</p>}
                <Button aria-label={route === 'mint' ? 'Select mint route' : 'Select pool route'} aria-pressed={selectionValid && selected?.route === route} variant={selectionValid && selected?.route === route ? 'default' : 'outline'} size="sm" disabled={!approval} onClick={() => {setSelected(approval);setError(null);}}>Select this route</Button>
              </>}
            </div>;
          })}
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button disabled={!selectionValid || !onApprove || refreshing} onClick={approve}>Review selected route</Button>
          <Button variant="outline" disabled={!onRefresh || refreshing} onClick={() => {setSelected(null);setError(null);onRefresh?.();}}>{refreshing ? 'Refreshing routes…' : 'Refresh both routes'}</Button>
        </div>
        <p className="text-xs text-muted-foreground">The selected quote expires quickly. Changed costs, liquidity, destination or lock terms require a new selection and approval.</p>
      </>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </CardContent>
  </Card>;
}
