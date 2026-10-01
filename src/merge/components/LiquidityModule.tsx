/**
 * Liquidity Module UI -- creator-side liquidity for a Reserve Token.
 *
 * Three exports:
 *  - LiquidityPanel: the add-liquidity form (pair, amount, lock, submit).
 *  - LiquiditySection: the Manager Dashboard "Liquidity" tab (empty state ->
 *    panel; live preview state -> pool dashboard with hyperlinked pool
 *    address, lock status, and the two fee actions: Collect to the creator
 *    treasury or Compound back into the pool -- DEC-0222).
 *  - LiquidityFirstMintIntro: the split-layout prompt shown on the Reserve
 *    page right after the root Manager's own first mint.
 *
 * Everything here renders DESIGN-PREVIEW state (see
 * src/merge/lib/liquidityPreview.ts and docs/project/LIQUIDITY_MODULE_SPEC.md)
 * and says so on-screen: no funds move, no pool is created on any chain, and
 * nothing is ever presented as a confirmed transaction. Chain-aware DEX rule:
 * all DEX naming comes from dexInfoFor(reserveChain(dtr)) -- Raydium for a
 * Solana Reserve, Uniswap for a Robinhood Reserve -- never hardcoded.
 */

import { useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatUsdc } from "@/lib/calculations";
import { shortenAddress } from "@/lib/delegateLabels";
import { solscanUrl } from "@/lib/solana-config";
import type { DTR } from "@/lib/types";
import {
  LOCK_MONTH_PRESETS,
  MIN_LIQUIDITY_USD,
  QUICK_AMOUNTS_USD,
  RECOMMENDED_LIQUIDITY_USD,
  accruedFeesUsd,
  dexInfoFor,
  hasValidNav,
  isDeepLiquidity,
  liquidityBadgeKind,
  lockRemainingDays,
  lockStatusLabel,
  poolTvlUsd,
  reserveChain,
  type LiquidityLock,
  type LiquidityLockMode,
  type LiquidityPoolPreview,
} from "@/lib/liquidityPreview";
import { AlertCircle, Check, Coins, Copy, Droplets, ExternalLink, Lock, Unlock } from "lucide-react";

const AVG_MONTH_MS = 30.44 * 86_400_000;

function navPerToken(dtr: DTR): number {
  return dtr.nav > 0 ? dtr.nav : 1;
}

/** Shown at the top of every Liquidity Module surface. Honest by design: preview state must never read as a live pool. */
export function LiquidityPreviewBanner() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 shrink-0">Design preview</Badge>
      <p className="text-muted-foreground">
        No funds move and no pool is created yet. This preview shows how taking your Reserve Token to market will work once
        liquidity goes live.
      </p>
    </div>
  );
}

/**
 * Liquidity trust badges -- the public signal a Reserve's pool state sends to
 * holders (canvas artboard "Liquidity trust badge states"). Rendered on the
 * Reserve page for EVERY viewer, not just the Manager:
 *  - Unlocked (amber, open lock): pool exists but nothing is locked.
 *  - Locked (accent, closed lock): 100% of the position locked, with the
 *    countdown read from the lock.
 *  - Locked forever (action yellow, closed lock): permanent -- the strongest
 *    trust signal.
 *  - Deep liquidity (emerald, droplets): an ADDITIONAL badge on top of the
 *    lock badge once TVL clears DEEP_LIQUIDITY_USD, so "thick + locked
 *    forever" reads as two stacked signals rather than a new hybrid state.
 * With `withPoolLink`, a hyperlinked pool-address chip rides along so anyone
 * can jump from the Reserve page straight to the pool.
 */
