// The Robinhood Chain half of Portfolio. Same "Reserve Holdings" language and
// table shape as the Solana half, so a holder reads one portfolio rather than
// two products; it just needs its own wallet, because the chains do.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROBINHOOD } from "@/lib/evmChain";
import { describeEvmError, fmtUnits, publicClientFor, rhReserveId, SSR_ABI } from "@/lib/evmReserve";
import { formatUsdc } from "@/lib/calculations";
import { useRobinhoodReserves } from "@/hooks/useRobinhoodReserves";
import { connectEvmWallet, useEvmWallet } from "./useEvmWallet";

interface Holding {
  address: `0x${string}`;
  name: string;
  symbol: string;
  shares: bigint;
  decimals: number;
  value: number | null;
}

export function RobinhoodHoldings() {
  const { account } = useEvmWallet();
  const { reserves, status } = useRobinhoodReserves();
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!account || reserves.length === 0) {
      setHoldings(null);
      return;
    }
    (async () => {
      try {
        const pc = publicClientFor(ROBINHOOD);
        const rows = await Promise.all(
          reserves.map(async (r): Promise<Holding> => {
            const shares = await pc.readContract({ address: r.address, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
            const supply = Number(fmtUnits(r.totalSupply, r.decimals, 18));
            const held = Number(fmtUnits(shares, r.decimals, 18));
            return {
              address: r.address,
              name: r.name,
              symbol: r.symbol,
              shares,
              decimals: r.decimals,
              value: r.aumUsd !== null && supply > 0 ? (r.aumUsd * held) / supply : null,
            };
          }),
        );
        if (!cancelled) {
          setHoldings(rows.filter((h) => h.shares > 0n));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(describeEvmError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, reserves]);

  if (!account) {
    return (
      <Card className="border-dashed border-border/60 bg-transparent">
        <CardContent className="py-10 flex flex-col items-center justify-center text-center gap-3">
          <p className="text-sm text-muted-foreground">Connect an EVM wallet to see your Robinhood Chain reserves.</p>
          <Button variant="outline" size="sm" onClick={() => void connectEvmWallet().catch((e) => setError(describeEvmError(e)))}>
            Connect EVM wallet
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    );
  }

  if (error) return <Card className="bg-card/40 border-border/50"><CardContent className="py-8 text-sm text-destructive">{error}</CardContent></Card>;
  if (status === "loading" && holdings === null)
    return <Card className="bg-card/40 border-border/50"><CardContent className="py-8 text-sm text-muted-foreground">Reading Robinhood Chain…</CardContent></Card>;
  if (holdings !== null && holdings.length === 0)
    return (
      <Card className="border-dashed border-border/60 bg-transparent">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          You don&rsquo;t hold any Robinhood Chain reserve yet. <Link href="/discover" className="text-primary underline">Browse the directory</Link>.
        </CardContent>
      </Card>
    );

  return (
    <Card className="bg-card/40 border-border/50 overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow className="border-border/50">
            <TableHead className="py-4">Asset</TableHead>
            <TableHead className="text-right">Balance</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Chain</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(holdings ?? []).map((h) => (
            <TableRow key={h.address} className="border-border/50">
              <TableCell className="py-4">
                <Link href={`/dtr/${rhReserveId(h.address)}`} className="font-semibold hover:text-primary">
                  {h.name}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground font-merge-mono">{h.symbol}</span>
              </TableCell>
              <TableCell className="text-right font-merge-mono">{fmtUnits(h.shares, h.decimals, 6)}</TableCell>
              <TableCell className="text-right font-merge-mono">{h.value === null ? "—" : formatUsdc(h.value)}</TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">Robinhood</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
