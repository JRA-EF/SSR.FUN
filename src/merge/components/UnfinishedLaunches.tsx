// DEC-0296: "Finish your launch" cards in Manage Reserve.
//
// A Reserve launch that stopped half-way (create-and-register landed, the
// seed did not) stays on-chain as `assetsInitializing`. This lists every such
// Reserve the connected wallet manages -- read from the chain through
// api/mainnet/unfinished-launches.ts, so it works on any device -- and lets
// the creator finish it (the same resumeReserveDeploymentOnChain the Launch
// page's Resume panel runs) or hide it ("cancel", app-level only; see
// lib/launch-cancel/rules.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  WRAPPED_SOL_MINT,
  computeEffectiveFeeSplit,
  PROTOCOL_MIN_MINT_FEE_BPS,
  describeOnChainError,
  fetchReserveOnChain,
  fetchTokenBalanceRaw,
  registerDynamicSupportedAssetMints,
  resolveReserveMetadata,
  fitTokenMetadataName,
  fitTokenMetadataSymbol,
  type UnfinishedLaunch,
} from "@ssr/sdk";
import { AlertCircle, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/store/useAppStore";
import { useMainnetAssetCatalogue } from "@/hooks/useMainnetAssetCatalogue";
import { IS_MAINNET, MAINNET_USDC_MINT, SOLANA_CLUSTER, SSR_PROGRAM_ID, TOKEN_METADATA_LIVE, solscanUrl } from "@/lib/solana-config";
import { fetchAssetPricesUsd, fetchMidPriceUsd } from "@/lib/assetPricing";
import { assessLaunchFeasibility, formatAllocationUsd, type LaunchAssetPlan } from "@/lib/launchFunding";
import { blockedAssets, checkLaunchRoutes } from "@/lib/launchPreflight";
import {
  resumeReserveDeploymentOnChain,
  checkReserveGenuinelyComplete,
  savePendingReserveDeploy,
  readPendingReserveDeploy,
  clearPendingReserveDeploy,
  classifyCreateReserveError,
  isWalletRejectionError,
  CreateReserveStepError,
  RESUME_MIN_SOL_LAMPORTS,
  type AssetFundingProgressEvent,
  type CreateReserveStep,
  type CreateReserveResult,
} from "@/lib/createReserveClient";
import { recordAbandonedCreate } from "@/lib/recoveryRecords";
import { reportFailure } from "@/lib/opsAlert";
import { requestReserveSnapshotRefresh } from "@/lib/reserveSnapshotClient";
import { ensureReserveTokenMetadataPublishedOnChain } from "@/lib/tokenMetadataAfterLaunchOnChain";
import { describeAfterLaunchMetadataOutcome } from "@/lib/tokenMetadataAfterLaunch";
import {
  assessUnfinishedLaunch,
  buildPendingDeployFromLaunch,
  describeVerdict,
  fallbackReserveName,
  fetchUnfinishedLaunches,
  seedAmountProblem,
  splitCancelledLaunches,
  submitLaunchCancel,
  type UnfinishedLaunchVerdict,
} from "@/lib/onChainLaunchResume";

const STEP_LABELS: Record<CreateReserveStep, string> = {
  "create-and-register": "Registering the remaining reserve assets...",
  "fund-seed-assets": "Swapping USDC into the reserve assets...",
  seed: "Seeding the Reserve...",
  done: "Done",
};

interface LaunchesState {
  status: "off" | "loading" | "ready" | "error";
  launches: UnfinishedLaunch[];
  cancelled: Set<string>;
  cancelledUnavailable: boolean;
}

/** The connected wallet's unfinished launches (Mainnet only: the scan runs on the Mainnet API). */
export function useUnfinishedLaunches(wallet: string | null): LaunchesState & { reload: () => void; setCancelled: (reserves: string[]) => void } {
  const [state, setState] = useState<LaunchesState>({ status: "off", launches: [], cancelled: new Set(), cancelledUnavailable: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!IS_MAINNET || !wallet) {
      setState({ status: "off", launches: [], cancelled: new Set(), cancelledUnavailable: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: s.status === "ready" ? "ready" : "loading" }));
    fetchUnfinishedLaunches(wallet)
      .then((r) => {
        if (!cancelled) setState({ status: "ready", launches: r.launches, cancelled: new Set(r.cancelled.map((c) => c.reserve)), cancelledUnavailable: !!r.cancelledUnavailable });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, status: "error" }));
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, tick]);
  return {
    ...state,
    reload: () => setTick((t) => t + 1),
    setCancelled: (reserves) => setState((s) => ({ ...s, cancelled: new Set(reserves) })),
  };
}

