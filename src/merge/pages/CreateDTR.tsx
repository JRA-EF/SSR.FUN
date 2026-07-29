import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_FIXTURES, WRAPPED_SOL_MINT, SOL_TEST_PRICE_USD, DEVUSDC } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import { createReserveOnChain, estimateCreateReserveCost, type CreateReserveStep, type CreateReserveCostEstimate } from "@/lib/createReserveClient";
import { explorerUrl } from "@/lib/solana-config";
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
import { formatUsdc, TICKER_MAX_LENGTH } from "@/lib/calculations";
import { type CreateDTRAssetInput, type FeeRecipient, type OnChainReserveMeta, type DTR } from "@/lib/types";
import { CATEGORY_SUGGESTIONS } from "@/lib/seed-data";

// Real, genuinely supported DevNet assets -- native SOL (wrapped internally
// where the SPL-token protocol requires it -- see createReserveClient.ts),
// the real devUSDC settlement mint (Phase B), plus the 3 Gate-9 fixture test
// mints -- every one of these is a mint the DevNet swap/faucet authority
// actually holds mint authority over, so seed-funding and the Buy/Sell zap
// both work for any of them. These are the ONLY assets that can produce a
// real, Buy/Sell-testable Reserve; mixing any fictional asset below in
// falls back to the existing pure-simulation deploy path unchanged. Never
// present a fictional asset as one of these -- see DEC-0030.
const DEVNET_REAL_ASSETS = [
  { symbol: "SOL", name: "Solana (native, wrapped automatically as needed)", real: true as const, mint: WRAPPED_SOL_MINT.toBase58(), decimals: 9 },
  { symbol: DEVUSDC.symbol, name: `${DEVUSDC.name} (DevNet settlement token, no real value)`, real: true as const, mint: DEVUSDC.mint, decimals: DEVUSDC.decimals },
  ...Object.values(DEVNET_FIXTURES.mints).map((m) => ({
    symbol: m.symbol.toUpperCase(),
    name: `SSR DevNet Test Asset (${m.symbol})`,
    real: true as const,
    mint: m.address,
    decimals: m.decimals,
  })),
];
const REAL_ASSET_BY_SYMBOL = new Map(DEVNET_REAL_ASSETS.map((a) => [a.symbol, a]));

// Fictional/simulated assets -- clearly isolated from the real list above,
// only ever usable via the pure-simulation deploy path (createDTR), never
// presented or treated as real deployable assets.
const ALL_ASSETS = [
  ...DEVNET_REAL_ASSETS,
  { symbol: "USDC", name: "USD Coin (simulated)" },
  { symbol: "SSR", name: "SSR (simulated)" },
  { symbol: "JUP", name: "Jupiter (simulated)" },
  { symbol: "RAY", name: "Raydium (simulated)" },
  { symbol: "JTO", name: "Jito (simulated)" },
  { symbol: "DRIFT", name: "Drift Protocol (simulated)" },
  { symbol: "RENDER", name: "Render (simulated)" },
  { symbol: "HNT", name: "Helium (simulated)" },
  { symbol: "PYTH", name: "Pyth Network (simulated)" },
  { symbol: "BONK", name: "Bonk (simulated)" },
  { symbol: "WIF", name: "dogwifhat (simulated)" },
  { symbol: "POPCAT", name: "Popcat (simulated)" },
  { symbol: "FARTCOIN", name: "Fartcoin (simulated)" },
];

const CREATE_STEP_LABELS: Record<CreateReserveStep, string> = {
  "create-and-register": "Step 1/2: Creating Reserve + registering assets...",
  "fund-seed-assets": "Funding seed assets (DevNet)...",
  seed: "Step 2/2: Seeding Reserve...",
  done: "Done",
};

/** How many wallet approvals createReserveOnChain will request for this asset selection -- see createReserveClient.ts's signature-count note. */
function expectedApprovalCount(assets: { symbol: string }[]): number {
  const needsSolWrap = assets.some((a) => a.symbol === "SOL");
  return needsSolWrap ? 3 : 2;
}

