import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, TrendingUp, Users, Activity, BarChart3 } from "lucide-react";
import { DTRS, FEATURED_DTR_ID, TRENDING_DTR_IDS, getDtrById } from "@/lib/seed-data";
import { formatUsdc, formatPercent } from "@/lib/calculations";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function Home() {
  const [searchFilter, setSearchFilter] = useState("");

  const totalAum = DTRS.reduce((sum, dtr) => sum + dtr.aum, 0);
  const totalHolders = DTRS.reduce((sum, dtr) => sum + dtr.holders, 0);
  const activeDtrs = DTRS.length;
  // Fictional 24h volume approx 5% of AUM
  const volume24h = totalAum * 0.054;

  const featuredDtr = getDtrById(FEATURED_DTR_ID)!;
  const trendingDtrs = TRENDING_DTR_IDS.map(id => getDtrById(id)!).filter(Boolean);

  const filteredDtrs = DTRS.filter(dtr => 
    dtr.name.toLowerCase().includes(searchFilter.toLowerCase()) || 
    dtr.ticker.toLowerCase().includes(searchFilter.toLowerCase()) ||
    dtr.category.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative overflow-hidden border-b border-border/50 bg-card/30 pt-16 pb-20 md:pt-24 md:pb-32">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
          <div className="absolute left-0 right-0 top-0 -z-10 m-auto h-[310px] w-[310px] rounded-full bg-primary opacity-20 blur-[100px]"></div>
          
          <div className="container mx-auto px-4 md:px-8 relative z-10">
            <div className="max-w-3xl">
              <Badge variant="outline" className="mb-6 border-primary/30 text-primary bg-primary/10">An SSR Protocol</Badge>
              <h1 className="font-display text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight mb-6">
                Build <br/>
                <span className="text-muted-foreground">Your Own</span> <br/>
                <span className="text-primary">Reserve</span>
              </h1>
              <p className="text-lg md:text-xl text-muted-foreground mb-10 max-w-2xl leading-relaxed">
                Create, manage, and trade Decentralized Token Reserves (DTRs) on Solana. 
                Gain instant exposure to curated asset baskets with algorithmic rebalancing and zero middleman risk.
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8 pt-8 border-t border-border/50">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Total DTR AUM</p>
                  <p className="text-2xl font-mono font-bold text-foreground">{formatUsdc(totalAum, { compact: true })}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">24h Volume</p>
                  <p className="text-2xl font-mono font-bold text-foreground">{formatUsdc(volume24h, { compact: true })}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Active DTRs</p>
                  <p className="text-2xl font-mono font-bold text-foreground">{activeDtrs}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Total Holders</p>
                  <p className="text-2xl font-mono font-bold text-foreground">{totalHolders.toLocaleString()}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="container mx-auto px-4 md:px-8 py-16 space-y-16">
          
          {/* Featured & Trending */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">Featured Reserve</h2>
              </div>
              <Card className="bg-gradient-to-br from-card to-card/50 border-primary/20 overflow-hidden relative group">
                <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-primary/10 transition-colors duration-700"></div>
                <CardContent className="p-8">
                  <div className="flex flex-col md:flex-row gap-8 items-start md:items-center">
                    <div className="flex-1">
                      <div className="flex items-center gap-4 mb-4">
                        <Avatar className="h-16 w-16 border-2 border-background shadow-lg">
                          <AvatarFallback className="bg-primary/20 text-primary text-xl font-bold font-display">
                            {featuredDtr.ticker.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <h3 className="text-3xl font-display font-bold text-foreground leading-tight">{featuredDtr.name}</h3>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="secondary" className="font-mono">{featuredDtr.ticker}</Badge>
                            <span className="text-sm text-muted-foreground">{featuredDtr.category}</span>
                          </div>
                        </div>
                      </div>
                      <p className="text-muted-foreground mb-6 max-w-md">
                        {featuredDtr.description}
                      </p>
                      
                      <div className="grid grid-cols-3 gap-4 mb-8">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Price</p>
                          <p className="text-lg font-mono font-semibold">{formatUsdc(featuredDtr.tokenPrice)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">24h Change</p>
                          <p className={`text-lg font-mono font-semibold flex items-center ${featuredDtr.change24h >= 0 ? 'text-primary' : 'text-destructive'}`}>
                            {featuredDtr.change24h >= 0 ? <ArrowUpRight className="w-4 h-4 mr-1" /> : <ArrowDownRight className="w-4 h-4 mr-1" />}
                            {Math.abs(featuredDtr.change24h).toFixed(2)}%
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">AUM</p>
                          <p className="text-lg font-mono font-semibold">{formatUsdc(featuredDtr.aum, { compact: true })}</p>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {featuredDtr.composition.slice(0, 4).map(asset => (
                          <Badge key={asset.symbol} variant="outline" className="bg-background/50">
                            {asset.symbol} <span className="text-muted-foreground ml-1 font-mono">{(asset.weight * 100).toFixed(0)}%</span>
                          </Badge>
                        ))}
                        {featuredDtr.composition.length > 4 && (
                          <Badge variant="outline" className="bg-background/50 text-muted-foreground">+{featuredDtr.composition.length - 4}</Badge>
                        )}
                      </div>
                    </div>
                    
                    <div className="w-full md:w-auto shrink-0 flex flex-col gap-3">
                      <Button asChild size="lg" className="w-full md:w-40 font-semibold shadow-primary/20 shadow-lg">
                        <Link href={`/dtr/${featuredDtr.id}`}>Trade {featuredDtr.ticker}</Link>
                      </Button>
                      <Button asChild variant="outline" size="lg" className="w-full md:w-40 bg-background/50">
                        <Link href={`/dtr/${featuredDtr.id}`}>View Details</Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">Trending</h2>
              </div>
              <div className="grid grid-cols-1 gap-4">
                {trendingDtrs.map((dtr) => {
                  const premiumDiscount = (dtr.tokenPrice - dtr.nav) / dtr.nav;
                  return (
                    <Link key={dtr.id} href={`/dtr/${dtr.id}`}>
                      <Card className="hover:border-primary/50 transition-colors cursor-pointer bg-card/50">
                        <CardContent className="p-4 flex items-center gap-4">
                          <Avatar className="h-10 w-10 border border-border">
                            <AvatarFallback className="bg-muted text-muted-foreground font-display text-xs">
                              {dtr.ticker.slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <h4 className="font-semibold text-foreground truncate">{dtr.name}</h4>
                              <span className="font-mono text-sm">{formatUsdc(dtr.tokenPrice)}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground font-mono">{dtr.ticker}</span>
                              <span className={`font-mono flex items-center ${dtr.change24h >= 0 ? 'text-primary' : 'text-destructive'}`}>
                                {dtr.change24h >= 0 ? <ArrowUpRight className="w-3 h-3 mr-0.5" /> : <ArrowDownRight className="w-3 h-3 mr-0.5" />}
                                {Math.abs(dtr.change24h).toFixed(2)}%
                              </span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>

          {/* All DTRs */}
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">All Reserves</h2>
              </div>
              <div className="relative w-full sm:w-72">
                <Input 
                  placeholder="Filter reserves..." 
                  className="bg-card/50"
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
                  <Card key={dtr.id} className="flex flex-col bg-card/40 border-border/60 hover:border-primary/40 transition-colors group">
                    <CardHeader className="pb-4">
                      <div className="flex justify-between items-start mb-2">
                        <Avatar className="h-12 w-12 border border-background shadow-sm">
                          <AvatarFallback className="bg-primary/10 text-primary font-display font-bold">
                            {dtr.ticker.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <Badge variant="outline" className="bg-background/50">
                          {dtr.category}
                        </Badge>
                      </div>
                      <CardTitle className="text-xl font-display truncate">{dtr.name}</CardTitle>
                      <CardDescription className="font-mono">{dtr.ticker}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 pb-4">
                      <div className="grid grid-cols-2 gap-y-4 gap-x-2">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Price</p>
                          <p className="font-mono text-foreground">{formatUsdc(dtr.tokenPrice)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">24h</p>
                          <p className={`font-mono text-sm flex items-center ${dtr.change24h >= 0 ? 'text-primary' : 'text-destructive'}`}>
                            {dtr.change24h >= 0 ? '+' : ''}{dtr.change24h.toFixed(2)}%
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">NAV</p>
                          <p className="font-mono text-sm">{formatUsdc(dtr.nav)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Prem/Discount</p>
                          <p className={`font-mono text-sm ${isPremium ? 'text-primary' : 'text-destructive'}`}>
                            {isPremium ? '+' : ''}{(premiumDiscount * 100).toFixed(2)}%
                          </p>
                        </div>
                      </div>
                      <div className="mt-6 pt-4 border-t border-border/50">
                        <p className="text-xs text-muted-foreground mb-2">Top Assets</p>
                        <div className="flex flex-wrap gap-1.5">
                          {dtr.composition.slice(0, 3).map(asset => (
                            <span key={asset.symbol} className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                              {asset.symbol}
                            </span>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                    <CardFooter className="pt-0">
                      <Button asChild className="w-full group-hover:bg-primary group-hover:text-primary-foreground transition-colors" variant="secondary">
                        <Link href={`/dtr/${dtr.id}`}>Trade</Link>
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })}
              
              {filteredDtrs.length === 0 && (
                <div className="col-span-full py-12 text-center border rounded-xl border-dashed border-border">
                  <p className="text-muted-foreground">No reserves match your filter.</p>
                </div>
              )}
            </div>
          </div>

        </div>
      </main>
      <footer className="border-t border-border/40 py-8 text-center text-sm text-muted-foreground bg-card/20">
        <div className="container mx-auto px-4">
          <p>BYOR Simulation • Build Your Own Reserve</p>
          <p className="mt-2 text-xs opacity-60">This is a simulated environment. Fictional data only.</p>
        </div>
      </footer>
    </div>
  );
}
