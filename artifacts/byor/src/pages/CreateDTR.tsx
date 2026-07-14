import { useState } from "react";
import { useLocation } from "wouter";
import { useAppStore } from "@/store/useAppStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { ChevronRight, ChevronLeft, Plus, X, Search, AlertCircle, Info, Rocket } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUsdc } from "@/lib/calculations";
import { type CreateDTRAssetInput } from "@/lib/types";

const ALL_ASSETS = [
  { symbol: "SOL", name: "Solana" },
  { symbol: "USDC", name: "USD Coin" },
  { symbol: "SSR", name: "SSR" },
  { symbol: "JUP", name: "Jupiter" },
  { symbol: "RAY", name: "Raydium" },
  { symbol: "JTO", name: "Jito" },
  { symbol: "DRIFT", name: "Drift Protocol" },
  { symbol: "RENDER", name: "Render" },
  { symbol: "HNT", name: "Helium" },
  { symbol: "PYTH", name: "Pyth Network" },
  { symbol: "BONK", name: "Bonk" },
  { symbol: "WIF", name: "dogwifhat" },
  { symbol: "POPCAT", name: "Popcat" },
  { symbol: "FARTCOIN", name: "Fartcoin" },
];

export function CreateDTR() {
  const [, setLocation] = useLocation();
  const { wallet, createDTR } = useAppStore();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form State
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Custom");
  
  const [assets, setAssets] = useState<CreateDTRAssetInput[]>([]);
  const [assetSearch, setAssetSearch] = useState("");
  
  const [initialSeedUsdc, setInitialSeedUsdc] = useState("");
  const [mintFeeBps, setMintFeeBps] = useState(50);
  const [tvlFeeBps, setTvlFeeBps] = useState(100);
  const [managerTaxBps, setManagerTaxBps] = useState(0);
  const [feeDestination, setFeeDestination] = useState(wallet.address || "");

  if (!wallet.connected) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <Rocket className="w-16 h-16 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-display font-bold">Connect Wallet to Deploy</h1>
          <p className="text-muted-foreground">
            You need to connect a wallet to deploy and manage a Decentralized Token Reserve.
          </p>
          <div className="p-4 bg-muted/50 rounded-lg border border-border">
            <p className="text-sm font-medium">Use the "Connect Wallet" button in the navigation bar to proceed.</p>
          </div>
        </div>
      </div>
    );
  }

  const handleNext = () => setStep((s) => Math.min(4, s + 1));
  const handleBack = () => setStep((s) => Math.max(1, s - 1));

  const addAsset = (symbol: string, assetName: string) => {
    if (!assets.some(a => a.symbol === symbol)) {
      setAssets([...assets, { symbol, name: assetName, weight: 0.1 }]);
    }
  };

  const removeAsset = (symbol: string) => {
    setAssets(assets.filter(a => a.symbol !== symbol));
  };

  const updateWeight = (symbol: string, newWeight: number) => {
    setAssets(assets.map(a => a.symbol === symbol ? { ...a, weight: newWeight } : a));
  };

  const totalWeight = assets.reduce((sum, a) => sum + a.weight, 0);
  const unallocatedWeight = Math.max(0, 1 - totalWeight);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    await new Promise(r => setTimeout(r, 1000));

    const res = createDTR({
      name,
      ticker,
      description,
      category,
      tags: [category],
      composition: assets,
      initialSeedUsdc: parseFloat(initialSeedUsdc) || 0,
      mintFeeBps,
      tvlFeeBps,
      managerTaxBps,
      creatorFeeDestination: feeDestination || wallet.address || ""
    });

    setIsSubmitting(false);

    if (res.success && res.dtrId) {
      toast({
        title: "Reserve Deployed",
        description: res.message,
      });
      setLocation(`/dtr/${res.dtrId}`);
    } else {
      toast({
        variant: "destructive",
        title: "Deployment Failed",
        description: res.message,
      });
    }
  };

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12">
      <div className="mb-8">
        <h1 className="text-4xl font-display font-bold mb-2">Deploy a Reserve</h1>
        <p className="text-muted-foreground">Create a new Decentralized Token Reserve (DTR) on SSR.FUN.</p>
      </div>

      <div className="flex justify-between mb-8 relative">
        <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-border -z-10 -translate-y-1/2"></div>
        <div 
          className="absolute top-1/2 left-0 h-0.5 bg-primary -z-10 -translate-y-1/2 transition-all duration-300"
          style={{ width: `${((step - 1) / 3) * 100}%` }}
        ></div>
        
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-colors
              ${s < step ? 'bg-primary text-primary-foreground' : 
                s === step ? 'bg-background border-2 border-primary text-primary' : 
                'bg-background border-2 border-border text-muted-foreground'}
            `}>
              {s}
            </div>
            <span className={`text-xs font-semibold hidden sm:block
              ${s <= step ? 'text-foreground' : 'text-muted-foreground'}
            `}>
              {s === 1 ? "Identity" : s === 2 ? "Composition" : s === 3 ? "Economics" : "Review"}
            </span>
          </div>
        ))}
      </div>

      <Card className="border-border/60 shadow-lg">
        {step === 1 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-display">Reserve Identity</CardTitle>
              <CardDescription>Define the basic information for your new reserve.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="name">Reserve Name</Label>
                  <Input 
                    id="name" 
                    placeholder="e.g. Solana Blue Chips" 
                    value={name} 
                    onChange={(e) => setName(e.target.value)} 
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ticker">Ticker</Label>
                  <Input 
                    id="ticker" 
                    placeholder="e.g. BLUE" 
                    className="uppercase"
                    value={ticker} 
                    onChange={(e) => setTicker(e.target.value.toUpperCase())} 
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <select 
                  id="category"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="Custom">Custom</option>
                  <option value="Blue Chip">Blue Chip</option>
                  <option value="DeFi">DeFi</option>
                  <option value="Meme">Meme</option>
                  <option value="Infrastructure">Infrastructure</option>
                  <option value="Gaming">Gaming</option>
                  <option value="Strategic">Strategic</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea 
                  id="description" 
                  placeholder="Describe the strategy and focus of this reserve..." 
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </CardContent>
            <CardFooter className="justify-end border-t border-border/40 pt-6">
              <Button onClick={handleNext} disabled={!name || !ticker} className="font-bold gap-2">
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </CardFooter>
          </>
        )}

        {step === 2 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-display">Basket Composition</CardTitle>
              <CardDescription>Select assets and set their target weights (must sum to ≤ 100%).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Asset Selection */}
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input 
                      placeholder="Search assets to add..." 
                      className="pl-9"
                      value={assetSearch}
                      onChange={(e) => setAssetSearch(e.target.value)}
                    />
                  </div>
                  
                  <div className="border border-border rounded-lg max-h-[300px] overflow-y-auto p-2 bg-muted/20 space-y-1">
                    {ALL_ASSETS
                      .filter(a => !assets.some(selected => selected.symbol === a.symbol))
                      .filter(a => a.name.toLowerCase().includes(assetSearch.toLowerCase()) || a.symbol.toLowerCase().includes(assetSearch.toLowerCase()))
                      .map(asset => (
                        <div key={asset.symbol} className="flex items-center justify-between p-2 hover:bg-muted rounded-md transition-colors">
                          <div>
                            <span className="font-semibold">{asset.name}</span>
                            <span className="text-xs text-muted-foreground ml-2 font-mono">{asset.symbol}</span>
                          </div>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => addAsset(asset.symbol, asset.name)}>
                            <Plus className="w-4 h-4 text-primary" />
                          </Button>
                        </div>
                      ))}
                      {ALL_ASSETS.filter(a => !assets.some(selected => selected.symbol === a.symbol)).length === 0 && (
                        <div className="p-4 text-center text-sm text-muted-foreground">All available assets added.</div>
                      )}
                  </div>
                </div>

                {/* Selected Basket */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center bg-muted/50 p-3 rounded-lg border border-border">
                    <span className="font-semibold text-sm">Total Allocated</span>
                    <span className={`font-mono font-bold ${totalWeight > 1.0001 ? 'text-destructive' : 'text-primary'}`}>
                      {(totalWeight * 100).toFixed(1)}%
                    </span>
                  </div>
                  
                  {unallocatedWeight > 0 && totalWeight <= 1.0001 && (
                    <div className="flex justify-between items-center p-3 rounded-lg border border-dashed border-border/80 text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-muted-foreground/30"></div>
                        <span className="text-muted-foreground italic">Unallocated USDC Reserve</span>
                      </div>
                      <span className="font-mono text-muted-foreground">{(unallocatedWeight * 100).toFixed(1)}%</span>
                    </div>
                  )}

                  <div className="space-y-3">
                    {assets.map((asset) => (
                      <div key={asset.symbol} className="p-3 border border-border rounded-lg bg-card space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{asset.symbol}</span>
                            <span className="text-xs text-muted-foreground truncate max-w-[100px]">{asset.name}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center">
                              <Input 
                                type="number" 
                                className="w-20 h-8 text-right font-mono"
                                value={+(asset.weight * 100).toFixed(1)}
                                onChange={(e) => updateWeight(asset.symbol, parseFloat(e.target.value) / 100)}
                                step="0.1"
                                min="0"
                                max="100"
                              />
                              <span className="text-muted-foreground ml-1 text-sm">%</span>
                            </div>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeAsset(asset.symbol)}>
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                        <Slider 
                          value={[asset.weight * 100]} 
                          max={100} 
                          step={1}
                          onValueChange={(v) => updateWeight(asset.symbol, v[0] / 100)}
                        />
                      </div>
                    ))}
                    {assets.length === 0 && (
                      <div className="p-8 text-center border border-dashed border-border rounded-lg text-muted-foreground text-sm">
                        Select assets from the list to build your basket.
                      </div>
                    )}
                  </div>
                  
                  {totalWeight > 1.0001 && (
                    <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>Total weight exceeds 100%. Please adjust allocations.</p>
                    </div>
                  )}
                </div>
              </div>

            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <Button variant="ghost" onClick={handleBack} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button onClick={handleNext} disabled={assets.length === 0 || totalWeight > 1.0001} className="font-bold gap-2">
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </CardFooter>
          </>
        )}

        {step === 3 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-display">Economics & Fees</CardTitle>
              <CardDescription>Configure the fee structure and initial liquidity for your reserve.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              
              <div className="space-y-4">
                <h3 className="font-semibold text-lg border-b border-border/50 pb-2">Initial Liquidity</h3>
                <div className="space-y-2 max-w-md">
                  <Label htmlFor="seed" className="flex items-center gap-2">
                    Seed Amount (USDC)
                    <Tooltip>
                      <TooltipTrigger><Info className="w-3 h-3 text-muted-foreground" /></TooltipTrigger>
                      <TooltipContent>Initial capital to seed the reserve and set the starting AUM.</TooltipContent>
                    </Tooltip>
                  </Label>
                  <div className="relative">
                    <Input 
                      id="seed" 
                      type="number" 
                      placeholder="e.g. 10000" 
                      className="font-mono"
                      value={initialSeedUsdc}
                      onChange={(e) => setInitialSeedUsdc(e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground flex justify-between">
                    <span>Wallet Balance: <span className="font-mono">{formatUsdc(wallet.usdc)}</span></span>
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                <h3 className="font-semibold text-lg border-b border-border/50 pb-2">Fee Configuration (Basis Points)</h3>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Mint Fee</span>
                      <span className="font-mono text-primary">{mintFeeBps} bps</span>
                    </Label>
                    <Slider 
                      value={[mintFeeBps]} 
                      max={500} 
                      step={5}
                      onValueChange={(v) => setMintFeeBps(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Charged on new issuance. Protocol default is 50 bps.</p>
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Annualized TVL Fee</span>
                      <span className="font-mono text-primary">{tvlFeeBps} bps</span>
                    </Label>
                    <Slider 
                      value={[tvlFeeBps]} 
                      max={500} 
                      step={5}
                      onValueChange={(v) => setTvlFeeBps(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Accrues to Manager. Protocol default is 100 bps.</p>
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Manager Tax</span>
                      <span className="font-mono text-primary">{managerTaxBps} bps</span>
                    </Label>
                    <Slider 
                      value={[managerTaxBps]} 
                      max={200} 
                      step={5}
                      onValueChange={(v) => setManagerTaxBps(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Optional additional buy/sell tax. Default is 0 bps.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-semibold text-lg border-b border-border/50 pb-2">Fee Routing</h3>
                <div className="space-y-2">
                  <Label htmlFor="dest">Creator Fee Destination Wallet</Label>
                  <Input 
                    id="dest" 
                    value={feeDestination}
                    onChange={(e) => setFeeDestination(e.target.value)}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">Address that receives the Manager's share of revenue.</p>
                </div>
              </div>

            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <Button variant="ghost" onClick={handleBack} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button 
                onClick={handleNext} 
                disabled={!initialSeedUsdc || parseFloat(initialSeedUsdc) <= 0 || parseFloat(initialSeedUsdc) > wallet.usdc} 
                className="font-bold gap-2"
              >
                Review <ChevronRight className="w-4 h-4" />
              </Button>
            </CardFooter>
          </>
        )}

        {step === 4 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-display">Review & Deploy</CardTitle>
              <CardDescription>Confirm your reserve parameters before deploying to the protocol.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="bg-muted/50 p-4 border-b border-border flex justify-between items-center">
                  <div>
                    <h3 className="text-xl font-display font-bold">{name}</h3>
                    <Badge variant="secondary" className="font-mono mt-1">{ticker}</Badge>
                  </div>
                  <Badge variant="outline" className="bg-background">{category}</Badge>
                </div>
                
                <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-2">Description</p>
                    <p className="text-sm">{description || "No description provided."}</p>
                  </div>
                  
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-muted-foreground mb-2">Economics</p>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Initial Seed</span>
                      <span className="font-mono font-medium">{formatUsdc(parseFloat(initialSeedUsdc))}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Mint Fee</span>
                      <span className="font-mono font-medium">{mintFeeBps} bps</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">TVL Fee</span>
                      <span className="font-mono font-medium">{tvlFeeBps} bps</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Manager Tax</span>
                      <span className="font-mono font-medium">{managerTaxBps} bps</span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-3">Target Composition</p>
                <div className="space-y-2">
                  {assets.sort((a,b) => b.weight - a.weight).map(asset => (
                    <div key={asset.symbol} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{asset.symbol}</span>
                        <span className="text-muted-foreground text-xs">{asset.name}</span>
                      </div>
                      <span className="font-mono font-bold">{(asset.weight * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  {unallocatedWeight > 0 && (
                    <div className="flex justify-between items-center p-2 rounded border border-dashed border-border/80 text-sm">
                      <span className="text-muted-foreground italic">Unallocated USDC Reserve</span>
                      <span className="font-mono text-muted-foreground">{(unallocatedWeight * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </div>

            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <Button variant="ghost" onClick={handleBack} disabled={isSubmitting} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button 
                onClick={handleSubmit} 
                disabled={isSubmitting} 
                className="font-bold gap-2 min-w-[150px]"
              >
                {isSubmitting ? (
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Deploying...</>
                ) : (
                  <><Rocket className="w-4 h-4" /> Deploy Reserve</>
                )}
              </Button>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  );
}