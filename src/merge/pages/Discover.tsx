// Ported from SSR.FUN-MERGE's Home.tsx "All Reserves" (#directory) section --
// MERGE has no standalone Discover route of its own (that grid lives inline on
// its homepage), so this file gives it one, reusing the exact card markup and
// filtering logic MERGE uses there, now backed by useAppStore.
import { useState } from "react";
import { Link } from "wouter";
import { Activity, SearchX } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { formatUsdc } from "@/lib/calculations";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

export function Discover() {
  const dtrs = useAppStore((s) => s.dtrs);
  const [searchFilter, setSearchFilter] = useState("");

  const filteredDtrs = dtrs.filter(
    (dtr) =>
      dtr.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
      dtr.ticker.toLowerCase().includes(searchFilter.toLowerCase()) ||
      dtr.category.toLowerCase().includes(searchFilter.toLowerCase()),
  );

  return (
    <div className="container mx-auto px-4 md:px-8 py-10 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 pb-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-merge-display font-bold">Discover Reserves</h2>
        </div>
        <div className="relative w-full sm:w-80">
          <Input
            placeholder="Search reserves..."
            className="bg-secondary/50 border-transparent rounded-full pl-4 focus-visible:bg-background"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredDtrs.map((dtr) => {
          const premiumDiscount = (dtr.tokenPrice - dtr.nav) / dtr.nav;
          const isPremium = premiumDiscount > 0;

          return (
            <Card key={dtr.id} className="flex flex-col bg-card border-card-border hover:border-primary/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 group">
              <CardHeader className="pb-4 border-b border-border">
                <div className="flex justify-between items-start mb-4">
                  <Avatar className="h-12 w-12 border border-border shadow-xs">
                    {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
                    <AvatarFallback className="bg-primary/10 text-primary font-merge-display font-bold">
                      {dtr.ticker.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <Badge variant="outline" className="text-muted-foreground font-merge-mono text-[10px] uppercase tracking-wider">
                    {dtr.category}
                  </Badge>
                </div>
                <CardTitle className="text-xl font-merge-display truncate group-hover:text-primary transition-colors">{dtr.name}</CardTitle>
                <CardDescription className="font-merge-mono text-xs">{dtr.ticker}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 py-5">
                <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                  <div>
                    <p className="text-[10px] font-merge-mono uppercase tracking-wider text-muted-foreground mb-1.5">Price</p>
                    <p className="font-merge-mono text-foreground font-medium">{formatUsdc(dtr.tokenPrice)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-merge-mono uppercase tracking-wider text-muted-foreground mb-1.5">24h</p>
                    <p className={`font-merge-mono text-sm font-medium flex items-center ${dtr.change24h >= 0 ? "text-positive" : "text-destructive"}`}>
                      {dtr.change24h >= 0 ? "+" : ""}
                      {dtr.change24h.toFixed(2)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-merge-mono uppercase tracking-wider text-muted-foreground mb-1.5">NAV</p>
                    <p className="font-merge-mono text-sm text-muted-foreground">{formatUsdc(dtr.nav)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-merge-mono uppercase tracking-wider text-muted-foreground mb-1.5">Prem/Discount</p>
                    <p className={`font-merge-mono text-sm ${isPremium ? "text-positive" : "text-destructive"}`}>
                      {isPremium ? "+" : ""}
                      {(premiumDiscount * 100).toFixed(2)}%
                    </p>
                  </div>
                </div>
                <div className="mt-6 pt-5 border-t border-border">
                  <p className="text-[10px] font-merge-mono uppercase tracking-wider text-muted-foreground mb-3">Top Assets</p>
                  <div className="flex flex-wrap gap-1.5">
                    {dtr.composition.slice(0, 3).map((asset) => (
                      <span key={asset.symbol} className="text-[10px] px-2 py-1 rounded bg-secondary text-muted-foreground font-merge-mono">
                        {asset.symbol}
                      </span>
                    ))}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 pb-5 px-5">
                <Button asChild className="w-full rounded-full hover:bg-primary hover:text-primary-foreground transition-all duration-300" variant="secondary">
                  <Link href={`/dtr/${dtr.id}`}>Trade</Link>
                </Button>
              </CardFooter>
            </Card>
          );
        })}

        {filteredDtrs.length === 0 && (
          <div className="col-span-full">
            <Empty className="border border-dashed border-border rounded-2xl bg-secondary/20 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX />
                </EmptyMedia>
                <EmptyTitle>No reserves match your filter</EmptyTitle>
                <EmptyDescription>Try a different name, ticker, or category.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
