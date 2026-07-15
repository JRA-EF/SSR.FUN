import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppStore } from "@/store/useAppStore";
import { formatUsdc } from "@/lib/calculations";
import { PiggyBank, TrendingUp, Coins, Activity } from "lucide-react";

export function Earn() {
  const dtrs = useAppStore(s => s.dtrs);
  
  // Calculate fictional earning stats based on existing data
  const totalAum = dtrs.reduce((sum, dtr) => sum + dtr.aum, 0);
  const avgTvlFee = dtrs.reduce((sum, dtr) => sum + dtr.feeConfig.tvlFeePct * 100, 0) / (dtrs.length || 1);
  const projectedAnnualYield = totalAum * (avgTvlFee / 10000);

  return (
    <div className="container mx-auto px-4 md:px-8 py-16 max-w-5xl">
      <div className="mb-12 text-center">
        <h1 className="text-4xl md:text-5xl font-display font-bold mb-4">Earn on SSR.FUN</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Deploy reserves, attract liquidity, and earn protocol fees. The Decentralized Token Reserve protocol aligns incentives between creators and holders.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <Card className="bg-card/40 border-border/60">
          <CardHeader className="pb-2">
            <PiggyBank className="w-6 h-6 text-primary mb-2" />
            <CardTitle>Total Value Locked</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-foreground">{formatUsdc(totalAum, { compact: true })}</div>
            <p className="text-sm text-muted-foreground mt-1">Across all active DTRs</p>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/60">
          <CardHeader className="pb-2">
            <TrendingUp className="w-6 h-6 text-primary mb-2" />
            <CardTitle>Avg Manager Fee</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-foreground">{(avgTvlFee / 100).toFixed(2)}%</div>
            <p className="text-sm text-muted-foreground mt-1">Annualized TVL fee</p>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/60">
          <CardHeader className="pb-2">
            <Coins className="w-6 h-6 text-primary mb-2" />
            <CardTitle>Projected Annual Yield</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-positive">{formatUsdc(projectedAnnualYield, { compact: true })}</div>
            <p className="text-sm text-muted-foreground mt-1">Estimated total protocol fees</p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <div className="flex items-center gap-2 mb-6">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-display font-bold">How Earning Works</h2>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-4">
            <h3 className="text-xl font-display font-bold">1. Mint Fees</h3>
            <p className="text-muted-foreground leading-relaxed">
              When users deposit USDC to mint new DTR tokens, a one-time mint fee is charged. The Manager configures this fee (default 0.50%), generating immediate upfront revenue for successful distribution.
            </p>
          </div>
          <div className="space-y-4">
            <h3 className="text-xl font-display font-bold">2. TVL Management Fees</h3>
            <p className="text-muted-foreground leading-relaxed">
              Managers earn an ongoing annualized fee on the total value locked (TVL) in their reserves. This aligns the Manager's success with the sustained growth and performance of the basket.
            </p>
          </div>
          <div className="space-y-4">
            <h3 className="text-xl font-display font-bold">3. Rebalancing Fees</h3>
            <p className="text-muted-foreground leading-relaxed">
              Strategic rebalancing of the basket allows managers to extract value from volatility, optimizing the reserve composition while passing along efficiency to holders.
            </p>
          </div>
          <div className="space-y-4">
            <h3 className="text-xl font-display font-bold">4. SSR Settlement Discounts</h3>
            <p className="text-muted-foreground leading-relaxed">
              Settle fees using the SSR token to unlock up to a 25% discount, enhancing capital efficiency for large-scale operations.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}