/** Name/ticker/picture from the Reserve's metadata, or null while unknown. */
function useLaunchMetadata(launches: UnfinishedLaunch[]): Record<string, { name: string; ticker: string; imageUrl?: string } | null> {
  const [meta, setMeta] = useState<Record<string, { name: string; ticker: string; imageUrl?: string } | null>>({});
  const key = launches.map((l) => l.reserve).join(",");
  useEffect(() => {
    let cancelled = false;
    for (const l of launches) {
      if (l.reserve in meta) continue;
      resolveReserveMetadata(l.metadataUri)
        .then((m) => {
          if (!cancelled) setMeta((prev) => ({ ...prev, [l.reserve]: m && m.name ? { name: m.name, ticker: m.ticker, imageUrl: m.imageUrl } : null }));
        })
        .catch(() => {
          if (!cancelled) setMeta((prev) => ({ ...prev, [l.reserve]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return meta;
}

export function UnfinishedLaunches() {
  const { wallet } = useAppStore();
  const address = wallet.connected ? wallet.address : null;
  const data = useUnfinishedLaunches(address);
  const meta = useLaunchMetadata(data.launches);
  const catalogue = useMainnetAssetCatalogue(IS_MAINNET);
  const [showCancelled, setShowCancelled] = useState(false);
  useEffect(() => {
    // The resume flow's own supported-asset check accepts catalogue mints only once registered.
    if (catalogue.tokens.length > 0) registerDynamicSupportedAssetMints(catalogue.tokens.map((t) => t.mint));
  }, [catalogue.tokens]);
  const symbolOf = useMemo(() => {
    const m = new Map(catalogue.tokens.map((t) => [t.mint, t.symbol]));
    m.set(MAINNET_USDC_MINT, "USDC");
    m.set(WRAPPED_SOL_MINT.toBase58(), "SOL");
    return (mint: string) => m.get(mint) ?? `…${mint.slice(-4)}`;
  }, [catalogue.tokens]);

  if (data.status !== "ready" || data.launches.length === 0) return null;
  const { visible, cancelled } = splitCancelledLaunches(data.launches, data.cancelled);
  if (visible.length === 0 && cancelled.length === 0) return null;

  return (
    <div className="container mx-auto px-4 max-w-6xl pt-8 space-y-4">
      {visible.map((l) => (
        <UnfinishedLaunchCard key={l.reserve} launch={l} meta={meta[l.reserve]} symbolOf={symbolOf} isCancelled={false} onCancelledChange={data.setCancelled} onDone={data.reload} />
      ))}
      {cancelled.length > 0 && (
        <div className="space-y-4">
          <button type="button" className="text-sm text-muted-foreground underline" onClick={() => setShowCancelled((v) => !v)}>
            {showCancelled ? "Hide cancelled launches" : `Show cancelled launches (${cancelled.length})`}
          </button>
          {showCancelled &&
            cancelled.map((l) => (
              <UnfinishedLaunchCard key={l.reserve} launch={l} meta={meta[l.reserve]} symbolOf={symbolOf} isCancelled onCancelledChange={data.setCancelled} onDone={data.reload} />
            ))}
        </div>
      )}
    </div>
  );
}

/** Small pointer for the Launch page when this browser has no Resume record but the chain has unfinished launches. */
export function UnfinishedLaunchesBanner() {
  const { wallet } = useAppStore();
  const address = wallet.connected ? wallet.address : null;
  const data = useUnfinishedLaunches(address);
  if (data.status !== "ready" || !address || readPendingReserveDeploy(address)) return null;
  const { visible } = splitCancelledLaunches(data.launches, data.cancelled);
  if (visible.length === 0) return null;
  return (
    <div className="mb-4">
      <Link href="/manage" className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm hover:underline">
        <AlertCircle className="w-4 h-4 shrink-0" />
        {visible.length === 1 ? "You have a Reserve launch that didn't finish." : `You have ${visible.length} Reserve launches that didn't finish.`} Finish or cancel {visible.length === 1 ? "it" : "them"} in Reserve Manager.
      </Link>
    </div>
  );
}

function UnfinishedLaunchCard({
  launch,
  meta,
  symbolOf,
  isCancelled,
  onCancelledChange,
  onDone,
}: {
  launch: UnfinishedLaunch;
  meta: { name: string; ticker: string; imageUrl?: string } | null | undefined;
  symbolOf: (mint: string) => string;
  isCancelled: boolean;
  onCancelledChange: (reserves: string[]) => void;
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const walletCtx = useWallet();
  const { toast } = useToast();
  const addKnownAssetMints = useAppStore((s) => s.addKnownAssetMints);
  const name = meta?.name || fallbackReserveName(launch.reserveId);
  const ticker = meta?.ticker || "";
  const localPending = readPendingReserveDeploy(launch.manager);
  const [seedUsd, setSeedUsd] = useState<string>(localPending?.reserve === launch.reserve ? String(localPending.seedTotalUsd) : "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [step, setStep] = useState<CreateReserveStep | null>(null);
  const [progress, setProgress] = useState<AssetFundingProgressEvent | null>(null);
  const [swapMint, setSwapMint] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [finished, setFinished] = useState<CreateReserveResult | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [verdict, setVerdict] = useState<UnfinishedLaunchVerdict>(() => assessUnfinishedLaunch(launch));

  const effectiveMintFeeBps = Number(computeEffectiveFeeSplit(BigInt(launch.mintFeeBps), PROTOCOL_MIN_MINT_FEE_BPS).effectiveTotalBps);
  const totalBps = launch.assets.reduce((s, a) => s + a.weightBps, 0);
  const startedOn = new Date(launch.createdAt * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const seedNumber = Number(seedUsd);
  const seedProblem = seedUsd ? seedAmountProblem(seedUsd) : null;
  const blockedReason = describeVerdict(verdict);

  /** Fresh read of the Reserve right now -- the server list is only what to show. */
  async function freshVerdict(): Promise<UnfinishedLaunchVerdict> {
    const onChain = await fetchReserveOnChain(connection, SSR_PROGRAM_ID, new PublicKey(launch.reserve), launch.assets.map((a) => new PublicKey(a.mint)));
    if (!onChain) return { kind: "asset-count-mismatch", onChainAssetCount: 0, expectedAssetCount: launch.assets.length };
    if (onChain.manager !== launch.manager) return { kind: "asset-count-mismatch", onChainAssetCount: onChain.assetCount, expectedAssetCount: launch.assets.length };
    const found = launch.assets.filter((a) => onChain.assets.some((o) => o.assetMint === a.mint));
    return assessUnfinishedLaunch({ status: onChain.status, assetCount: onChain.assetCount, assets: found });
  }

  useEffect(() => {
    let cancelled = false;
    freshVerdict()
      .then((v) => {
        if (!cancelled) setVerdict(v);
      })
      .catch(() => {
        // Keep the server-side verdict; Finish re-reads before submitting anyway.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.reserve]);

  const dtrHref = `/dtr/${SOLANA_CLUSTER}-${launch.reserveId}`;

  async function handleFinish() {
    if (busyRef.current || !walletCtx.publicKey) return;
    if (walletCtx.publicKey.toBase58() !== launch.manager) {
      setProblem("Connect the wallet that started this launch.");
      return;
    }
    const sp = seedAmountProblem(seedUsd);
    if (sp) {
      setProblem(sp);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    setStep(null);
    setProgress(null);
    setSwapMint(null);
    try {
      // 1. The Reserve right now (another device may have finished it).
      const v = await freshVerdict();
      setVerdict(v);
      if (v.kind !== "ready") {
        setProblem(describeVerdict(v));
        if (v.kind === "already-complete") onDone();
        return;
      }
      // 2. SOL for rent and fees (DEC-0282).
      const solLamports = await connection.getBalance(walletCtx.publicKey, "confirmed").catch(() => null);
      if (solLamports !== null && solLamports < RESUME_MIN_SOL_LAMPORTS) {
        setProblem(`Your wallet holds ${(solLamports / 1e9).toFixed(4)} SOL, which is not enough for the account rent and network fees. Add about 0.02 SOL, then press Finish launch again. Nothing was submitted.`);
        return;
      }
      const prices = await fetchAssetPricesUsd([...launch.assets.map((a) => ({ mint: a.mint, decimals: a.decimals })), { mint: WRAPPED_SOL_MINT.toBase58(), decimals: 9 }]).catch(() => ({}) as Record<string, { usdPrice: number | null }>);
      const solPriceUsd = prices[WRAPPED_SOL_MINT.toBase58()]?.usdPrice ?? null;
      if (launch.assets.some((a) => a.mint === WRAPPED_SOL_MINT.toBase58()) && !(solPriceUsd && solPriceUsd > 0)) {
        setProblem("The SOL price could not be read just now, so the SOL share can't be sized. Nothing was submitted. Try again in a moment.");
        return;
      }
      // 3. Every asset still supported and routable for this amount (DEC-0249 route check).
      const routeAssets = launch.assets.map((a) => ({
        symbol: symbolOf(a.mint),
        mint: a.mint,
        usdcBudgetUsd: totalBps > 0 ? seedNumber * (a.weightBps / totalBps) : 0,
        needsSwap: a.mint !== MAINNET_USDC_MINT && a.mint !== WRAPPED_SOL_MINT.toBase58(),
      }));
      const check = await checkLaunchRoutes({ connection, assets: routeAssets, isMainnet: IS_MAINNET, origin: window.location.origin });
      const blocked = blockedAssets(check);
      if (blocked.length > 0) {
        setProblem(`${blocked.map((b) => `${b.symbol}: ${b.reason}`).join(" ")} The reserve assets of a launched-but-unfinished Reserve can't be changed, so it can't be finished right now. Nothing was submitted.`);
        return;
      }
      // 4. Enough USDC for the swaps and the mint fee, counting assets already in the wallet.
      const usdcRaw = await fetchTokenBalanceRaw(connection, new PublicKey(MAINNET_USDC_MINT), walletCtx.publicKey).then(BigInt).catch(() => null);
      if (usdcRaw !== null) {
        const held = await Promise.all(
          launch.assets.map(async (a) => {
            if (a.mint === MAINNET_USDC_MINT || a.mint === WRAPPED_SOL_MINT.toBase58()) return 0;
            const raw = await fetchTokenBalanceRaw(connection, new PublicKey(a.mint), walletCtx.publicKey!, a.tokenProgram).catch(() => "0");
            const price = prices[a.mint]?.usdPrice ?? null;
            return price ? (Number(raw) / 10 ** a.decimals) * price : 0;
          }),
        );
        const plan: LaunchAssetPlan[] = launch.assets.map((a, i) => ({
          mint: a.mint,
          seedWeightFraction: totalBps > 0 ? a.weightBps / totalBps : 0,
          kind: a.mint === MAINNET_USDC_MINT ? "usdc" : a.mint === WRAPPED_SOL_MINT.toBase58() ? "wrapped-sol" : "swap",
          alreadyHeldUsd: held[i],
        }));
        const feasibility = assessLaunchFeasibility({ assets: plan, seedTotalUsd: seedNumber, walletUsdcRaw: usdcRaw, mintFeeUsd: seedNumber * (effectiveMintFeeBps / 10_000) });
        if (!feasibility.feasible) {
          const fix =
            feasibility.minimumRecommendedSeedUsd > seedNumber
              ? `Raise the amount to at least ${formatAllocationUsd(feasibility.minimumRecommendedSeedUsd)}.`
              : feasibility.missingUsdcUi > 0
                ? `Add ${feasibility.missingUsdcUi.toFixed(2)} USDC to this wallet, or lower the amount.`
                : "";
          setProblem(`${fix} Nothing was submitted. ${feasibility.reasons.slice(0, 3).join(" ")}`.trim());
          return;
        }
      }
      // 5. The same record the Launch page persists, so a refresh mid-way still recovers (there or here).
      const pending = buildPendingDeployFromLaunch(launch, { name, ticker: ticker || `R${launch.reserveId}`, seedTotalUsd: seedNumber, now: Date.now(), existing: readPendingReserveDeploy(launch.manager) });
      savePendingReserveDeploy(pending);
      useAppStore.getState().setTxInFlight(true);
      try {
        const result = await resumeReserveDeploymentOnChain({
          connection,
          wallet: walletCtx,
          pending,
          onProgress: setStep,
          onAssetProgress: setProgress,
          programId: SSR_PROGRAM_ID,
          allowFaucet: !IS_MAINNET,
          jupiterSwap: IS_MAINNET ? { enabled: true, seedTotalUsd: pending.seedTotalUsd, onSwapStart: setSwapMint, midPriceUsd: fetchMidPriceUsd } : undefined,
          solPriceUsd: solPriceUsd ?? 0,
          clusterLabel: IS_MAINNET ? "Mainnet" : "DevNet",
          usdcMintFee: IS_MAINNET,
        });
        await onFinished(result);
      } catch (e) {
        if (IS_MAINNET) reportFailure("create-resume", e, { wallet: walletCtx.publicKey?.toBase58() ?? null, reserve: launch.reserve, ticker: ticker || null });
        if (isWalletRejectionError(e)) {
          setProblem("Cancelled in your wallet. Nothing more was submitted; press Finish launch whenever you're ready.");
        } else if (e instanceof CreateReserveStepError) {
          const done = await checkReserveGenuinelyComplete(connection, SSR_PROGRAM_ID, pending).catch(() => null);
          if (done) {
            await onFinished(done);
            return;
          }
          const cls = classifyCreateReserveError(e);
          const msg = describeOnChainError(e);
          setProblem(
            cls === "ambiguous"
              ? `The outcome couldn't be confirmed yet (${STEP_LABELS[e.step]}). It may still land. Press Finish launch again: it re-checks the chain first and never repeats a finished step.`
              : cls === "deterministic"
                ? `${msg} This won't fix itself on a retry. Your Reserve is unchanged.`
                : `${msg} Your Reserve is unchanged. Press Finish launch again; nothing already done is repeated.`,
          );
        } else {
          setProblem(e instanceof Error ? e.message : String(e));
        }
      } finally {
        useAppStore.getState().setTxInFlight(false);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStep(null);
    }
  }

  async function onFinished(result: CreateReserveResult) {
    clearPendingReserveDeploy();
    let note: string | null = null;
    if (TOKEN_METADATA_LIVE && meta?.name) {
      const r = await ensureReserveTokenMetadataPublishedOnChain(connection, walletCtx, {
        reserve: result.reserve,
        reserveTokenMint: result.reserveTokenMint,
        reserveMetadataUri: launch.metadataUri,
        name: fitTokenMetadataName(meta.name),
        ticker: fitTokenMetadataSymbol(meta.ticker),
      });
      note = describeAfterLaunchMetadataOutcome(r, meta.ticker);
    }
    if (IS_MAINNET) {
      void requestReserveSnapshotRefresh(window.location.origin);
      addKnownAssetMints(result.assets.map((a) => a.mint));
    }
    setFinished(result);
    toast({ title: `${name} is live`, description: note ?? "Your Reserve finished launching." });
  }

  async function handleCancelToggle(action: "cancel" | "undo") {
    if (!walletCtx.publicKey || !walletCtx.signMessage) {
      setProblem("Your wallet can't sign messages. Try Phantom, Solflare or Backpack.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const list = await submitLaunchCancel({ action, reserve: launch.reserve, wallet: walletCtx.publicKey.toBase58(), signMessage: walletCtx.signMessage });
      if (action === "cancel") {
        // Same hand-off as the Launch page's "stop tracking": swaps a failed attempt ran are convertible on /recover.
        const local = readPendingReserveDeploy(launch.manager);
        if (local && local.reserve === launch.reserve) {
          if (IS_MAINNET) recordAbandonedCreate({ wallet: local.wallet, reserve: local.reserve, programId: SSR_PROGRAM_ID.toBase58(), name: local.name, startedAt: local.startedAt, assetFunding: local.assetFunding ?? {}, assetMints: local.assets.map((a) => a.mint) });
          clearPendingReserveDeploy();
        }
      }
      setConfirmCancel(false);
      onCancelledChange(list.map((c) => c.reserve));
      toast({ title: action === "cancel" ? "Launch cancelled" : "Cancel undone", description: action === "cancel" ? `${name} is hidden from Reserve Manager. Nothing changed on-chain.` : `${name} is back in Reserve Manager.` });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setProblem(isWalletRejectionError(e) ? "Signature cancelled. Nothing changed." : text);
    } finally {
      setBusy(false);
    }
  }

  // Finished elsewhere (another device, or the Launch page) since the list was read: nothing to offer.
  if (!finished && verdict.kind === "already-complete") return null;

  if (finished) {
    return (
      <Card className="border-primary/40">
        <CardContent className="py-6 space-y-2">
          <p className="font-semibold">{name} has finished launching and is live.</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link href={dtrHref} className="underline">Open the Reserve page</Link>
            {finished.transactions.seed && (
              <a href={solscanUrl("tx", finished.transactions.seed)} target="_blank" rel="noreferrer" className="underline">Seed transaction on Solscan</a>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const progressLine = step
    ? step === "fund-seed-assets" && progress
      ? `Swapping USDC into the reserve assets: ${progress.funded} of ${progress.total} ready${swapMint ? ` (now ${symbolOf(swapMint)})` : ""}...`
      : STEP_LABELS[step]
    : null;

  return (
    <Card className={isCancelled ? "opacity-80" : "border-amber-500/40"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Rocket className="w-5 h-5" />
          {isCancelled ? `Cancelled launch: ${name}` : `Finish launching ${name}?`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          You started launching <strong>{name}</strong>
          {ticker ? ` (${ticker}, Reserve #${launch.reserveId})` : ` (Reserve #${launch.reserveId})`} on {startedOn}, but its setup didn't finish, so it isn't live yet.
          {verdict.kind === "ready" ? " Do you want to finish setting it up?" : ""}
        </p>
        <div>
          <p className="font-medium mb-1">Its reserve assets</p>
          <ul className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
            {launch.assets.map((a) => (
              <li key={a.mint} className="flex justify-between gap-2">
                <span className="font-merge-mono">{symbolOf(a.mint)}</span>
                <span className="text-muted-foreground">{(a.weightBps / 100).toFixed(2)}%</span>
              </li>
            ))}
          </ul>
        </div>

        {blockedReason ? (
          <p className="text-destructive">{blockedReason}</p>
        ) : (
          <>
            <div className="space-y-1 text-muted-foreground">
              <p>
                Finishing swaps the USDC amount you choose into these reserve assets at their target shares, deposits them, and activates the Reserve. Your wallet asks you to approve a few transactions (one per swap, then the seed). Assets a failed attempt already swapped for and are still in your wallet are used first.
              </p>
              <p>
                Cost: the USDC amount below, plus the Reserve's {(effectiveMintFeeBps / 100).toFixed(2)}% mint fee on it (paid in USDC), plus a little SOL for account rent and network fees (keep about 0.02 SOL in the wallet).
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground" htmlFor={`seed-${launch.reserve}`}>Initial amount (USDC)</label>
                <Input id={`seed-${launch.reserve}`} type="number" min={1} step="0.01" inputMode="decimal" className="w-40" value={seedUsd} disabled={busy} onChange={(e) => setSeedUsd(e.target.value)} placeholder="e.g. 10" />
              </div>
              <Button className="rounded-full" disabled={busy || !!seedProblem || !seedUsd} onClick={handleFinish}>
                {busy && step ? "Finishing..." : busy ? "Checking..." : "Finish launch"}
              </Button>
            </div>
            {seedProblem && <p className="text-xs text-destructive">{seedProblem}</p>}
          </>
        )}

        {progressLine && <p className="text-primary">{progressLine}</p>}
        {problem && <p className="text-destructive">{problem}</p>}

        {isCancelled ? (
          <Button variant="outline" className="rounded-full" disabled={busy} onClick={() => handleCancelToggle("undo")}>Undo cancel</Button>
        ) : confirmCancel ? (
          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="font-medium">Cancel this launch?</p>
            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
              <li>It is hidden from your Reserve Manager page on every device. You can show it again and undo this later.</li>
              <li>Nothing changes on-chain. The Reserve holds no tokens.</li>
              <li>Its account rent (a small amount of SOL) stays locked for now and may become reclaimable in a later update.</li>
              <li>
                Any reserve assets a failed attempt already swapped for are in your wallet. You can convert them back to USDC on the{" "}
                <Link href="/recover" className="underline">Incomplete transactions</Link> page.
              </li>
            </ul>
            <p className="text-muted-foreground">Your wallet asks you to sign a message (free, no transaction).</p>
            <div className="flex gap-2">
              <Button variant="destructive" className="rounded-full" disabled={busy} onClick={() => handleCancelToggle("cancel")}>Yes, cancel this launch</Button>
              <Button variant="outline" className="rounded-full" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep it</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
            <span>If you don't want it, you can leave it as it is: it holds no tokens, only a small amount of SOL rent that can't be reclaimed yet.</span>
            <Button variant="outline" size="sm" className="rounded-full" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel this launch</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          <a href={solscanUrl("address", launch.reserve)} target="_blank" rel="noreferrer" className="underline">Reserve account on Solscan</a>
        </p>
      </CardContent>
    </Card>
  );
}
