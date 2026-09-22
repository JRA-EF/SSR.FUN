// A Robinhood Chain reserve's page, reached through the same /dtr/:id route
// as a Solana reserve (ids prefixed "rh-"). Everything shown is read from the
// chain on load: basket, fees, and a USD mark from Uniswap v3 spot prices.
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { ChevronLeft } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { avatarStyle } from "../../../lib/avatarStyle";
import { ROBINHOOD, MULTIPLIER_WARNING } from "@/lib/evmChain";
import {
  approveIfNeeded,
  describeEvmError,
  ERC20_ABI,
  fmtUnits,
  loadReserve,
  mintFeeBreakdown,
  parseAmount,
  pctFromD18,
  publicClientFor,
  quoteMintCost,
  quoteRedeemProceeds,
  SSR_ABI,
  type ReserveSnapshot,
} from "@/lib/evmReserve";
import { connectEvmWallet, useEvmWallet } from "./useEvmWallet";

type Status = { text: string; kind: "ok" | "err" | "busy" } | null;
const cfg = ROBINHOOD;
const pc = publicClientFor(cfg);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const usd = (n: number | null, digits = 2) =>
  n === null ? "Price unavailable" : `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const explorerAddr = (a: string) => `${cfg.explorer}/address/${a}`;
const explorerTx = (h: string) => `${cfg.explorer}/tx/${h}`;

function StatusLine({ status, link }: { status: Status; link?: { href: string; label: string } | null }) {
  if (!status) return null;
  const cls = status.kind === "ok" ? "text-positive" : status.kind === "err" ? "text-destructive" : "text-muted-foreground";
  return (
    <p className={`text-sm mt-3 ${cls}`}>
      {status.text}{" "}
      {link && (
        <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline text-primary">
          {link.label}
        </a>
      )}
    </p>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/60 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right font-merge-mono">{value}</span>
    </div>
  );
}

export function RobinhoodReserveDetail({ address }: { address: Address }) {
  const { wallet, account } = useEvmWallet();
  const [snap, setSnap] = useState<ReserveSnapshot | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  const [myShares, setMyShares] = useState<bigint>(0n);
  const [gas, setGas] = useState<bigint | null>(null);
  const [myAssets, setMyAssets] = useState<{ symbol: string; text: string }[]>([]);

  const [tradeTab, setTradeTab] = useState<"buy" | "sell">("buy");
  const [mintAmt, setMintAmt] = useState("1");
  const [redeemAmt, setRedeemAmt] = useState("1");
  const [mintQuote, setMintQuote] = useState<string[] | null>(null);
  const [mintStatus, setMintStatus] = useState<Status>(null);
  const [mintLink, setMintLink] = useState<{ href: string; label: string } | null>(null);
  const [redeemStatus, setRedeemStatus] = useState<Status>(null);
  const [redeemLink, setRedeemLink] = useState<{ href: string; label: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnap(await loadReserve(pc, cfg, address));
      setLoadErr(null);
    } catch (e) {
      setLoadErr(describeEvmError(e));
    }
  }, [address]);

  const refreshBalances = useCallback(async () => {
    if (!account || !snap) return;
    const [bal, sh, rows] = await Promise.all([
      pc.getBalance({ address: account }),
      pc.readContract({ address, abi: SSR_ABI, functionName: "balanceOf", args: [account] }),
      Promise.all(
        snap.basket.map(async (b) => ({
          symbol: b.symbol,
          text: fmtUnits(await pc.readContract({ address: b.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }), b.decimals, 6),
        })),
      ),
    ]);
    setGas(bal);
    setMyShares(sh);
    setMyAssets(rows);
  }, [account, snap, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  async function connect() {
    setConnectErr(null);
    try {
      await connectEvmWallet();
    } catch (e) {
      setConnectErr(describeEvmError(e));
    }
  }

  const back = (
    <Link href="/discover" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary transition-colors">
      <ChevronLeft className="w-4 h-4 mr-1" /> Back to Directory
    </Link>
  );

  if (loadErr) {
    return (
      <div className="container mx-auto px-4 md:px-8 py-10 space-y-4">
        {back}
        <Card><CardContent className="py-8 text-destructive">Could not load this Robinhood reserve: {loadErr}</CardContent></Card>
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="container mx-auto px-4 md:px-8 py-10 space-y-4">
        {back}
        <Card><CardContent className="py-8 text-muted-foreground">Reading reserve from Robinhood Chain…</CardContent></Card>
      </div>
    );
  }

  const dec = snap.decimals;
  const describe = (assets: readonly Address[], amounts: readonly bigint[]) =>
    assets.map((a, i) => {
      const row = snap.basket.find((b) => b.address.toLowerCase() === a.toLowerCase());
      return `${fmtUnits(amounts[i], row?.decimals ?? 18, 8)} ${row?.symbol ?? short(a)}`;
    });

  async function doQuote() {
    setMintStatus(null);
    try {
      const s = parseAmount(mintAmt, dec, "Shares");
      const [[assets, amounts], fee] = await Promise.all([quoteMintCost(pc, address, s), mintFeeBreakdown(pc, cfg, address, s)]);
      setMintQuote([
        `You pay ${describe(assets, amounts).join(" + ")}`,
        `Fee ${fmtUnits(fee.total, dec, 6)} shares (protocol ${fmtUnits(fee.dao, dec, 6)})`,
        `You receive ${fmtUnits(fee.out, dec, 6)} shares`,
      ]);
      return { s, assets, amounts };
    } catch (e) {
      setMintStatus({ text: describeEvmError(e), kind: "err" });
      return null;
    }
  }

  async function doMint() {
    if (!wallet || !account) return setMintStatus({ text: "Connect a wallet first.", kind: "err" });
    setMintLink(null);
    const q = await doQuote();
    if (!q) return;
    try {
      for (let i = 0; i < q.assets.length; i++) {
        await approveIfNeeded(pc, wallet, cfg, account, q.assets[i], address, q.amounts[i], (m) => setMintStatus({ text: m, kind: "busy" }));
      }
      setMintStatus({ text: "Buying...", kind: "busy" });
      const before = await pc.readContract({ address, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
      const hash = await wallet.writeContract({ address, abi: SSR_ABI, functionName: "mint", args: [q.s, account, 0n], chain: cfg.chain, account });
      await pc.waitForTransactionReceipt({ hash });
      const after = await pc.readContract({ address, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
      await refresh();
      await refreshBalances();
      setMintStatus({ text: `Received ${fmtUnits(after - before, dec, 6)} shares.`, kind: "ok" });
      setMintLink({ href: explorerTx(hash), label: "View transaction" });
    } catch (e) {
      setMintStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  async function doRedeem() {
    if (!wallet || !account) return setRedeemStatus({ text: "Connect a wallet first.", kind: "err" });
    setRedeemLink(null);
    try {
      const s = parseAmount(redeemAmt, dec, "Shares");
      // redeem() requires the asset array to match the basket EXACTLY, in the
      // contract's own order -- so it is read fresh rather than assumed.
      const [assets, amounts] = await quoteRedeemProceeds(pc, address, s);
      setRedeemStatus({ text: "Selling...", kind: "busy" });
      const hash = await wallet.writeContract({
        address,
        abi: SSR_ABI,
        functionName: "redeem",
        args: [s, account, [...assets], assets.map(() => 0n)],
        chain: cfg.chain,
        account,
      });
      await pc.waitForTransactionReceipt({ hash });
      const got = describe(assets, amounts).join(" + ");
      await refresh();
      await refreshBalances();
      setRedeemStatus({ text: `Sold for ${got}.`, kind: "ok" });
      setRedeemLink({ href: explorerTx(hash), label: "View transaction" });
    } catch (e) {
      setRedeemStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  const perShare = (b: ReserveSnapshot["basket"][number]) => (snap.totalSupply === 0n ? 0n : (b.amount * 10n ** BigInt(dec)) / snap.totalSupply);
  const hasStockTokens = snap.basket.some((b) => b.uiMultiplier !== undefined);

  return (
    <div className="container mx-auto px-4 md:px-8 py-10 relative">
      <div className="flex items-center gap-4 mb-6">
        {back}
        <div className="ml-auto">
          <Button onClick={connect} variant={account ? "outline" : "default"}>
            {account ? short(account) : "Connect EVM wallet"}
          </Button>
        </div>
      </div>
      {connectErr && <p className="text-sm text-destructive mb-4">{connectErr}</p>}

      {/* Same two-column shape as a Solana reserve: details and composition on
          the left, a sticky trade panel on the right. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <Card className="relative z-10 bg-card border-card-border">
            <CardHeader className="flex flex-col gap-3 pb-2">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center font-merge-display font-bold text-sm" style={avatarStyle(snap.symbol)}>
                    {snap.symbol.slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-2xl font-merge-display font-bold truncate">{snap.name}</h1>
                      <Badge variant="secondary">{snap.symbol}</Badge>
                      <span className="badge-verified">Live on Robinhood Chain</span>
                    </div>
                    <a href={explorerAddr(address)} target="_blank" rel="noopener noreferrer" className="font-merge-mono text-xs text-muted-foreground hover:text-primary break-all">
                      CA: {address}
                    </a>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Token Price</p>
                  <p className="font-merge-mono font-bold text-2xl">{usd(snap.navPerShare, 4)}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* No price history on Robinhood yet -- say so rather than draw a flat line. */}
              <div className="rounded-lg border border-dashed border-border/60 py-10 text-center text-sm text-muted-foreground">
                Price history isn&rsquo;t indexed for Robinhood Chain yet. The figures here are read live from the chain.
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              ["Market Cap", usd(snap.aumUsd)],
              ["Supply", fmtUnits(snap.totalSupply, dec, 4)],
              ["Assets", String(snap.basket.length)],
              ["Auction cap", `${snap.maxAuctionLength}s`],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent className="py-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
                  <p className="font-merge-mono font-bold text-lg">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {hasStockTokens && (
            <Card className="border-primary/40 bg-primary/10">
              <CardContent className="py-3 text-sm">{MULTIPLIER_WARNING}</CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Composition</CardTitle>
              <CardDescription>Held in kind by the reserve, marked to USDG at Uniswap v3 spot.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead className="text-right">Held</TableHead>
                    <TableHead className="text-right">Per share</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.basket.map((b) => (
                    <TableRow key={b.address}>
                      <TableCell className="font-semibold">
                        <a href={explorerAddr(b.address)} target="_blank" rel="noopener noreferrer" className="hover:text-primary">{b.symbol}</a>
                        {b.uiMultiplier !== undefined && b.uiMultiplier !== 10n ** 18n && (
                          <Badge variant="secondary" className="ml-2" title="ERC-8056 corporate-action multiplier">×{fmtUnits(b.uiMultiplier, 18, 6)}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-merge-mono">{fmtUnits(b.amount, b.decimals, 8)}</TableCell>
                      <TableCell className="text-right font-merge-mono">{fmtUnits(perShare(b), b.decimals, 10)}</TableCell>
                      <TableCell className="text-right font-merge-mono">{usd(b.usd)}</TableCell>
                      <TableCell className="text-right font-merge-mono">
                        {b.usd !== null && snap.aumUsd ? `${((b.usd / snap.aumUsd) * 100).toFixed(1)}%` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Fees</CardTitle>
              <CardDescription>Read live from the chain.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <Row label="Mint fee" value={pctFromD18(snap.mintFee)} />
              <Row label="Protocol share of it" value={`${fmtUnits(snap.daoFeeBps, 2, 2)}%`} />
              <Row label="Protocol floor" value={pctFromD18(snap.feeFloor)} />
            </CardContent>
          </Card>
        </div>

        {/* Right column: the trade panel, same position and behaviour as Solana's. */}
        <div className="lg:col-span-1">
          <div className="sticky top-24 z-20 space-y-4">
            <Card className="border-border shadow-xl bg-card">
              <Tabs value={tradeTab} onValueChange={(v) => setTradeTab(v as "buy" | "sell")} className="w-full">
                <CardHeader className="pb-4">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="buy" className="buy-tab font-bold data-[state=active]:text-primary">Buy</TabsTrigger>
                    <TabsTrigger value="sell" className="font-bold data-[state=active]:text-destructive">Sell</TabsTrigger>
                  </TabsList>
                </CardHeader>
                <CardContent>
                  <TabsContent value="buy" className="mt-0 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      In kind: you deposit every basket asset in proportion and receive shares.
                    </p>
                    <div>
                      <Label htmlFor="rh-mint">Shares to buy</Label>
                      <Input id="rh-mint" value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} inputMode="decimal" />
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={doQuote}>Quote</Button>
                      <Button className="flex-1" onClick={doMint}>Buy</Button>
                    </div>
                    {mintQuote && (
                      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1">
                        {mintQuote.map((l) => <p key={l}>{l}</p>)}
                      </div>
                    )}
                    <StatusLine status={mintStatus} link={mintLink} />
                  </TabsContent>

                  <TabsContent value="sell" className="mt-0 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      In kind: you burn shares and receive every basket asset in proportion.
                    </p>
                    <div>
                      <Label htmlFor="rh-redeem">Shares to sell</Label>
                      <Input id="rh-redeem" value={redeemAmt} onChange={(e) => setRedeemAmt(e.target.value)} inputMode="decimal" />
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setRedeemAmt(fmtUnits(myShares, dec, 18))} disabled={!account}>Max</Button>
                      <Button className="flex-1" onClick={doRedeem}>Sell</Button>
                    </div>
                    <StatusLine status={redeemStatus} link={redeemLink} />
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>

            <Card className="bg-card/60">
              <CardHeader className="pb-2"><CardTitle className="text-base">Your Position</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {!account ? (
                  <p className="text-muted-foreground">Connect an EVM wallet to see your balances.</p>
                ) : (
                  <>
                    <Row label="Your shares" value={fmtUnits(myShares, dec, 6)} />
                    <Row
                      label="Gas (ETH)"
                      value={<span className={gas === 0n ? "text-destructive" : ""}>{gas === null ? "—" : fmtUnits(gas, 18, 6)}</span>}
                    />
                    {myAssets.map((a) => <Row key={a.symbol} label={a.symbol} value={a.text} />)}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
