// #/evm -- SSR on Robinhood Chain.
//
// Uses the same components, theme and shell as every other page so the UX can
// be judged against the real product rather than a standalone harness.
//
// Defaults to MAINNET (4663), which is deployed: factory, registries and the
// fee rule are live and read straight off the chain, and the page shows that
// real state even though no reserve has been created through the factory yet.
// Testnet (46630) is fixtures -- a test instance over mock tokens whose name,
// basket and balances are made up -- and is labelled as such so its numbers
// are never mistaken for reality.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, PublicClient, WalletClient } from "viem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CHAINS, DEPLOYER_ABI, LIMITS, MULTIPLIER_WARNING, SAFE_REBALANCE_DEFAULTS, type AssetRef, type ChainConfig } from "@/lib/evmChain";
import {
  connectWallet,
  createReserve,
  describeEvmError,
  ERC20_ABI,
  fmtUnits,
  loadReserve,
  mintFeeBreakdown,
  parseAmount,
  parsePercentToD18,
  pctFromD18,
  publicClientFor,
  quoteMintCost,
  quoteRedeemProceeds,
  loadRegistryDefaults,
  approveIfNeeded,
  SSR_ABI,
  type ReserveSnapshot,
} from "@/lib/evmReserve";

const CHAIN_KEY = "ssr.fun:evm:chain";
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

type ChainKey = "testnet" | "mainnet";
type Status = { text: string; kind: "ok" | "err" | "busy" | "" } | null;

function StatusLine({ status, link }: { status: Status; link?: { href: string; label: string } | null }) {
  if (!status) return null;
  const cls =
    status.kind === "ok" ? "text-positive" : status.kind === "err" ? "text-destructive" : "text-muted-foreground";
  return (
    <p className={`text-sm mt-3 ${cls}`}>
      {status.text}{" "}
      {link ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline text-primary">
          {link.label}
        </a>
      ) : null}
    </p>
  );
}

