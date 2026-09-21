// The Robinhood Chain branch of the Create page. Every reserve is its own
// contract deployed through the SSR factory; the creator supplies the starting
// basket from their own wallet.
import { useState } from "react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [rows, setRows] = useState<{ address: string; amount: string }[]>(() => cfg.assets.slice(0, 2).map((a) => ({ address: a.address, amount: "" })));
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>(null);

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
        if (!r.amount.trim()) continue;
        const asset = cfg.assets.find((a) => a.address.toLowerCase() === r.address.toLowerCase());
        if (!asset) throw new Error("Unknown asset selected.");
        if (legs.some((l) => l.asset.address.toLowerCase() === r.address.toLowerCase())) throw new Error(`${asset.symbol} is listed twice.`);
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
    <Card>
      <CardHeader>
        <CardTitle>Launch a Reserve on Robinhood Chain</CardTitle>
        <CardDescription>
          Each reserve is its own contract, deployed through the SSR factory. You supply the starting basket from your
          wallet &mdash; those assets become the reserve&rsquo;s holdings and you receive its initial shares.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant={account ? "outline" : "default"} onClick={connect}>{account ? short(account) : "Connect EVM wallet"}</Button>
          {account && <span className="text-sm text-muted-foreground">Connected to Robinhood Chain</span>}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="rhc-name">Name</Label>
            <Input id="rhc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Strategic Tech Reserve" />
          </div>
          <div>
            <Label htmlFor="rhc-symbol">Ticker</Label>
            <Input id="rhc-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="TECHSSR" />
          </div>
        </div>

        <div>
          <Label>Starting basket</Label>
          <div className="space-y-2 mt-1">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.4fr_1fr_auto] gap-2 items-center">
                <select
                  value={r.address}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))}
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                >
                  {cfg.assets.map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.symbol}
                      {a.note ? ` — ${a.note}` : ""}
                      {balances[a.address] ? ` (you hold ${balances[a.address]})` : ""}
                    </option>
                  ))}
                </select>
                <Input value={r.amount} inputMode="decimal" placeholder="Amount" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" onClick={() => rows.length > 1 && setRows(rows.filter((_, j) => j !== i))} aria-label="Remove asset">
                  ×
                </Button>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setRows([...rows, { address: cfg.assets[0].address, amount: "" }])}>
            Add asset
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="rhc-shares">Initial shares</Label>
            <Input id="rhc-shares" value={initialShares} onChange={(e) => setInitialShares(e.target.value)} inputMode="decimal" />
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
          New reserves use <b>atomic-swap pricing</b> and a <b>{String(SAFE_REBALANCE_DEFAULTS.maxAuctionLength)}s auction cap</b>, so a
          rebalance price can&rsquo;t go stale across a stock token&rsquo;s corporate action. The protocol fee rule (50% of the mint fee
          to the DAO, 0.5% floor) is applied by the chain.
        </div>

        <Button size="lg" onClick={submit}>Launch Reserve</Button>
        {status && (
          <p className={`text-sm ${status.kind === "ok" ? "text-positive" : status.kind === "err" ? "text-destructive" : "text-muted-foreground"}`}>{status.text}</p>
        )}
      </CardContent>
    </Card>
  );
}