export function CreateDTR() {
  const [, setLocation] = useLocation();
  const { wallet, createDTR, registerRealReserve } = useAppStore();
  const { toast } = useToast();
  const { connection } = useConnection();
  const walletCtx = useWallet();

  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createStep, setCreateStep] = useState<CreateReserveStep | null>(null);

  // Form State
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Custom");
  
  const [assets, setAssets] = useState<CreateDTRAssetInput[]>([]);
  const [assetSearch, setAssetSearch] = useState("");
  
  const [initialSeedUsdc, setInitialSeedUsdc] = useState("");
  const [mintFeePct, setMintFeePct] = useState(0.5);
  const [tvlFeePct, setTvlFeePct] = useState(1);
  const [managerBuyTaxPct, setManagerBuyTaxPct] = useState(0);
  const [managerSellTaxPct, setManagerSellTaxPct] = useState(0);
  const [feeDestination, setFeeDestination] = useState(wallet.address || "");
  const [feeRecipients, setFeeRecipients] = useState<FeeRecipient[]>([]);
  const [newRecipientAddress, setNewRecipientAddress] = useState("");
  const [newRecipientPct, setNewRecipientPct] = useState("");
  const [additionalManagers, setAdditionalManagers] = useState<string[]>([]);
  const [newManagerAddress, setNewManagerAddress] = useState("");
  const [costEstimate, setCostEstimate] = useState<CreateReserveCostEstimate | null>(null);
  const [costEstimateError, setCostEstimateError] = useState<string | null>(null);

  // Computed here (not after the early wallet-connected return below) so
  // this effect's dependency array stays valid across every render --
  // React's hooks must run in the same order every time, and the early
  // return further down means nothing after it can safely hold a hook.
  const realDeploymentCandidate = assets.length > 0 && assets.every((a) => REAL_ASSET_BY_SYMBOL.has(a.symbol));
  const totalWeightForCost = assets.reduce((sum, a) => sum + a.weight, 0);

  useEffect(() => {
    if (!realDeploymentCandidate || totalWeightForCost <= 0) {
      setCostEstimate(null);
      setCostEstimateError(null);
      return;
    }
    let cancelled = false;
    const seedUsd = parseFloat(initialSeedUsdc) || 10;
    const realAssets = assets.map((a) => {
      const meta = REAL_ASSET_BY_SYMBOL.get(a.symbol)!;
      return { mint: meta.mint, decimals: meta.decimals, weightBps: Math.round((a.weight / totalWeightForCost) * 10_000), seedWeightFraction: a.weight / totalWeightForCost };
    });
    estimateCreateReserveCost(connection, realAssets, seedUsd)
      .then((est) => {
        if (!cancelled) {
          setCostEstimate(est);
          setCostEstimateError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setCostEstimate(null);
          setCostEstimateError(e instanceof Error ? e.message : "Failed to estimate DevNet transaction costs.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [realDeploymentCandidate, totalWeightForCost, initialSeedUsdc, assets, connection]);

  if (!wallet.connected) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <Rocket className="w-16 h-16 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-merge-display font-bold">Connect Wallet to Deploy</h1>
          <p className="text-muted-foreground">
            You need to connect a wallet to deploy and manage a Reserve.
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
  // A real on-chain deployment requires EVERY selected asset to be one of
  // the DevNet swap adapter's supported test mints -- mixing in any
  // fictional asset falls back to the existing pure-simulation deploy.
  const isRealDeployment = assets.length > 0 && assets.every((a) => REAL_ASSET_BY_SYMBOL.has(a.symbol));

  const feeRecipientTotalPct = feeRecipients.reduce((sum, r) => sum + r.pct, 0);

  const addFeeRecipient = () => {
    const pct = parseFloat(newRecipientPct);
    if (!newRecipientAddress.trim() || !pct || pct <= 0) return;
    if (feeRecipients.some((r) => r.address === newRecipientAddress.trim())) return;
    setFeeRecipients([...feeRecipients, { address: newRecipientAddress.trim(), pct }]);
    setNewRecipientAddress("");
    setNewRecipientPct("");
  };

  const removeFeeRecipient = (address: string) => {
    setFeeRecipients(feeRecipients.filter((r) => r.address !== address));
  };

  const addManager = () => {
    const address = newManagerAddress.trim();
    if (!address || additionalManagers.includes(address) || address === wallet.address) return;
    setAdditionalManagers([...additionalManagers, address]);
    setNewManagerAddress("");
  };

  const removeManager = (address: string) => {
    setAdditionalManagers(additionalManagers.filter((a) => a !== address));
  };

  const handleSubmitReal = async () => {
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    setIsSubmitting(true);
    setCreateStep("create-and-register");
    try {
      const feeDestinationKey = new PublicKey(feeDestination || walletCtx.publicKey.toBase58());
      const realAssets = assets.map((a) => {
        const meta = REAL_ASSET_BY_SYMBOL.get(a.symbol)!;
        return { mint: meta.mint, decimals: meta.decimals, weightBps: Math.round((a.weight / totalWeight) * 10_000), seedWeightFraction: a.weight / totalWeight };
      });

      const result = await createReserveOnChain({
        connection,
        wallet: walletCtx,
        metadataUri: `data:application/json,${encodeURIComponent(JSON.stringify({ name, ticker, description, category }))}`,
        mintFeeBps: Math.round(mintFeePct * 100),
        tvlFeeBps: Math.round(tvlFeePct * 100),
        feeDestination: feeDestinationKey,
        assets: realAssets,
        seedTotalUsd: parseFloat(initialSeedUsdc) || 10,
        onProgress: setCreateStep,
      });

      const dtrId = `devnet-${result.reserveId}`;
      const onChain: OnChainReserveMeta = {
        programId: DEVNET_FIXTURES.programId,
        reserveId: result.reserveId,
        reserve: result.reserve,
        reserveTokenMint: result.reserveTokenMint,
        mintAuthority: result.mintAuthority,
        vaultAuthority: result.vaultAuthority,
        manager: walletCtx.publicKey.toBase58(),
        assets: result.assets.map((a) => ({
          mint: a.mint,
          symbol: DEVNET_REAL_ASSETS.find((m) => m.mint === a.mint)?.symbol ?? "?",
          decimals: a.decimals,
          weightBps: a.weightBps,
          reserveAsset: a.reserveAsset,
          vault: a.vault,
        })),
        status: "active",
        totalTargetWeightBps: 10_000,
        reserveTokenSupplyRaw: String(Math.max(1, Math.floor(parseFloat(initialSeedUsdc) || 10)) * 1_000_000),
        vaultBalancesRaw: {},
      };
      const newDtr: DTR = {
        id: dtrId,
        name,
        ticker: ticker.toUpperCase(),
        description,
        category,
        tags: [category, "devnet", "real"],
        logoSeed: dtrId,
        dtrAddress: result.reserve,
        managerAddress: walletCtx.publicKey.toBase58(),
        delegates: [],
        feeConfig: {
          mintFeePct,
          tvlFeePct,
          managerBuyTaxPct: 0,
          managerSellTaxPct: 0,
          creatorFeeDestination: feeDestinationKey.toBase58(),
          feeRecipients: [],
        },
        tokenPrice: 1,
        nav: 1,
        aum: parseFloat(initialSeedUsdc) || 10,
        liquidityUsdc: parseFloat(initialSeedUsdc) || 10,
        change24h: 0,
        change7d: 0,
        holders: 1,
        composition: assets.map((a) => ({ symbol: a.symbol, name: a.name, weight: a.weight / totalWeight })),
        unallocatedPct: 0,
        isUserCreated: true,
        priceHistory: [{ t: Date.now(), price: 1 }],
        trades: [],
        onChain,
      };
      registerRealReserve(newDtr);

      toast({
        title: "Reserve deployed on Solana DevNet",
        description: `Reserve: ${explorerUrl("address", result.reserve)} · Create tx: ${explorerUrl("tx", result.transactions.createAndRegister)}`,
      });
      setLocation(`/dtr/${dtrId}`);
    } catch (e) {
      toast({
        variant: "destructive",
        title: `Deployment Failed (${createStep ? CREATE_STEP_LABELS[createStep] : "setup"})`,
        description: e instanceof Error ? e.message : "The DevNet Reserve creation failed.",
      });
    } finally {
      setIsSubmitting(false);
      setCreateStep(null);
    }
  };

  const handleSubmitMock = async () => {
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
      mintFeePct,
      tvlFeePct,
      managerBuyTaxPct,
      managerSellTaxPct,
      creatorFeeDestination: feeDestination || wallet.address || "",
      feeRecipients,
      additionalManagers,
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

  const handleSubmit = isRealDeployment ? handleSubmitReal : handleSubmitMock;

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12">
      <div className="mb-8">
        <h1 className="text-4xl font-merge-display font-bold mb-2">Launch Reserve</h1>
        <p className="text-muted-foreground">Launch a new Reserve on SSR.FUN.</p>
      </div>

      <div className="flex justify-between mb-8 relative">
        {/* Anchored to top-4 (16px = half of the w-8/h-8 circle below), not top-1/2 of the
            whole step item -- top-1/2 measured against the full circle+label height, which
            sits the line below the circles' true center. */}
        <div className="absolute top-4 left-0 right-0 h-0.5 bg-border -z-10 -translate-y-1/2"></div>
        <div
          className="absolute top-4 left-0 h-0.5 bg-primary -z-10 -translate-y-1/2 transition-all duration-300"
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
              <CardTitle className="text-2xl font-merge-display">Reserve Identity</CardTitle>
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
                    maxLength={TICKER_MAX_LENGTH}
                    value={ticker} 
                    onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, TICKER_MAX_LENGTH))}
                  />
                  <p className="text-xs text-muted-foreground">Up to {TICKER_MAX_LENGTH} letters, no numbers.</p>
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  list="category-suggestions"
                  placeholder="e.g. DeFi, or name your own"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
                <datalist id="category-suggestions">
                  {CATEGORY_SUGGESTIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">Pick a suggestion or type your own category name.</p>
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
              <CardTitle className="text-2xl font-merge-display">Basket Composition</CardTitle>
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
                            <span className="text-xs text-muted-foreground ml-2 font-merge-mono">{asset.symbol}</span>
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
                    <span className={`font-merge-mono font-bold ${totalWeight > 1.0001 ? 'text-destructive' : 'text-primary'}`}>
                      {(totalWeight * 100).toFixed(1)}%
                    </span>
                  </div>
                  
                  {unallocatedWeight > 0 && totalWeight <= 1.0001 && (
                    <div className="flex justify-between items-center p-3 rounded-lg border border-dashed border-border/80 text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-muted-foreground/30"></div>
                        <span className="text-muted-foreground italic">Unallocated USDC Reserve</span>
                      </div>
                      <span className="font-merge-mono text-muted-foreground">{(unallocatedWeight * 100).toFixed(1)}%</span>
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
                                className="w-20 h-8 text-right font-merge-mono"
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
              <CardTitle className="text-2xl font-merge-display">Economics & Fees</CardTitle>
              <CardDescription>Configure the fee structure and initial liquidity for your reserve.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              
              <div className="space-y-4">
                <h3 className="font-semibold text-lg pb-2">Initial Liquidity</h3>
                <div className="space-y-2 max-w-md">
                  <Label htmlFor="seed" className="flex items-center gap-2">
                    {isRealDeployment ? "Initial Reserve Value (USD)" : "Seed Amount (USDC)"}
                    <Tooltip>
                      <TooltipTrigger><Info className="w-3 h-3 text-muted-foreground" /></TooltipTrigger>
                      <TooltipContent>
                        {isRealDeployment
                          ? "The USD value to seed the reserve with. You'll provide the equivalent DevNet SOL shown below -- it's converted into the selected Reserve assets and deposited for you."
                          : "Initial capital to seed the reserve and set the starting AUM."}
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-3 flex items-center text-muted-foreground text-sm">$</span>
                    <Input
                      id="seed"
                      type="number"
                      placeholder="e.g. 10.00"
                      className="font-merge-mono pl-6"
                      value={initialSeedUsdc}
                      onChange={(e) => setInitialSeedUsdc(e.target.value)}
                    />
                  </div>
                  {isRealDeployment ? (
                    <p className="text-xs text-muted-foreground flex justify-between">
                      <span>
                        &asymp; <span className="font-merge-mono">{((parseFloat(initialSeedUsdc) || 0) / SOL_TEST_PRICE_USD).toFixed(5)} SOL</span> at the DevNet test price of ${SOL_TEST_PRICE_USD.toFixed(2)}/SOL
                      </span>
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground flex justify-between">
                      <span>Wallet Balance: <span className="font-merge-mono">{formatUsdc(wallet.usdc)}</span></span>
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <h3 className="font-semibold text-lg pb-2">Fee Configuration</h3>
                
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Mint Fee</span>
                      <span className="font-merge-mono text-primary">{mintFeePct.toFixed(2)}%</span>
                    </Label>
                    <Slider 
                      value={[mintFeePct]} 
                      max={5} 
                      step={0.05}
                      onValueChange={(v) => setMintFeePct(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Charged on new issuance. Protocol default is 0.50%.</p>
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Annualized TVL Fee</span>
                      <span className="font-merge-mono text-primary">{tvlFeePct.toFixed(2)}%</span>
                    </Label>
                    <Slider 
                      value={[tvlFeePct]} 
                      max={5} 
                      step={0.05}
                      onValueChange={(v) => setTvlFeePct(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Accrues to Manager. Protocol default is 1.00%.</p>
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Buy Tax</span>
                      <span className="font-merge-mono text-primary">{managerBuyTaxPct.toFixed(2)}%</span>
                    </Label>
                    <Slider 
                      value={[managerBuyTaxPct]} 
                      max={2} 
                      step={0.05}
                      onValueChange={(v) => setManagerBuyTaxPct(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Optional additional tax charged on buys. Default is 0%.</p>
                  </div>

                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Sell Tax</span>
                      <span className="font-merge-mono text-primary">{managerSellTaxPct.toFixed(2)}%</span>
                    </Label>
                    <Slider 
                      value={[managerSellTaxPct]} 
                      max={2} 
                      step={0.05}
                      onValueChange={(v) => setManagerSellTaxPct(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">Optional additional tax charged on sells. Default is 0%.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-semibold text-lg pb-2">Fee Routing</h3>
                <div className="space-y-2">
                  <Label htmlFor="dest">Primary Fee Destination Wallet</Label>
                  <Input 
                    id="dest" 
                    value={feeDestination}
                    onChange={(e) => setFeeDestination(e.target.value)}
                    className="font-merge-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">Address that receives the Manager's share of revenue, plus whatever isn't routed to a recipient below.</p>
                </div>

                <div className="space-y-3 pt-2">
                  <Label className="flex justify-between items-center">
                    <span>Additional Fee Recipients</span>
                    <span className={`font-merge-mono text-xs ${feeRecipientTotalPct > 100 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {feeRecipientTotalPct.toFixed(1)}% of total fees
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground">Split off a percentage of total fee revenue to other wallets. Whatever's left goes to the primary destination above.</p>

                  {feeRecipients.length > 0 && (
                    <div className="space-y-2">
                      {feeRecipients.map((r) => (
                        <div key={r.address} className="flex items-center justify-between gap-3 p-2 rounded-lg border border-border bg-muted/20">
                          <span className="font-merge-mono text-xs truncate">{r.address}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="secondary" className="font-merge-mono">{r.pct}%</Badge>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeFeeRecipient(r.address)}>
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Input
                      placeholder="Recipient wallet address"
                      className="font-merge-mono text-sm"
                      value={newRecipientAddress}
                      onChange={(e) => setNewRecipientAddress(e.target.value)}
                    />
                    <Input
                      type="number"
                      placeholder="%"
                      className="w-24 font-merge-mono"
                      min="0"
                      max="100"
                      value={newRecipientPct}
                      onChange={(e) => setNewRecipientPct(e.target.value)}
                    />
                    <Button variant="outline" onClick={addFeeRecipient} className="shrink-0 gap-1.5">
                      <Plus className="w-4 h-4" /> Add
                    </Button>
                  </div>
                  {feeRecipientTotalPct > 100 && (
                    <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>Recipient percentages exceed 100% of total fees. Please adjust.</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-semibold text-lg pb-2">Additional Managers</h3>
                <p className="text-xs text-muted-foreground">Add other wallets as Reserve Managers. They'll be able to rebalance, manage fees, and pause the reserve, but won't be able to manage other delegates -- only the root Manager (you) can do that.</p>

                {additionalManagers.length > 0 && (
                  <div className="space-y-2">
                    {additionalManagers.map((address) => (
                      <div key={address} className="flex items-center justify-between gap-3 p-2 rounded-lg border border-border bg-muted/20">
                        <span className="font-merge-mono text-xs truncate">{address}</span>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeManager(address)}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <Input
                    placeholder="Manager wallet address"
                    className="font-merge-mono text-sm"
                    value={newManagerAddress}
                    onChange={(e) => setNewManagerAddress(e.target.value)}
                  />
                  <Button variant="outline" onClick={addManager} className="shrink-0 gap-1.5">
                    <Plus className="w-4 h-4" /> Add
                  </Button>
                </div>
              </div>

            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <Button variant="ghost" onClick={handleBack} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={!initialSeedUsdc || parseFloat(initialSeedUsdc) <= 0 || (!isRealDeployment && parseFloat(initialSeedUsdc) > wallet.usdc) || feeRecipientTotalPct > 100}
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
              <CardTitle className="text-2xl font-merge-display flex items-center gap-2">
                Review & Deploy
                {isRealDeployment && <Badge className="font-merge-mono">Solana DevNet</Badge>}
              </CardTitle>
              <CardDescription>
                {isRealDeployment
                  ? "This will submit real transactions to the deployed SSR Protocol program on Solana DevNet."
                  : "Confirm your reserve parameters before deploying to the protocol."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="bg-muted/50 p-4 border-b border-border flex justify-between items-center">
                  <div>
                    <h3 className="text-xl font-merge-display font-bold">{name}</h3>
                    <Badge variant="secondary" className="font-merge-mono mt-1">{ticker}</Badge>
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
                      <span className="text-muted-foreground">Initial Reserve Value</span>
                      <span className="font-merge-mono font-medium">
                        {formatUsdc(parseFloat(initialSeedUsdc) || 0)}
                        {isRealDeployment && (
                          <span className="text-muted-foreground"> (see Wallet Cost Summary below for the exact SOL requested)</span>
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Mint Fee</span>
                      <span className="font-merge-mono font-medium">{mintFeePct.toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">TVL Fee</span>
                      <span className="font-merge-mono font-medium">{tvlFeePct.toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Buy Tax</span>
                      <span className="font-merge-mono font-medium">{managerBuyTaxPct.toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Sell Tax</span>
                      <span className="font-merge-mono font-medium">{managerSellTaxPct.toFixed(2)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {isRealDeployment && (
                <div className="bg-card border border-primary/30 rounded-xl overflow-hidden">
                  <div className="bg-primary/5 p-4 border-b border-border">
                    <h3 className="font-semibold flex items-center gap-2">
                      Wallet Cost Summary
                      <Tooltip>
                        <TooltipTrigger><Info className="w-3.5 h-3.5 text-muted-foreground" /></TooltipTrigger>
                        <TooltipContent>Every DevNet SOL this wallet will actually be asked to spend, shown before Phantom does.</TooltipContent>
                      </Tooltip>
                    </h3>
                  </div>
                  <div className="p-4 space-y-3">
                    {costEstimateError && (
                      <p className="text-sm text-destructive">{costEstimateError}</p>
                    )}
                    {!costEstimateError && !costEstimate && (
                      <p className="text-sm text-muted-foreground">Estimating costs from live DevNet rent rates...</p>
                    )}
                    {costEstimate && (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Initial Reserve funding</span>
                          <span className="font-merge-mono">
                            {(Number(costEstimate.solSeedFundingLamports) / 1e9).toFixed(5)} SOL
                            {costEstimate.solSeedFundingLamports === 0n && <span className="text-muted-foreground"> (test assets minted for you, no SOL cost)</span>}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Account creation &amp; rent
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>Solana requires new accounts (the Reserve, its assets, vaults, and Reserve Token mint) to be rent-exempt -- this SOL isn't a fee, it stays locked in those accounts.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-merge-mono">{(Number(costEstimate.totalRentLamports) / 1e9).toFixed(5)} SOL</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Estimated network fees ({costEstimate.numTransactions} transactions)</span>
                          <span className="font-merge-mono">{(Number(costEstimate.networkFeeLamportsEstimate) / 1e9).toFixed(5)} SOL</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Protocol fees
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>No fee is charged at creation itself -- Mint Fee ({mintFeePct.toFixed(2)}%) and TVL Fee ({tvlFeePct.toFixed(2)}%) apply to future Buy/holding activity, configured above.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-merge-mono text-muted-foreground">$0.00 now</span>
                        </div>
                        <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                          <span>Estimated total SOL required</span>
                          <span className="font-merge-mono text-primary">
                            {(Number(costEstimate.totalLamports) / 1e9).toFixed(5)} SOL
                            <span className="text-muted-foreground font-normal"> (&asymp; ${((Number(costEstimate.totalLamports) / 1e9) * SOL_TEST_PRICE_USD).toFixed(2)})</span>
                          </span>
                        </div>
                      </>
                    )}
                    <div className="pt-3 border-t border-border/50 space-y-1.5 text-xs text-muted-foreground">
                      <p className="font-semibold text-foreground">This will request {expectedApprovalCount(assets)} wallet approvals:</p>
                      <p>1. Create Reserve + register {assets.length} asset{assets.length === 1 ? "" : "s"} (combined into one transaction)</p>
                      {assets.some((a) => a.symbol === "SOL") && <p>2. Wrap your SOL for the seed deposit</p>}
                      <p>{assets.some((a) => a.symbol === "SOL") ? "3" : "2"}. Seed the Reserve (deposits the assets, mints your initial Reserve Tokens)</p>
                      <p className="pt-1">Expected result: you'll spend the SOL above and receive <span className="font-merge-mono text-foreground">{Math.max(1, Math.floor(parseFloat(initialSeedUsdc) || 10)).toLocaleString()} {ticker || "Reserve"}</span> tokens. Any test-asset amounts appearing and disappearing from your wallet mid-flow (e.g. minted then immediately deposited) are expected intermediate steps, not final balances -- deployment isn't complete until the last step confirms.</p>
                      <p>Newly created tokens can take a few minutes to show a name/symbol in Phantom instead of "Unknown" -- this is a DevNet metadata-indexing delay, not an error.</p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-3">Target Composition</p>
                <div className="space-y-2">
                  {assets.sort((a,b) => b.weight - a.weight).map(asset => (
                    <div key={asset.symbol} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{asset.symbol}</span>
                        <span className="text-muted-foreground text-xs">{asset.name}</span>
                      </div>
                      <span className="font-merge-mono font-bold">{(asset.weight * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  {unallocatedWeight > 0 && (
                    <div className="flex justify-between items-center p-2 rounded border border-dashed border-border/80 text-sm">
                      <span className="text-muted-foreground italic">Unallocated USDC Reserve</span>
                      <span className="font-merge-mono text-muted-foreground">{(unallocatedWeight * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-3">Fee Routing</p>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                    <span className="font-merge-mono text-xs truncate">{feeDestination || wallet.address}</span>
                    <Badge variant="outline" className="bg-background shrink-0">Primary</Badge>
                  </div>
                  {feeRecipients.map((r) => (
                    <div key={r.address} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                      <span className="font-merge-mono text-xs truncate">{r.address}</span>
                      <span className="font-merge-mono font-bold shrink-0">{r.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {additionalManagers.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-muted-foreground mb-3">Additional Managers</p>
                  <div className="space-y-2">
                    {additionalManagers.map((address) => (
                      <div key={address} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                        <span className="font-merge-mono text-xs truncate">{address}</span>
                        <Badge variant="secondary" className="shrink-0">Delegate</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> {createStep ? CREATE_STEP_LABELS[createStep] : "Deploying..."}</>
                ) : (
                  <><Rocket className="w-4 h-4" /> Launch Reserve</>
                )}
              </Button>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  );
}