export function LiquidityBadges({ pool, dtr, withPoolLink = false }: { pool: LiquidityPoolPreview; dtr: DTR; withPoolLink?: boolean }) {
  const dex = dexInfoFor(pool.chain);
  const tvl = poolTvlUsd(pool, navPerToken(dtr));
  const tvlCompact = formatUsdc(tvl, { compact: true });
  const kind = liquidityBadgeKind(pool.lock);
  const days = lockRemainingDays(pool.lock) ?? 0;

  const badgeBase =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-merge-display text-[10px] font-semibold uppercase tracking-wider";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {kind === "unlocked" && (
        <span className={`${badgeBase} border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400`}>
          <Unlock className="h-3 w-3" />
          {tvlCompact} liquidity · unlocked
        </span>
      )}
      {kind === "locked" && (
        <span className={`${badgeBase} border-primary/40 bg-primary/10 text-primary`}>
          <Lock className="h-3 w-3" />
          {tvlCompact} liquidity · 100% locked · {days}d left
        </span>
      )}
      {kind === "permanent" && (
        <span className={`${badgeBase} border-yellow-500/50 bg-[#ede871]/25 text-yellow-700 dark:bg-[#ede871]/10 dark:text-[#ede871]`}>
          <Lock className="h-3 w-3" />
          Liquidity locked forever
        </span>
      )}
      {isDeepLiquidity(tvl) && (
        <span className={`${badgeBase} border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`}>
          <Droplets className="h-3 w-3" />
          Deep liquidity
        </span>
      )}
      {withPoolLink && (
        <a
          href={solscanUrl("address", pool.poolAddress)}
          target="_blank"
          rel="noreferrer"
          title={`Open the ${dex.name} pool for this Reserve Token`}
          className={`${badgeBase} border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors normal-case font-merge-mono tracking-normal`}
        >
          {dex.name} pool: {shortenAddress(pool.poolAddress)}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

export function LiquidityPanel({ dtr, onDone }: { dtr: DTR; onDone?: () => void }) {
  const { addLiquidityPreview } = useAppStore();
  const { toast } = useToast();

  const chain = reserveChain(dtr);
  const dex = dexInfoFor(chain);
  const nav = navPerToken(dtr);

  const [quoteSymbol, setQuoteSymbol] = useState<"USDC" | "SOL" | "ETH">("USDC");
  const [totalUsd, setTotalUsd] = useState<number>(RECOMMENDED_LIQUIDITY_USD);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [lockMode, setLockMode] = useState<LiquidityLockMode>("timed");
  const [lockMonths, setLockMonths] = useState(12);

  const effectiveTotal = customOpen ? Math.max(0, Number(customValue) || 0) : totalUsd;
  const baseTokens = effectiveTotal / 2 / nav;
  const quoteUsd = effectiveTotal / 2;
  const belowMinimum = effectiveTotal > 0 && effectiveTotal < MIN_LIQUIDITY_USD;

  const submit = () => {
    if (effectiveTotal <= 0) return;
    const lock: LiquidityLock =
      lockMode === "timed"
        ? { mode: "timed", months: lockMonths, unlockTs: Date.now() + lockMonths * AVG_MONTH_MS }
        : { mode: lockMode };
    addLiquidityPreview(dtr.id, { chain, quoteSymbol, baseTokens, quoteUsd, lock });
    toast({
      title: "Liquidity added in this preview",
      description: `${formatUsdc(effectiveTotal)} of preview liquidity for ${dtr.ticker} / ${quoteSymbol} on ${dex.name}. No funds moved.`,
    });
    onDone?.();
  };

  const lockChoices: { mode: LiquidityLockMode; title: string; body: string; icon: typeof Lock }[] = [
    { mode: "none", title: "No lock", body: "You can withdraw anytime. The weakest trust signal for holders.", icon: Unlock },
    { mode: "timed", title: "Lock for a period", body: "Held until the unlock date. You can extend later, never shorten. Trading fees stay yours throughout.", icon: Lock },
    { mode: "permanent", title: "Lock forever", body: "Permanent. You keep earning the pool's trading fees and can collect or compound them anytime.", icon: Lock },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Pair with</Label>
          <div className="flex gap-2">
            {(dex.altPairAvailable ? (["USDC", dex.altPairSymbol] as const) : (["USDC"] as const)).map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => setQuoteSymbol(sym)}
                className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                  quoteSymbol === sym ? "bg-primary/10 text-primary border-primary/40" : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {sym}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Total liquidity</Label>
          <div className="flex flex-wrap gap-2">
            {QUICK_AMOUNTS_USD.map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => {
                  setTotalUsd(amt);
                  setCustomOpen(false);
                }}
                className={`px-4 py-2 rounded-full text-sm font-merge-mono border transition-colors inline-flex items-center gap-2 ${
                  !customOpen && totalUsd === amt ? "bg-primary/10 text-primary border-primary/40" : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {formatUsdc(amt, { compact: true })}
                {amt === RECOMMENDED_LIQUIDITY_USD && <span className="text-[9px] uppercase tracking-wider text-primary">Recommended</span>}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              className={`px-4 py-2 rounded-full text-sm border transition-colors ${
                customOpen ? "bg-primary/10 text-primary border-primary/40" : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              Custom
            </button>
          </div>
          {customOpen && (
            <Input
              type="number"
              min={0}
              placeholder={`Total in USD (recommended ${formatUsdc(RECOMMENDED_LIQUIDITY_USD, { compact: true })})`}
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              className="max-w-[240px] font-merge-mono"
            />
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border divide-y divide-border">
        <div className="flex items-center justify-between p-3">
          <div>
            <p className="font-medium text-sm">{dtr.ticker}</p>
            <p className="text-xs text-muted-foreground">Reserve Token</p>
          </div>
          <div className="text-right">
            <p className="font-merge-mono text-base">{baseTokens.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
            <p className="text-xs text-muted-foreground">≈ {formatUsdc(effectiveTotal / 2)}</p>
          </div>
        </div>
        <div className="flex items-center justify-between p-3">
          <div>
            <p className="font-medium text-sm">{quoteSymbol}</p>
            <p className="text-xs text-muted-foreground">Pairing asset</p>
          </div>
          <div className="text-right">
            <p className="font-merge-mono text-base">{formatUsdc(quoteUsd).replace("$", "")}</p>
            <p className="text-xs text-muted-foreground">≈ {formatUsdc(effectiveTotal / 2)}</p>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        Both sides stay balanced at the Reserve Token's current value ({formatUsdc(nav)} per token), so the pool opens at fair
        value instead of gifting an instant profit to arbitrage bots.
      </p>

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Lock your liquidity</Label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {lockChoices.map((c) => {
            const Icon = c.icon;
            const active = lockMode === c.mode;
            return (
              <button
                key={c.mode}
                type="button"
                onClick={() => setLockMode(c.mode)}
                className={`text-left rounded-lg border p-3 transition-colors ${
                  active ? "border-primary/50 bg-primary/10" : "border-border hover:bg-muted"
                }`}
              >
                <Icon className={`w-4 h-4 mb-1.5 ${active ? "text-primary" : "text-muted-foreground"}`} />
                <p className={`text-sm font-medium ${active ? "text-foreground" : "text-muted-foreground"}`}>{c.title}</p>
                {c.mode === "timed" && active ? (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {LOCK_MONTH_PRESETS.map((m) => (
                      <span
                        key={m}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setLockMonths(m);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            setLockMonths(m);
                          }
                        }}
                        className={`px-2 py-0.5 rounded-full text-xs font-merge-mono border cursor-pointer ${
                          lockMonths === m ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"
                        }`}
                      >
                        {m}m
                      </span>
                    ))}
                  </span>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">{c.body}</p>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {belowMinimum && (
        <div className="bg-destructive/10 text-destructive p-3 rounded text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Pools under {formatUsdc(MIN_LIQUIDITY_USD, { compact: true })} produce unstable pricing and a poor chart. We recommend at
          least {formatUsdc(RECOMMENDED_LIQUIDITY_USD, { compact: true })} in total.
        </div>
      )}

      <div className="space-y-2">
        <Button className="w-full" size="lg" disabled={effectiveTotal <= 0} onClick={submit}>
          <Droplets className="w-4 h-4 mr-2" /> Add liquidity on {dex.name}
        </Button>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            This capital is separate from your mint deposit. Locked liquidity is verifiable by anyone.
          </p>
          {onDone && (
            <Button variant="ghost" size="sm" onClick={onDone}>
              I'll do this later
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Manager Dashboard's Liquidity tab. Root Manager only -- the caller gates, and this double-checks. */
export function LiquiditySection({ dtr }: { dtr: DTR }) {
  const { wallet, liquidityPreviews, lockLiquidityPreview, collectLiquidityPreviewFees, compoundLiquidityPreviewFees } = useAppStore();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [poolAddressCopied, setPoolAddressCopied] = useState(false);

  if (dtr.managerAddress !== wallet.address) return null;

  const chain = reserveChain(dtr);
  const dex = dexInfoFor(chain);
  const pool = liquidityPreviews[dtr.id];
  const nav = navPerToken(dtr);

  if (!pool) {
    return (
      <div className="space-y-6">
        <LiquidityPreviewBanner />
        <Card>
          <CardHeader>
            <CardTitle className="text-xl font-merge-display flex items-center gap-2">
              <Droplets className="w-5 h-5 text-primary" /> Take your Reserve Token to market
            </CardTitle>
            <CardDescription>
              Add liquidity on {dex.name} and {dtr.ticker} becomes tradeable outside SSR.fun, with a public chart. Liquidity is
              what turns a backed token into a market.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LiquidityPanel dtr={dtr} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const tvl = poolTvlUsd(pool, nav);
  const fees = accruedFeesUsd(pool, nav);
  const premiumPct = nav > 0 ? ((dtr.tokenPrice - nav) / nav) * 100 : 0;
  const remainingDays = lockRemainingDays(pool.lock);
  const totalLockDays = pool.lock.mode === "timed" && pool.lock.months ? Math.round(pool.lock.months * 30.44) : null;

  const collect = () => {
    collectLiquidityPreviewFees(dtr.id, fees);
    toast({
      title: "Fees collected in this preview",
      description: `${formatUsdc(fees)} sent to your creator treasury. In this design preview no funds actually move.`,
    });
  };

  // Compound prices the fees into the position at the Reserve's real NAV; without one it stays unavailable (no $1 guess).
  const canCompound = hasValidNav(dtr.nav) && fees >= 0.01;
  const compound = () => {
    if (!canCompound) return;
    compoundLiquidityPreviewFees(dtr.id, fees, dtr.nav);
    toast({
      title: "Fees compounded in this preview",
      description: `${formatUsdc(fees)} added back to the pool as balanced liquidity. In this design preview no funds actually move.`,
    });
  };

  const copyPoolAddress = () => {
    navigator.clipboard
      .writeText(pool.poolAddress)
      .then(() => {
        setPoolAddressCopied(true);
        window.setTimeout(() => setPoolAddressCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <div className="space-y-6">
      <LiquidityPreviewBanner />

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-merge-display font-bold">Liquidity</h2>
        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
          {dex.name} pool · preview
        </Badge>
        <a
          href={solscanUrl("address", pool.poolAddress)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-merge-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Preview pool address -- a live pool's link opens its real explorer page."
        >
          Pool {shortenAddress(pool.poolAddress)} <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6 space-y-1">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Pool liquidity</p>
            <p className="font-merge-mono text-2xl">{formatUsdc(tvl)}</p>
            <p className="text-xs text-muted-foreground">
              {dex.name} · {dtr.ticker} / {pool.quoteSymbol}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 space-y-1">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Fees earned</p>
            <p className="font-merge-mono text-2xl">{formatUsdc(fees)}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" disabled={fees < 0.01} onClick={collect}>
                <Coins className="w-3.5 h-3.5 mr-1.5" /> Collect
              </Button>
              <Button size="sm" variant="outline" disabled={!canCompound} onClick={compound} title={hasValidNav(dtr.nav) ? undefined : "Compound needs a current token value"}>
                <Droplets className="w-3.5 h-3.5 mr-1.5" /> Compound
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Fees accrue in USDC. Collect sends them to your creator treasury, never to your connected wallet; Compound adds them
              back into the pool.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Lock status</p>
            <p className="font-merge-mono text-2xl">{lockStatusLabel(pool.lock)}</p>
            {pool.lock.mode === "timed" && remainingDays !== null && totalLockDays ? (
              <>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${Math.min(100, Math.max(2, (remainingDays / totalLockDays) * 100))}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">100% of the position is locked. Extending is allowed, shortening never is. Fees keep accruing to you.</p>
              </>
            ) : pool.lock.mode === "permanent" ? (
              <p className="text-xs text-muted-foreground">Permanent. You keep earning trading fees, collectable or compoundable, but can never withdraw.</p>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing is locked. Locking is the strongest trust signal you can give holders.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base font-merge-display">Pool</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 text-sm">
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <span className="text-muted-foreground">DEX</span>
              <span>
                {dex.name} · {dex.poolTypeLabel}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <span className="text-muted-foreground">Pair</span>
              <span className="font-merge-mono">
                {dtr.ticker} / {pool.quoteSymbol}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <span className="text-muted-foreground">Pool address</span>
              <span className="inline-flex items-center gap-2">
                <a
                  href={solscanUrl("address", pool.poolAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-merge-mono text-primary hover:underline"
                >
                  {shortenAddress(pool.poolAddress)} <ExternalLink className="w-3 h-3" />
                </a>
                <button type="button" onClick={copyPoolAddress} aria-label="Copy pool address" className="text-muted-foreground hover:text-foreground">
                  {poolAddressCopied ? <Check className="w-3.5 h-3.5 text-positive" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <span className="text-muted-foreground">Your position</span>
              <span className="font-merge-mono">
                {pool.baseTokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} {dtr.ticker} + {formatUsdc(pool.quoteUsd)}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <span className="text-muted-foreground">Your share of the pool</span>
              <span className="font-merge-mono">100.00%</span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <span className="text-muted-foreground">Market price vs backing</span>
              <span className={`font-merge-mono ${premiumPct >= 0 ? "text-positive" : "text-destructive"}`}>
                {premiumPct >= 0 ? "+" : ""}
                {premiumPct.toFixed(2)}%
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-5">
            <Button variant="outline" size="sm" onClick={() => setAddOpen((v) => !v)}>
              <Droplets className="w-3.5 h-3.5 mr-1.5" /> {addOpen ? "Hide add liquidity" : "Add liquidity"}
            </Button>
            {pool.lock.mode !== "permanent" && (
              <>
                {LOCK_MONTH_PRESETS.map((m) => {
                  const proposedUnlock = Date.now() + m * AVG_MONTH_MS;
                  const extendsCurrent = pool.lock.mode === "none" || (pool.lock.unlockTs ?? 0) < proposedUnlock;
                  if (!extendsCurrent) return null;
                  return (
                    <Button
                      key={m}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        lockLiquidityPreview(dtr.id, { mode: "timed", months: m, unlockTs: proposedUnlock });
                        toast({ title: "Lock extended in this preview", description: `The position is now locked for ${m} month${m === 1 ? "" : "s"} from today.` });
                      }}
                    >
                      <Lock className="w-3.5 h-3.5 mr-1.5" /> Lock {m}m
                    </Button>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    lockLiquidityPreview(dtr.id, { mode: "permanent" });
                    toast({ title: "Locked forever in this preview", description: "The position can never be withdrawn. Trading fees keep accruing to you, collectable or compoundable." });
                  }}
                >
                  <Lock className="w-3.5 h-3.5 mr-1.5" /> Lock forever
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Withdrawing liquidity is only possible while the position is unlocked, and any withdrawal is publicly visible. Locking
            never touches your fees: collected fees always go to your creator treasury, and compounded fees go back into the pool.
          </p>
          {addOpen && (
            <div className="mt-5 border-t border-border pt-5">
              <LiquidityPanel dtr={dtr} onDone={() => setAddOpen(false)} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Split-layout prompt on the Reserve page after the root Manager's own first mint, while no pool exists. */
export function LiquidityFirstMintIntro({ dtr, onDismiss }: { dtr: DTR; onDismiss: () => void }) {
  const dex = dexInfoFor(reserveChain(dtr));
  return (
    <Card className="mb-8 border-primary/30">
      <CardContent className="pt-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          <div className="lg:col-span-2 space-y-3">
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">New · Creator only</Badge>
            <h3 className="text-2xl font-merge-display font-bold flex items-center gap-2">
              <Droplets className="w-5 h-5 text-primary" /> Take your Reserve Token to market
            </h3>
            <p className="text-sm text-muted-foreground">
              Your mint is complete: {dtr.ticker} is live and fully backed, but it is not tradeable anywhere yet. Add liquidity on{" "}
              {dex.name} and it becomes a market with a public chart.
            </p>
            <p className="text-xs text-muted-foreground">Only you, as this Reserve's Root Manager, see this step.</p>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              I'll do this later
            </Button>
          </div>
          <div className="lg:col-span-3 space-y-4">
            <LiquidityPreviewBanner />
            <LiquidityPanel dtr={dtr} onDone={onDismiss} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