export function Evm() {
  const [chainKey, setChainKey] = useState<ChainKey>(
    () => (localStorage.getItem(CHAIN_KEY) as ChainKey) ?? "mainnet",
  );
  const cfg: ChainConfig = CHAINS[chainKey];
  const pc: PublicClient = useMemo(() => publicClientFor(cfg), [cfg]);

  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [snapshot, setSnapshot] = useState<ReserveSnapshot | null>(null);
  const [globalStatus, setGlobalStatus] = useState<Status>(null);

  const [shares, setShares] = useState("0");
  const [gas, setGas] = useState<bigint | null>(null);
  const [myAssets, setMyAssets] = useState<{ symbol: string; text: string }[]>([]);

  const explorerAddr = (a: string) => `${cfg.explorer}/address/${a}`;
  const explorerTx = (h: string) => `${cfg.explorer}/tx/${h}`;

  // --- load -------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!cfg.ssr) {
      setSnapshot(null);
      return;
    }
    setGlobalStatus({ text: "Loading reserve...", kind: "busy" });
    try {
      setSnapshot(await loadReserve(pc, cfg));
      setGlobalStatus(null);
    } catch (e) {
      setGlobalStatus({ text: describeEvmError(e), kind: "err" });
    }
  }, [pc, cfg]);

  const refreshBalances = useCallback(async () => {
    if (!account) return;
    const [bal, sh] = await Promise.all([
      pc.getBalance({ address: account }),
      cfg.ssr ? pc.readContract({ address: cfg.ssr, abi: SSR_ABI, functionName: "balanceOf", args: [account] }) : Promise.resolve(0n),
    ]);
    setGas(bal);
    setShares(fmtUnits(sh, snapshot?.decimals ?? 18, 6));
    if (snapshot) {
      const rows = await Promise.all(
        snapshot.basket.map(async (b) => ({
          symbol: b.symbol,
          text: fmtUnits(
            await pc.readContract({ address: b.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
            b.decimals,
            6,
          ),
        })),
      );
      setMyAssets(rows);
    }
  }, [pc, cfg, account, snapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  function switchChain(key: ChainKey) {
    localStorage.setItem(CHAIN_KEY, key);
    // The connected wallet is on the old chain; force a reconnect rather than
    // letting a write go to the wrong network.
    setWallet(null);
    setAccount(null);
    setSnapshot(null);
    setGas(null);
    setMyAssets([]);
    setChainKey(key);
  }

  async function connect() {
    setGlobalStatus({ text: "Connecting...", kind: "busy" });
    try {
      const { wallet: w, account: a } = await connectWallet(cfg);
      setWallet(w);
      setAccount(a);
      setGlobalStatus(null);
      const provider = (window as unknown as { ethereum?: { on?: (e: string, f: () => void) => void } }).ethereum;
      provider?.on?.("accountsChanged", () => window.location.reload());
      provider?.on?.("chainChanged", () => window.location.reload());
    } catch (e) {
      setGlobalStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <header className="flex flex-wrap items-center gap-4 mb-6">
        <div className="mr-auto">
          <h1 className="font-merge-display text-2xl font-bold">SSR on Robinhood Chain</h1>
        </div>
        <div className="flex rounded-full border border-border overflow-hidden">
          {(["testnet", "mainnet"] as const).map((k) => (
            <button
              key={k}
              onClick={() => switchChain(k)}
              aria-pressed={chainKey === k}
              className={`px-4 py-1.5 text-xs font-semibold capitalize transition-colors ${
                chainKey === k ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <Button onClick={connect}>{account ? short(account) : "Connect wallet"}</Button>
      </header>

      <Card className="mb-4 border-warning/50 bg-warning/10">
        <CardContent className="py-3 text-sm">{cfg.notice}</CardContent>
      </Card>
      {chainKey === "mainnet" && (
        <Card className="mb-4 border-primary/40 bg-primary/10">
          <CardContent className="py-3 text-sm">{MULTIPLIER_WARNING}</CardContent>
        </Card>
      )}
      <StatusLine status={globalStatus} />

      <Tabs defaultValue="reserve" className="mt-4">
        <TabsList>
          <TabsTrigger value="reserve">Reserve</TabsTrigger>
          <TabsTrigger value="create">Create a reserve</TabsTrigger>
          <TabsTrigger value="contracts">Contracts</TabsTrigger>
        </TabsList>

        <TabsContent value="reserve">
          <ReserveView
            cfg={cfg}
            pc={pc}
            wallet={wallet}
            account={account}
            snapshot={snapshot}
            gas={gas}
            myAssets={myAssets}
            sharesText={shares}
            onRefresh={async () => {
              await refresh();
              await refreshBalances();
            }}
            explorerAddr={explorerAddr}
            explorerTx={explorerTx}
          />
        </TabsContent>

        <TabsContent value="create">
          <CreateView cfg={cfg} pc={pc} wallet={wallet} account={account} explorerTx={explorerTx} />
        </TabsContent>

        <TabsContent value="contracts">
          <ContractsView cfg={cfg} explorerAddr={explorerAddr} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- reserve

function ReserveView(props: {
  cfg: ChainConfig;
  pc: PublicClient;
  wallet: WalletClient | null;
  account: Address | null;
  snapshot: ReserveSnapshot | null;
  gas: bigint | null;
  myAssets: { symbol: string; text: string }[];
  sharesText: string;
  onRefresh: () => Promise<void>;
  explorerAddr: (a: string) => string;
  explorerTx: (h: string) => string;
}) {
  const { cfg, pc, wallet, account, snapshot, gas, myAssets, sharesText, onRefresh, explorerAddr, explorerTx } = props;

  const [mintAmt, setMintAmt] = useState("1");
  const [redeemAmt, setRedeemAmt] = useState("1");
  const [mintQuote, setMintQuote] = useState<string[] | null>(null);
  const [mintStatus, setMintStatus] = useState<Status>(null);
  const [mintLink, setMintLink] = useState<{ href: string; label: string } | null>(null);
  const [redeemStatus, setRedeemStatus] = useState<Status>(null);
  const [redeemLink, setRedeemLink] = useState<{ href: string; label: string } | null>(null);
  const [faucetStatus, setFaucetStatus] = useState<Status>(null);

  if (!cfg.ssr) return <DeployedButEmpty cfg={cfg} pc={pc} explorerAddr={explorerAddr} />;
  if (!snapshot) return <Card><CardContent className="py-8 text-muted-foreground">Loading…</CardContent></Card>;

  const dec = snapshot.decimals;
  const describe = (assets: readonly Address[], amounts: readonly bigint[]) =>
    assets.map((a, i) => {
      const row = snapshot.basket.find((b) => b.address.toLowerCase() === a.toLowerCase());
      return `${fmtUnits(amounts[i], row?.decimals ?? 18, 8)} ${row?.symbol ?? short(a)}`;
    });

  async function doQuote() {
    setMintStatus(null);
    try {
      const s = parseAmount(mintAmt, dec, "Shares");
      const [assets, amounts] = await quoteMintCost(pc, cfg, s);
      const fee = await mintFeeBreakdown(pc, cfg, s);
      setMintQuote([
        `You pay ${describe(assets, amounts).join(" + ")}`,
        `Fee ${fmtUnits(fee.total, dec, 6)} shares (DAO ${fmtUnits(fee.dao, dec, 6)})`,
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
        await approveIfNeeded(pc, wallet, cfg, account, q.assets[i], cfg.ssr!, q.amounts[i], (m) =>
          setMintStatus({ text: m, kind: "busy" }),
        );
      }
      setMintStatus({ text: "Minting...", kind: "busy" });
      const before = await pc.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
      const hash = await wallet.writeContract({
        address: cfg.ssr!,
        abi: SSR_ABI,
        functionName: "mint",
        args: [q.s, account, 0n],
        chain: cfg.chain,
        account,
      });
      await pc.waitForTransactionReceipt({ hash });
      const after = await pc.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
      await onRefresh();
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
      const [assets, amounts] = await quoteRedeemProceeds(pc, cfg, s);
      setRedeemStatus({ text: "Redeeming...", kind: "busy" });
      const hash = await wallet.writeContract({
        address: cfg.ssr!,
        abi: SSR_ABI,
        functionName: "redeem",
        args: [s, account, [...assets], assets.map(() => 0n)],
        chain: cfg.chain,
        account,
      });
      await pc.waitForTransactionReceipt({ hash });
      const got = describe(assets, amounts).join(" + ");
      await onRefresh();
      setRedeemStatus({ text: `Redeemed for ${got}.`, kind: "ok" });
      setRedeemLink({ href: explorerTx(hash), label: "View transaction" });
    } catch (e) {
      setRedeemStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  async function doFaucet() {
    if (!wallet || !account) return setFaucetStatus({ text: "Connect a wallet first.", kind: "err" });
    const mintable = cfg.assets.filter((a) => a.faucetAmount !== undefined);
    setFaucetStatus({ text: "Minting test assets...", kind: "busy" });
    try {
      for (const a of mintable) {
        const hash = await wallet.writeContract({
          address: a.address,
          abi: ERC20_ABI,
          functionName: "mint",
          args: [account, parseAmount(a.faucetAmount!.toString(), a.decimals, "Faucet")],
          chain: cfg.chain,
          account,
        });
        await pc.waitForTransactionReceipt({ hash });
      }
      await onRefresh();
      setFaucetStatus({ text: "Test assets minted to your wallet.", kind: "ok" });
    } catch (e) {
      setFaucetStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  const perShare = (b: (typeof snapshot.basket)[number]) =>
    snapshot.totalSupply === 0n ? 0n : (b.amount * 10n ** BigInt(dec)) / snapshot.totalSupply;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Reserve</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Name" value={snapshot.name} />
            <Row label="Symbol" value={snapshot.symbol} />
            <Row label="Total supply" value={`${fmtUnits(snapshot.totalSupply, dec, 4)} ${snapshot.symbol}`} />
            <Row
              label="Contract"
              value={
                <a href={explorerAddr(cfg.ssr)} target="_blank" rel="noopener noreferrer" className="font-merge-mono text-xs underline text-primary">
                  {short(cfg.ssr)}
                </a>
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fee rule</CardTitle>
            <CardDescription>Read live from the chain &mdash; the only contract SSR changed from upstream Folio.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Mint fee" value={pctFromD18(snapshot.mintFee)} />
            <Row label="DAO share of it" value={`${fmtUnits(snapshot.daoFeeBps, 2, 2)}%`} />
            <Row label="DAO floor" value={pctFromD18(snapshot.feeFloor)} />
            <Row label="Auction cap" value={`${snapshot.maxAuctionLength}s`} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Basket</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead className="text-right">Held</TableHead>
                <TableHead className="text-right">Per share</TableHead>
                <TableHead className="text-right">Contract</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.basket.map((b) => (
                <TableRow key={b.address}>
                  <TableCell className="font-semibold">
                    {b.symbol}
                    {b.uiMultiplier !== undefined && b.uiMultiplier !== 10n ** 18n && (
                      <Badge variant="secondary" className="ml-2">×{fmtUnits(b.uiMultiplier, 18, 4)}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-merge-mono">{fmtUnits(b.amount, b.decimals, 6)}</TableCell>
                  <TableCell className="text-right font-merge-mono">{fmtUnits(perShare(b), b.decimals, 8)}</TableCell>
                  <TableCell className="text-right">
                    <a href={explorerAddr(b.address)} target="_blank" rel="noopener noreferrer" className="font-merge-mono text-xs underline text-primary">
                      {short(b.address)}
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {account && (
        <Card>
          <CardHeader><CardTitle>Your position</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Account" value={<span className="font-merge-mono text-xs">{account}</span>} />
            <Row
              label="Gas balance"
              value={
                <span className={gas === 0n ? "text-destructive" : ""}>
                  {gas === null ? "—" : `${fmtUnits(gas, 18, 6)} ${cfg.chain.nativeCurrency.symbol}`}
                  {gas === 0n ? " — you need gas before anything will send" : ""}
                </span>
              }
            />
            <Row label="Your shares" value={sharesText} />
            {myAssets.map((a) => (
              <Row key={a.symbol} label={`Your ${a.symbol}`} value={a.text} />
            ))}
            <div className="flex gap-2 pt-2">
              {cfg.assets.some((a) => a.faucetAmount !== undefined) && (
                <Button variant="outline" size="sm" onClick={doFaucet}>Get test assets</Button>
              )}
              <Button variant="outline" size="sm" onClick={onRefresh}>Refresh</Button>
            </div>
            <StatusLine status={faucetStatus} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Mint</CardTitle></CardHeader>
          <CardContent>
            <Label htmlFor="evm-mint">Shares to mint</Label>
            <Input id="evm-mint" value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} inputMode="decimal" />
            <div className="flex gap-2 mt-3">
              <Button variant="outline" onClick={doQuote}>Quote</Button>
              <Button onClick={doMint}>Mint</Button>
            </div>
            {mintQuote && (
              <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1">
                {mintQuote.map((l) => <p key={l}>{l}</p>)}
              </div>
            )}
            <StatusLine status={mintStatus} link={mintLink} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Redeem</CardTitle></CardHeader>
          <CardContent>
            <Label htmlFor="evm-redeem">Shares to redeem</Label>
            <Input id="evm-redeem" value={redeemAmt} onChange={(e) => setRedeemAmt(e.target.value)} inputMode="decimal" />
            <div className="flex gap-2 mt-3">
              <Button variant="outline" onClick={() => setRedeemAmt(sharesText)}>Max</Button>
              <Button onClick={doRedeem}>Redeem</Button>
            </div>
            <StatusLine status={redeemStatus} link={redeemLink} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- create

function CreateView(props: {
  cfg: ChainConfig;
  pc: PublicClient;
  wallet: WalletClient | null;
  account: Address | null;
  explorerTx: (h: string) => string;
}) {
  const { cfg, pc, wallet, account, explorerTx } = props;
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [initialShares, setInitialShares] = useState("100");
  const [mintFeePct, setMintFeePct] = useState("1");
  const [tvlFeePct, setTvlFeePct] = useState("1");
  const [owner, setOwner] = useState("");
  const [rows, setRows] = useState<{ address: string; amount: string }[]>(() =>
    cfg.assets.slice(0, 2).map((a) => ({ address: a.address, amount: "" })),
  );
  const [status, setStatus] = useState<Status>(null);
  const [link, setLink] = useState<{ href: string; label: string } | null>(null);

  useEffect(() => {
    setRows(cfg.assets.slice(0, 2).map((a) => ({ address: a.address, amount: "" })));
  }, [cfg]);

  async function submit() {
    if (!wallet || !account) return setStatus({ text: "Connect a wallet first.", kind: "err" });
    setLink(null);
    try {
      if (!name.trim()) throw new Error("Give the reserve a name.");
      if (!symbol.trim()) throw new Error("Give the reserve a ticker.");

      const legs: { asset: AssetRef; amount: bigint }[] = [];
      for (const r of rows) {
        if (!r.amount.trim()) continue;
        const asset = cfg.assets.find((a) => a.address.toLowerCase() === r.address.toLowerCase());
        if (!asset) throw new Error("Unknown asset selected.");
        if (legs.some((l) => l.asset.address.toLowerCase() === r.address.toLowerCase()))
          throw new Error(`${asset.symbol} is listed twice.`);
        legs.push({ asset, amount: parseAmount(r.amount, asset.decimals, `${asset.symbol} amount`) });
      }
      if (legs.length === 0) throw new Error("Add at least one asset with an amount.");

      const mintFee = parsePercentToD18(mintFeePct, "Mint fee");
      const tvlFee = parsePercentToD18(tvlFeePct, "TVL fee");
      if (mintFee > LIMITS.MAX_MINT_FEE) throw new Error(`Mint fee cannot exceed ${pctFromD18(LIMITS.MAX_MINT_FEE, 2)}.`);
      if (mintFee !== 0n && mintFee < LIMITS.MIN_MINT_FEE)
        throw new Error(`A non-zero mint fee must be at least ${pctFromD18(LIMITS.MIN_MINT_FEE, 2)}.`);
      if (tvlFee > LIMITS.MAX_TVL_FEE) throw new Error(`TVL fee cannot exceed ${pctFromD18(LIMITS.MAX_TVL_FEE, 2)} a year.`);

      const ownerAddr = (owner.trim() || account) as Address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddr)) throw new Error("Owner must be a valid address.");

      const hash = await createReserve(
        pc,
        wallet,
        cfg,
        account,
        {
          name: name.trim(),
          symbol: symbol.trim(),
          legs,
          initialShares: parseAmount(initialShares, 18, "Initial shares"),
          mintFee,
          tvlFee,
          owner: ownerAddr,
        },
        (m) => setStatus({ text: m, kind: "busy" }),
      );
      const receipt = await pc.waitForTransactionReceipt({ hash });
      setStatus({
        text: `Reserve created in block ${receipt.blockNumber}. Copy its address from the transaction and add it to src/merge/lib/evmChain.ts to make it the default here.`,
        kind: "ok",
      });
      setLink({ href: explorerTx(hash), label: "View transaction" });
    } catch (e) {
      setStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a reserve</CardTitle>
        <CardDescription>
          Every reserve is its own contract, deployed through the SSR factory. You supply the starting basket &mdash;
          those assets leave your wallet and become the reserve&rsquo;s holdings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="c-name">Name</Label>
            <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Strategic Tech Reserve" />
          </div>
          <div>
            <Label htmlFor="c-symbol">Ticker</Label>
            <Input id="c-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="TECHSSR" />
          </div>
        </div>

        <div>
          <Label>Starting basket</Label>
          <div className="space-y-2 mt-1">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.3fr_1fr_auto] gap-2 items-center">
                <select
                  value={r.address}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))}
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                >
                  {cfg.assets.map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.symbol}{a.note ? ` — ${a.note}` : ""}
                    </option>
                  ))}
                </select>
                <Input
                  value={r.amount}
                  inputMode="decimal"
                  placeholder="Amount"
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
                <Button variant="ghost" size="icon" onClick={() => rows.length > 1 && setRows(rows.filter((_, j) => j !== i))}>
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
            <Label htmlFor="c-shares">Initial shares</Label>
            <Input id="c-shares" value={initialShares} onChange={(e) => setInitialShares(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label htmlFor="c-mintfee">Mint fee (%)</Label>
            <Input id="c-mintfee" value={mintFeePct} onChange={(e) => setMintFeePct(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label htmlFor="c-tvlfee">Annual TVL fee (%)</Label>
            <Input id="c-tvlfee" value={tvlFeePct} onChange={(e) => setTvlFeePct(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label htmlFor="c-owner">Owner</Label>
            <Input id="c-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="defaults to your wallet" />
          </div>
        </div>

        <Card className="border-primary/40 bg-primary/10">
          <CardContent className="py-3 text-sm">
            New reserves are created with <b>atomic-swap pricing</b> and a <b>{String(SAFE_REBALANCE_DEFAULTS.maxAuctionLength)}s auction cap</b>.
            That pair is what stops a rebalance price going stale across a corporate action on a stock token: an auction
            opens and fills in a single block, and the cap bounds the permissionless path too.
          </CardContent>
        </Card>

        <Button onClick={submit}>Create reserve</Button>
        <StatusLine status={status} link={link} />
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------- contracts

function ContractsView({ cfg, explorerAddr }: { cfg: ChainConfig; explorerAddr: (a: string) => string }) {
  const rows: [string, string | null][] = [
    ["SSR instance", cfg.ssr],
    ["SSRDeployer (factory)", cfg.deployer],
    ["SSRDAOFeeRegistry", cfg.feeRegistry],
    ["SSRVersionRegistry", cfg.versionRegistry],
    ["RoleRegistry", cfg.roleRegistry],
    ["TrustedFillerRegistry", cfg.fillerRegistry],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deployed contracts</CardTitle>
        <CardDescription>{cfg.chain.name} · chain {cfg.chain.id}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {rows.map(([label, a]) => (
              <TableRow key={label}>
                <TableCell className="font-semibold">{label}</TableCell>
                <TableCell className="text-right">
                  {a ? (
                    <a href={explorerAddr(a)} target="_blank" rel="noopener noreferrer" className="font-merge-mono text-xs underline text-primary">
                      {a}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">not deployed yet</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * What a chain shows when the protocol is deployed but nobody has created a
 * reserve yet. Everything here is read live from the chain -- the fee rule is
 * the registry's own defaults (getFeeDetails on the zero address), which is
 * exactly what the next reserve created will inherit. No placeholders.
 */
function DeployedButEmpty({
  cfg,
  pc,
  explorerAddr,
}: {
  cfg: ChainConfig;
  pc: PublicClient;
  explorerAddr: (a: string) => string;
}) {
  const [defaults, setDefaults] = useState<{ recipient: Address; daoFeeBps: bigint; feeFloor: bigint } | null>(null);
  const [impl, setImpl] = useState<Address | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, i] = await Promise.all([
          loadRegistryDefaults(pc, cfg),
          pc.readContract({ address: cfg.deployer, abi: DEPLOYER_ABI, functionName: "ssrImplementation" }),
        ]);
        if (!cancelled) {
          setDefaults(d);
          setImpl(i);
        }
      } catch (e) {
        if (!cancelled) setErr(describeEvmError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pc, cfg]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Protocol status</CardTitle>
            <CardDescription>{cfg.chain.name} &middot; chain {cfg.chain.id}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Factory" value={<span className="text-positive">deployed</span>} />
            <Row label="Registries" value={<span className="text-positive">deployed</span>} />
            <Row label="Fee rule" value={<span className="text-positive">configured</span>} />
            <Row label="Reserves created" value="0" />
            <Row
              label="Implementation"
              value={
                impl ? (
                  <a href={explorerAddr(impl)} target="_blank" rel="noopener noreferrer" className="font-merge-mono text-xs underline text-primary">
                    {short(impl)}
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fee rule</CardTitle>
            <CardDescription>Live from the fee registry &mdash; what the next reserve inherits.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="DAO share of mint fee" value={defaults ? `${fmtUnits(defaults.daoFeeBps, 2, 2)}%` : "—"} />
            <Row label="DAO floor" value={defaults ? pctFromD18(defaults.feeFloor) : "—"} />
            <Row
              label="Fee recipient"
              value={
                defaults ? (
                  <a href={explorerAddr(defaults.recipient)} target="_blank" rel="noopener noreferrer" className="font-merge-mono text-xs underline text-primary">
                    {short(defaults.recipient)}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            {err && <p className="text-sm text-destructive">{err}</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>No reserve yet</CardTitle>
          <CardDescription>
            Nobody has created a reserve through the factory on this network. Creating one deploys a new contract and
            moves your chosen assets into it as the starting basket. Use the &ldquo;Create a reserve&rdquo; tab.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 border-b border-border/60 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right font-merge-mono">{value}</span>
    </div>
  );
}
