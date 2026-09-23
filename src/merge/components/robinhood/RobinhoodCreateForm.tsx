// The Robinhood Chain branch of the Create page. Every reserve is its own
// contract deployed through the SSR factory; the creator supplies the starting
// basket from their own wallet.
import { useState } from "react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LaunchHeader, LaunchStepper } from "@/components/LaunchStepper";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ERC20_ABI, LIMITS, ROBINHOOD, SAFE_REBALANCE_DEFAULTS, type AssetRef } from "@/lib/evmChain";
import { createReserve, describeEvmError, fmtUnits, parseAmount, parsePercentToD18, pctFromD18, publicClientFor, rhReserveId } from "@/lib/evmReserve";
import { invalidateRobinhoodReserves } from "@/hooks/useRobinhoodReserves";
import { connectEvmWallet, useEvmWallet } from "./useEvmWallet";

const cfg = ROBINHOOD;
const pc = publicClientFor(cfg);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
type Status = { text: string; kind: "ok" | "err" | "busy" } | null;

export function RobinhoodCreateForm() {
  const { wallet, account } = useEvmWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [initialShares, setInitialShares] = useState("10");
  const [mintFeePct, setMintFeePct] = useState("1");
  const [tvlFeePct, setTvlFeePct] = useState("1");
  const [owner, setOwner] = useState("");
  // Rows hold the TYPED ticker, resolved against the full asset list on
  // submit -- 281 tokens is far too many for a <select>, so this is a
  // type-to-filter input backed by a datalist.
  const [rows, setRows] = useState<{ symbol: string; amount: string }[]>(() => [
    { symbol: "USDG", amount: "" },
    { symbol: "", amount: "" },
  ]);
  const findAsset = (symbol: string) => cfg.assets.find((a) => a.symbol.toLowerCase() === symbol.trim().toLowerCase());
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>(null);
  const [step, setStep] = useState(1);

  /** Blocks Next until the current step is actually answerable. */
  function stepError(atStep: number): string | null {
    if (atStep === 1) {
      if (!name.trim()) return "Give the reserve a name.";
      if (!symbol.trim()) return "Give the reserve a ticker.";
      return null;
    }
    if (atStep === 2) {
      const filled = rows.filter((r) => r.symbol.trim() || r.amount.trim());
      if (filled.length === 0) return "Add at least one asset.";
      for (const r of filled) {
        const a = findAsset(r.symbol);
        if (!a) return `"${r.symbol.trim() || "(blank)"}" is not a token on Robinhood Chain.`;
        if (!r.amount.trim()) return `Enter an amount for ${a.symbol}.`;
      }
      return null;
    }
    return null;
  }

  function next() {
    const e = stepError(step);
    if (e) return setStatus({ text: e, kind: "err" });
    setStatus(null);
    setStep((v) => Math.min(4, v + 1));
  }
  const back = () => {
    setStatus(null);
    setStep((v) => Math.max(1, v - 1));
  };

  const legsPreview = rows
    .map((r) => ({ asset: findAsset(r.symbol), amount: r.amount }))
    .filter((l): l is { asset: AssetRef; amount: string } => !!l.asset && !!l.amount.trim());

  async function connect() {
    try {
      await connectEvmWallet();
      await loadBalances();
    } catch (e) {
      setStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  /** Shows what the connected wallet actually holds, so a basket isn't sized blind. */
  async function loadBalances(acct = account) {
    if (!acct) return;
    const entries = await Promise.all(
      cfg.assets.map(async (a) => [a.address, fmtUnits(await pc.readContract({ address: a.address, abi: ERC20_ABI, functionName: "balanceOf", args: [acct] }), a.decimals, 8)] as const),
    );
    setBalances(Object.fromEntries(entries));
  }

  async function submit() {
    if (!wallet || !account) return setStatus({ text: "Connect an EVM wallet first.", kind: "err" });
    try {
      if (!name.trim()) throw new Error("Give the reserve a name.");
      if (!symbol.trim()) throw new Error("Give the reserve a ticker.");

      const legs: { asset: AssetRef; amount: bigint }[] = [];
      for (const r of rows) {
        if (!r.symbol.trim() && !r.amount.trim()) continue;
        const asset = findAsset(r.symbol);
        if (!asset) throw new Error(`"${r.symbol.trim() || "(blank)"}" is not a token on Robinhood Chain. Type a ticker such as NVDA.`);
        if (legs.some((l) => l.asset.address.toLowerCase() === asset.address.toLowerCase())) throw new Error(`${asset.symbol} is listed twice.`);
        legs.push({ asset, amount: parseAmount(r.amount, asset.decimals, `${asset.symbol} amount`) });
      }
      if (legs.length === 0) throw new Error("Add at least one asset with an amount.");

      const mintFee = parsePercentToD18(mintFeePct, "Mint fee");
      const tvlFee = parsePercentToD18(tvlFeePct, "TVL fee");
      if (mintFee > LIMITS.MAX_MINT_FEE) throw new Error(`Mint fee cannot exceed ${pctFromD18(LIMITS.MAX_MINT_FEE, 2)}.`);
      if (mintFee !== 0n && mintFee < LIMITS.MIN_MINT_FEE) throw new Error(`A non-zero mint fee must be at least ${pctFromD18(LIMITS.MIN_MINT_FEE, 2)}.`);
      if (tvlFee > LIMITS.MAX_TVL_FEE) throw new Error(`TVL fee cannot exceed ${pctFromD18(LIMITS.MAX_TVL_FEE, 2)} a year.`);

      const ownerAddr = (owner.trim() || account) as Address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddr)) throw new Error("Owner must be a valid address.");

      const { reserve } = await createReserve(
        pc,
        wallet,
        cfg,
        account,
        { name: name.trim(), symbol: symbol.trim(), legs, initialShares: parseAmount(initialShares, 18, "Initial shares"), mintFee, tvlFee, owner: ownerAddr },
        (m) => setStatus({ text: m, kind: "busy" }),
      );
      invalidateRobinhoodReserves();
      window.location.hash = `#/dtr/${rhReserveId(reserve)}`;
    } catch (e) {
      setStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  return (
    <div>
      <LaunchHeader subtitle="Launch a new Reserve on SSR.FUN, live on Robinhood Chain." />
      <LaunchStepper step={step} />

      <Card className="border-border/60 shadow-lg">
        {step === 1 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-merge-display">Reserve Identity</CardTitle>
              <CardDescription>Define the basic information for your new reserve.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center gap-3 flex-wrap">
                <Button variant={account ? "outline" : "default"} onClick={connect}>
                  {account ? short(account) : "Connect EVM wallet"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {account ? "Connected to Robinhood Chain" : "You can fill this in first and connect before launching."}
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="rhc-name">Reserve Name</Label>
                  <Input id="rhc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Strategic Tech Reserve" />
                </div>
                <div>
                  <Label htmlFor="rhc-symbol">Ticker</Label>
                  <Input id="rhc-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="E.G. TECHSSR" />
                </div>
              </div>
            </CardContent>
          </>
        )}

        {step === 2 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-merge-display">Basket Composition</CardTitle>
              <CardDescription>
                Any of the {cfg.assets.length} tokens on Robinhood Chain &mdash; stock tokens, ETFs, USDG or WETH. Start typing a
                ticker. These assets leave your wallet and become the reserve&rsquo;s holdings.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {rows.map((r, i) => {
                const asset = findAsset(r.symbol);
                const unknown = r.symbol.trim().length > 0 && !asset;
                return (
                  <div key={i} className="grid grid-cols-[1.4fr_1fr_auto] gap-2 items-start">
                    <div>
                      <Input
                        value={r.symbol}
                        list="rh-asset-tickers"
                        autoComplete="off"
                        placeholder="Ticker (e.g. NVDA)"
                        aria-invalid={unknown}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, symbol: e.target.value.toUpperCase() } : x)))}
                      />
                      <p className={`text-xs mt-1 ${unknown ? "text-destructive" : "text-muted-foreground"}`}>
                        {asset
                          ? `${asset.note ?? asset.symbol}${balances[asset.address] ? ` \u00b7 you hold ${balances[asset.address]}` : ""}`
                          : unknown
                            ? "Not a token on Robinhood Chain"
                            : "\u00a0"}
                      </p>
                    </div>
                    <Input
                      value={r.amount}
                      inputMode="decimal"
                      placeholder="Amount"
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    />
                    <Button variant="ghost" size="icon" onClick={() => rows.length > 1 && setRows(rows.filter((_, j) => j !== i))} aria-label="Remove asset">
                      &times;
                    </Button>
                  </div>
                );
              })}
              {/* One datalist for every row: the browser filters, so hundreds of
                  tickers stay usable without a bespoke combobox. */}
              <datalist id="rh-asset-tickers">
                {cfg.assets.map((a) => (
                  <option key={a.address} value={a.symbol}>
                    {a.note ?? a.symbol}
                  </option>
                ))}
              </datalist>
              <Button variant="outline" size="sm" onClick={() => setRows([...rows, { symbol: "", amount: "" }])}>
                Add asset
              </Button>
            </CardContent>
          </>
        )}

        {step === 3 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-merge-display">Economics</CardTitle>
              <CardDescription>Fees and the opening share count.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="rhc-shares">Initial shares</Label>
                  <Input id="rhc-shares" value={initialShares} onChange={(e) => setInitialShares(e.target.value)} inputMode="decimal" />
                  <p className="text-xs text-muted-foreground mt-1">Sets the opening price per share against the basket you funded.</p>
                </div>
                <div>
                  <Label htmlFor="rhc-mintfee">Mint fee (%)</Label>
                  <Input id="rhc-mintfee" value={mintFeePct} onChange={(e) => setMintFeePct(e.target.value)} inputMode="decimal" />
                </div>
                <div>
                  <Label htmlFor="rhc-tvlfee">Annual TVL fee (%)</Label>
                  <Input id="rhc-tvlfee" value={tvlFeePct} onChange={(e) => setTvlFeePct(e.target.value)} inputMode="decimal" />
                </div>
                <div>
                  <Label htmlFor="rhc-owner">Manager</Label>
                  <Input id="rhc-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="defaults to your wallet" />
                </div>
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
                The protocol fee rule (50% of the mint fee to the DAO, 0.5% floor) is applied by the chain.
              </div>
            </CardContent>
          </>
        )}

        {step === 4 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-merge-display">Review &amp; Launch</CardTitle>
              <CardDescription>Check it over. Launching deploys a contract and moves these assets out of your wallet.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-2">Identity</p>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span className="font-medium">{name}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Ticker</span><span className="font-medium font-merge-mono">{symbol}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Chain</span><span className="font-medium">Robinhood Chain</span></div>
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-2">Starting basket</p>
                <div className="text-sm space-y-1">
                  {legsPreview.map((l) => (
                    <div key={l.asset.address} className="flex justify-between">
                      <span className="text-muted-foreground">{l.asset.symbol} <span className="text-xs">{l.asset.note}</span></span>
                      <span className="font-medium font-merge-mono">{l.amount}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-2">Economics</p>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Initial shares</span><span className="font-medium font-merge-mono">{initialShares}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Mint fee</span><span className="font-medium font-merge-mono">{mintFeePct}%</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Annual TVL fee</span><span className="font-medium font-merge-mono">{tvlFeePct}%</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Manager</span><span className="font-medium font-merge-mono">{owner.trim() ? short(owner.trim()) : account ? short(account) : "your wallet"}</span></div>
                </div>
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
                New reserves use <b>atomic-swap pricing</b> and a <b>{String(SAFE_REBALANCE_DEFAULTS.maxAuctionLength)}s auction cap</b>, so a
                rebalance price can&rsquo;t go stale across a stock token&rsquo;s corporate action.
              </div>
              {!account && <p className="text-sm text-muted-foreground">Connect an EVM wallet to launch.</p>}
            </CardContent>
          </>
        )}

        <CardFooter className="flex items-center justify-between gap-3 border-t border-border/60 pt-5">
          <Button variant="outline" onClick={back} disabled={step === 1}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          {step < 4 ? (
            <Button onClick={next}>
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={submit} disabled={!account}>Launch Reserve</Button>
          )}
        </CardFooter>
      </Card>

      {status && (
        <p className={`text-sm mt-4 ${status.kind === "ok" ? "text-positive" : status.kind === "err" ? "text-destructive" : "text-muted-foreground"}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}
