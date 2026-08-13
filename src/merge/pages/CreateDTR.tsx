import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_FIXTURES, SOL_TEST_PRICE_USD, DEVUSDC, fetchReserveOnChain, computeEffectiveFeeSplit, PROTOCOL_MIN_MINT_FEE_BPS, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS, type RecipientInput } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import {
  createReserveOnChain,
  resumeReserveDeploymentOnChain,
  estimateCreateReserveCost,
  reserveAccountExistsOnChain,
  savePendingReserveDeploy,
  readPendingReserveDeploy,
  clearPendingReserveDeploy,
  determineDeploymentResumePoint,
  isWalletRejectionError,
  CreateReserveStepError,
  type CreateReserveStep,
  type CreateReserveCostEstimate,
  type PendingReserveDeploy,
  type ReserveOnChainStatus,
} from "@/lib/createReserveClient";
import { solscanUrl } from "@/lib/solana-config";
import { CopySignatureButton } from "@/components/TransactionConfirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { ChevronRight, ChevronLeft, Plus, X, Search, AlertCircle, Rocket } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { InfoTip } from "@/components/InfoTip";
import { formatUsdc, TICKER_MAX_LENGTH } from "@/lib/calculations";
import { type CreateDTRAssetInput, type FeeRecipient, type OnChainReserveMeta, type DTR, RESERVE_CATEGORIES, DEFAULT_RESERVE_CATEGORY } from "@/lib/types";

// Real, genuinely supported DevNet assets -- the real devUSDC settlement
// mint (Phase B) plus the 3 Gate-9 fixture test mints. This is the exact
// same set as packages/sdk/src/tradableAssets.ts's SUPPORTED_ASSET_MINTS --
// the site-wide eligibility check that determines which Reserves are even
// visible/tradable anywhere on the site -- so a Reserve created from this
// list is guaranteed to be tradable, never immediately hidden after
// creation. Native/wrapped SOL was removed from this list (it has no
// genuine devUSDC-settled Buy/Sell path -- see api/devnet/swap-sign.ts) --
// a Reserve holding it would be created successfully but then never be
// discoverable/tradable anywhere on the site. This is the ONLY selectable
// asset list -- the previous fictional/simulated asset list and its
// pure-simulation fallback deploy path have been removed entirely (see
// DEC-0030 and this pass's corrective DevNet data-integrity work in
// docs/project/PROJECT_STATUS.md).
const DEVNET_REAL_ASSETS = [
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
  const { wallet, registerRealReserve, syncRealHolding } = useAppStore();
  const { toast } = useToast();
  const { connection } = useConnection();
  const walletCtx = useWallet();

  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createStep, setCreateStep] = useState<CreateReserveStep | null>(null);
  // Synchronous, same-tick guard against a double-invocation of
  // handleSubmitReal (e.g. a fast double-click before React has re-rendered
  // the disabled Submit button) -- isSubmitting (React state) can't be
  // trusted for this since it only takes effect after the next render.
  const submittingRef = useRef(false);
  // True while checking on-chain state for a deployment that was left
  // in-flight by a page reload (see readPendingReserveDeploy) -- shown
  // instead of a blank fresh form, which would invite a duplicate launch.
  const [recovering, setRecovering] = useState(false);
  // A previous attempt's create-and-register transaction landed on-chain but
  // seeding never completed -- set once mount-time reconciliation (or a
  // failed submit -- see handleSubmitReal's catch block) confirms this via a
  // fresh on-chain read. While set, the form is replaced by a dedicated
  // Resume panel instead of offering a blank "Launch" form that would create
  // a SEPARATE Reserve (the confirmed root cause of the reported "tells the
  // user to create another Reserve" failure).
  const [resumePending, setResumePending] = useState<PendingReserveDeploy | null>(null);
  // Set when a pending deployment's real on-chain registered-asset count
  // doesn't match what it expected -- refuses to offer Resume (or a fresh
  // submission) automatically; this can only come from data corruption or an
  // unrelated concurrent modification, never something safe to guess through.
  const [resumeMismatch, setResumeMismatch] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>(DEFAULT_RESERVE_CATEGORY);
  
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
    // Debounced: a weight-slider drag or typing in the seed-amount field
    // changes `assets`'/`initialSeedUsdc`'s identity on every tick/keystroke.
    // Without this, each tick re-fired estimateCreateReserveCost immediately,
    // which used to send 4 concurrent rent-exemption RPC calls per tick --
    // the actual root cause of the reported 429 launch failure. Waiting for
    // a short quiet period collapses a rapid burst of edits into one request
    // (also cached/deduped/retried at the source -- see createReserveClient.ts).
    const debounceHandle = setTimeout(() => {
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
          if (cancelled) return;
          setCostEstimate(null);
          const msg = e instanceof Error ? e.message : String(e);
          // estimateCreateReserveCost never submits a transaction -- a
          // failure here (rate-limited or otherwise) can never mean a
          // launch partially happened, so this message is always accurate.
          const isRateLimited = msg.includes("429") || msg.toLowerCase().includes("too many requests");
          setCostEstimateError(
            isRateLimited
              ? "The Solana DevNet RPC is temporarily rate-limited. No transaction has been submitted. Please wait a moment and adjust an input to retry."
              : msg || "Failed to estimate DevNet transaction costs.",
          );
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(debounceHandle);
    };
  }, [realDeploymentCandidate, totalWeightForCost, initialSeedUsdc, assets, connection]);

  // Recovers from a page reload (or a return visit, hours or days later --
  // see PendingReserveDeploy's no-expiry note) that happened mid-deployment:
  // reads REAL on-chain state for the exact Reserve PDA this wallet's last
  // attempt was building, via determineDeploymentResumePoint's pure decision
  // logic (see createReserveResume.ts), BEFORE allowing anything else --
  // "recovering, checking on-chain state" instead of a blank form that would
  // let the user create a separate, duplicate Reserve.
  useEffect(() => {
    if (!wallet.connected || !wallet.address) return;
    const pending = readPendingReserveDeploy(wallet.address);
    if (!pending) return;
    setRecovering(true);
    const programId = new PublicKey(DEVNET_FIXTURES.programId);
    const candidateMints = pending.assets.map((a) => new PublicKey(a.mint));
    fetchReserveOnChain(connection, programId, new PublicKey(pending.reserve), candidateMints)
      .then((onChain) => {
        const resumePoint = determineDeploymentResumePoint({
          reserveExists: onChain !== null,
          reserveStatus: (onChain?.status as ReserveOnChainStatus | undefined) ?? null,
          onChainAssetCount: onChain?.assetCount ?? 0,
          expectedAssetCount: pending.assets.length,
        });
        if (resumePoint.kind === "start-fresh") {
          clearPendingReserveDeploy();
          toast({
            title: "Previous deployment did not land",
            description: `Your last attempt ("${pending.name}") left no on-chain Reserve -- safe to start a fresh one.`,
          });
        } else if (resumePoint.kind === "already-complete") {
          clearPendingReserveDeploy();
          toast({
            title: "Previous deployment already completed",
            description: `Your last Reserve creation attempt ("${pending.name}") already finished successfully on-chain.`,
          });
          setLocation(`/dtr/devnet-${pending.reserveId}`);
        } else if (resumePoint.kind === "asset-count-mismatch") {
          // Deliberately NOT cleared -- this needs a human to look at it, not
          // an automatic guess. Both Resume and a fresh submission stay blocked.
          setResumeMismatch(
            `On-chain Reserve ${pending.reserve} has ${resumePoint.onChainAssetCount} registered asset(s), but this pending deployment expected ${resumePoint.expectedAssetCount}. This needs manual verification on Explorer before continuing.`,
          );
        } else {
          setResumePending(pending);
        }
      })
      .catch(() => {
        // Reconciliation read itself failed (RPC congestion) -- leave the
        // marker in place; the next mount will retry rather than assuming
        // either outcome.
      })
      .finally(() => setRecovering(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected, wallet.address, connection]);

  const handleResumeDeployment = async () => {
    if (!resumePending || submittingRef.current || !walletCtx.publicKey) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setCreateStep("fund-seed-assets");
    useAppStore.getState().setTxInFlight(true);
    try {
      const result = await resumeReserveDeploymentOnChain({
        connection,
        wallet: walletCtx,
        pending: resumePending,
        onProgress: setCreateStep,
      });
      clearPendingReserveDeploy();
      const dtrId = `devnet-${result.reserveId}`;
      // Registers this Reserve into the store immediately, mirroring
      // handleSubmitReal's fresh-creation path below -- without this, a
      // successful Resume left `dtrs` without an entry for it until
      // RealReserveSync's next poll (up to MAX_POLL_MS later), so navigating
      // straight to /dtr/{dtrId} showed a transient "Reserve Not Found"
      // right after a genuinely successful deployment (the confirmed root
      // cause of the reported "eventually appeared after waiting/refreshing"
      // behavior). description/category/fee config aren't knowable from
      // `resumePending` alone (this may be a fresh page load after the
      // original form's state was lost) -- honest defaults here; the very
      // next discovery poll overwrites with full on-chain-verified data
      // (mergeDiscoveredReserves merges by on-chain address, same as any
      // other discovered Reserve). DTRDetail.tsx/ManageDTR.tsx's "indexing"
      // state is the real safety net for every other path into this same
      // gap; this is belt-and-suspenders for the resume path specifically.
      const onChainResumed: OnChainReserveMeta = {
        programId: DEVNET_FIXTURES.programId,
        reserveId: result.reserveId,
        reserve: result.reserve,
        reserveTokenMint: result.reserveTokenMint,
        mintAuthority: result.mintAuthority,
        vaultAuthority: result.vaultAuthority,
        manager: walletCtx.publicKey.toBase58(),
        assets: result.assets.map((a, i) => ({
          mint: a.mint,
          symbol: DEVNET_REAL_ASSETS.find((m) => m.mint === a.mint)?.symbol ?? "?",
          decimals: a.decimals,
          weightBps: a.weightBps,
          reserveAsset: a.reserveAsset,
          vault: a.vault,
          orderIndex: i,
        })),
        status: "active",
        totalTargetWeightBps: 10_000,
        reserveTokenSupplyRaw: String(Math.max(1, Math.floor(resumePending.seedTotalUsd)) * 1_000_000),
        vaultBalancesRaw: {},
      };
      registerRealReserve({
        id: dtrId,
        name: resumePending.name,
        ticker: resumePending.ticker,
        description: "",
        category: DEFAULT_RESERVE_CATEGORY,
        tags: [DEFAULT_RESERVE_CATEGORY, "devnet", "real"],
        logoSeed: dtrId,
        dtrAddress: result.reserve,
        managerAddress: walletCtx.publicKey.toBase58(),
        delegates: [],
        feeConfig: {
          mintFeePct: 0,
          tvlFeePct: 0,
          managerBuyTaxPct: 0,
          managerSellTaxPct: 0,
          creatorFeeDestination: walletCtx.publicKey.toBase58(),
          feeRecipients: [],
        },
        tokenPrice: 1,
        nav: 1,
        aum: resumePending.seedTotalUsd,
        liquidityUsdc: resumePending.seedTotalUsd,
        change24h: 0,
        change7d: 0,
        holders: 1,
        composition: result.assets.map((a) => {
          const meta = DEVNET_REAL_ASSETS.find((m) => m.mint === a.mint);
          return { symbol: meta?.symbol ?? "?", name: meta?.name ?? a.mint, weight: a.weightBps / 10_000 };
        }),
        unallocatedPct: 0,
        isUserCreated: true,
        priceHistory: [{ t: Date.now(), price: 1 }],
        trades: [],
        onChain: onChainResumed,
      });
      setResumePending(null);
      syncRealHolding(dtrId, "0", 1); // Placeholder holding entry -- RealReserveSync's next poll (or DTRDetail's own on-chain read) fills in the real balance/composition immediately; this just avoids a blank flash.
      toast({
        title: "Reserve deployment resumed and completed",
        description: (
          <div className="space-y-1">
            <div>
              Reserve:{" "}
              <a href={solscanUrl("address", result.reserve)} target="_blank" rel="noreferrer" className="underline">
                View on Solscan
              </a>
            </div>
            {result.transactions.seed ? (
              <div className="flex items-center gap-2">
                <a href={solscanUrl("tx", result.transactions.seed)} target="_blank" rel="noreferrer" className="underline">
                  Seed transaction confirmed &mdash; View on Solscan
                </a>
                <CopySignatureButton signature={result.transactions.seed} size="xs" />
              </div>
            ) : (
              <div>Was already fully seeded by the earlier attempt.</div>
            )}
          </div>
        ),
      });
      setLocation(`/dtr/${dtrId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isWalletRejectionError(e)) {
        toast({ title: "Cancelled in wallet", description: "Nothing was submitted -- safe to try Resume again whenever you're ready." });
      } else if (e instanceof CreateReserveStepError) {
        toast({
          variant: "destructive",
          title: `Resume failed (${CREATE_STEP_LABELS[e.step]})`,
          description: `${msg} -- your Reserve's on-chain identity is unchanged. Click Resume Deployment again once ready; nothing already confirmed will be resubmitted.`,
        });
      } else {
        toast({ variant: "destructive", title: "Resume failed", description: msg });
      }
    } finally {
      setIsSubmitting(false);
      setCreateStep(null);
      submittingRef.current = false;
      useAppStore.getState().setTxInFlight(false);
    }
  };

  if (recovering) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-4">
          <Rocket className="w-16 h-16 text-primary mx-auto mb-4 animate-pulse" />
          <h1 className="text-2xl font-merge-display font-bold">Recovering...</h1>
          <p className="text-muted-foreground">Checking Solana DevNet for a Reserve creation left in progress before this page reloaded.</p>
        </div>
      </div>
    );
  }

  if (resumeMismatch) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-4">
          <AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4" />
          <h1 className="text-2xl font-merge-display font-bold">Manual verification needed</h1>
          <p className="text-muted-foreground">{resumeMismatch}</p>
          <p className="text-sm text-muted-foreground">This is not something safe to resolve automatically -- please verify the Reserve's real composition before deploying anything else with this wallet.</p>
        </div>
      </div>
    );
  }

  if (resumePending) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-24">
        <Card className="border-primary/30 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl font-merge-display flex items-center gap-2">
              Resume Deployment
              <Badge className="font-merge-mono">Solana DevNet</Badge>
            </CardTitle>
            <CardDescription>
              Your Reserve "{resumePending.name}" ({resumePending.ticker}) was already created on-chain, but seeding didn't finish. Resuming continues from real on-chain state -- it will
              never recreate the Reserve or fund an asset you already have enough of.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center p-3 rounded-lg border border-border bg-muted/20 text-sm">
              <span className="text-muted-foreground">Reserve address</span>
              <span className="font-merge-mono text-xs truncate max-w-[220px]">{resumePending.reserve}</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded-lg border border-border bg-muted/20 text-sm">
              <span className="text-muted-foreground">Assets</span>
              <span className="font-merge-mono text-xs">{resumePending.assets.length}</span>
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t border-border/40 pt-6">
            <Button onClick={handleResumeDeployment} disabled={isSubmitting} className="font-bold gap-2 min-w-[180px]">
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> {createStep ? CREATE_STEP_LABELS[createStep] : "Resuming..."}
                </>
              ) : (
                <>
                  <Rocket className="w-4 h-4" /> Resume Deployment
                </>
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

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
    if (feeRecipients.length + 1 >= 10) return; // +1 for the Primary, MAX_FEE_RECIPIENTS = 10
    if (feeRecipients.some((r) => r.address === newRecipientAddress.trim())) return;
    if (newRecipientAddress.trim() === (feeDestination || wallet.address)) return; // Primary is already implicitly a recipient
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
    // Synchronous re-entrancy guard -- see submittingRef's declaration.
    if (submittingRef.current) return;
    // A pending deployment for this wallet (started in this tab OR another
    // tab/session sharing the same browser's localStorage) means a
    // half-built Reserve already exists -- starting a FRESH submission here
    // would create a genuinely separate, duplicate Reserve. Re-read
    // synchronously right before submitting (not just relying on the
    // mount-time effect) so a deployment started in another tab moments ago
    // is still caught.
    const alreadyPending = readPendingReserveDeploy(walletCtx.publicKey.toBase58());
    if (alreadyPending) {
      setResumePending(alreadyPending);
      toast({
        variant: "destructive",
        title: "A deployment is already in progress",
        description: `Reserve "${alreadyPending.name}" (${alreadyPending.ticker}) has a deployment in progress for this wallet -- resume it instead of starting a new one.`,
      });
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setCreateStep("create-and-register");
    const programId = new PublicKey(DEVNET_FIXTURES.programId);
    useAppStore.getState().setTxInFlight(true);

    const feeDestinationKey = new PublicKey(feeDestination || walletCtx.publicKey.toBase58());
    // DEC-0094: Primary gets whatever's left after the explicitly-configured
    // additional recipients' shares -- if that remainder is 0 (additional
    // recipients already sum to exactly 100%), the Primary is correctly
    // omitted rather than submitted as an invalid zero-allocation entry.
    const additionalRecipientsForChain: RecipientInput[] = feeRecipients.map((r) => ({ wallet: r.address, allocationBps: Math.round(r.pct * 100) }));
    const primaryAllocationBps = 10_000 - additionalRecipientsForChain.reduce((sum, r) => sum + r.allocationBps, 0);
    const recipientsForChain: RecipientInput[] | undefined =
      feeRecipients.length > 0
        ? [...(primaryAllocationBps > 0 ? [{ wallet: feeDestinationKey.toBase58(), allocationBps: primaryAllocationBps }] : []), ...additionalRecipientsForChain]
        : undefined;
    const realAssets = assets.map((a) => {
      const meta = REAL_ASSET_BY_SYMBOL.get(a.symbol)!;
      return { mint: meta.mint, decimals: meta.decimals, weightBps: Math.round((a.weight / totalWeight) * 10_000), seedWeightFraction: a.weight / totalWeight };
    });
    const seedTotalUsd = parseFloat(initialSeedUsdc) || 10;

    try {
      const result = await createReserveOnChain({
        connection,
        wallet: walletCtx,
        metadataUri: `data:application/json,${encodeURIComponent(JSON.stringify({ name, ticker, description, category }))}`,
        mintFeeBps: Math.round(mintFeePct * 100),
        tvlFeeBps: Math.round(tvlFeePct * 100),
        feeDestination: feeDestinationKey,
        feeRecipients: recipientsForChain,
        assets: realAssets,
        seedTotalUsd,
        onProgress: setCreateStep,
        // Persisted immediately -- if the page reloads (or the user leaves
        // and comes back later) anywhere after this fires, the mount-time
        // recovery effect above can reconcile THIS exact Reserve PDA against
        // real on-chain state and offer Resume instead of a blank form that
        // would let the user create a duplicate Reserve. Carries the full
        // composition/seed target -- everything resumeReserveDeploymentOnChain
        // needs to finish the deployment without re-deriving anything.
        onAddressesResolved: (addresses) => {
          savePendingReserveDeploy({
            wallet: walletCtx.publicKey!.toBase58(),
            reserve: addresses.reserve.toBase58(),
            reserveId: addresses.reserveId.toString(),
            name,
            ticker: ticker.toUpperCase(),
            startedAt: Date.now(),
            assets: realAssets.map((a) => ({ mint: a.mint, decimals: a.decimals, seedWeightFraction: a.seedWeightFraction })),
            seedTotalUsd,
          });
        },
      });
      clearPendingReserveDeploy();

      const dtrId = `devnet-${result.reserveId}`;
      const onChain: OnChainReserveMeta = {
        programId: DEVNET_FIXTURES.programId,
        reserveId: result.reserveId,
        reserve: result.reserve,
        reserveTokenMint: result.reserveTokenMint,
        mintAuthority: result.mintAuthority,
        vaultAuthority: result.vaultAuthority,
        manager: walletCtx.publicKey.toBase58(),
        assets: result.assets.map((a, i) => ({
          mint: a.mint,
          symbol: DEVNET_REAL_ASSETS.find((m) => m.mint === a.mint)?.symbol ?? "?",
          decimals: a.decimals,
          weightBps: a.weightBps,
          reserveAsset: a.reserveAsset,
          vault: a.vault,
          orderIndex: i,
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
          // Safe to store here (not []): this write only runs after
          // createReserveOnChain resolved successfully, which means
          // recipientsForChain -- when provided -- was already confirmed
          // on-chain in the very same transaction as create_reserve itself.
          feeRecipients,
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
      // The creator receives the ENTIRE initial Reserve Token supply at seed
      // time (mint_reserve_tokens_in_kind's seed path has no other
      // recipient) -- register that real holding immediately instead of
      // waiting for RealReserveSync's next background poll to discover it.
      // This was the confirmed root cause of a freshly-deployed Reserve's
      // balance being briefly (and misleadingly) absent from Portfolio right
      // after a successful deployment.
      syncRealHolding(dtrId, onChain.reserveTokenSupplyRaw, 1);

      toast({
        title: "Reserve deployed on Solana DevNet",
        description: (
          <div className="space-y-1">
            <div>
              Reserve:{" "}
              <a href={solscanUrl("address", result.reserve)} target="_blank" rel="noreferrer" className="underline">
                View on Solscan
              </a>
            </div>
            {result.transactions.createAndRegister && (
              <div className="flex items-center gap-2">
                <a href={solscanUrl("tx", result.transactions.createAndRegister)} target="_blank" rel="noreferrer" className="underline">
                  Create transaction confirmed &mdash; View on Solscan
                </a>
                <CopySignatureButton signature={result.transactions.createAndRegister} size="xs" />
              </div>
            )}
          </div>
        ),
      });
      setLocation(`/dtr/${dtrId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      if (isWalletRejectionError(e)) {
        // Rejected in the wallet popup itself -- strictly before any
        // submission, so there is nothing to reconcile and nothing was ever
        // saved to resume. Never treated as ambiguous.
        toast({ title: "Cancelled in wallet", description: "Nothing was submitted -- safe to try again whenever you're ready." });
      } else if (e instanceof CreateReserveStepError && e.step !== "create-and-register") {
        // A failure in fund-seed-assets/seed means create-and-register
        // already succeeded -- the Reserve definitely exists on-chain, just
        // not fully seeded. The pending marker (already saved, with the full
        // composition) is kept -- switch straight into the Resume panel
        // instead of dead-ending the user on a blank form whose only action
        // would create a SEPARATE, duplicate Reserve.
        const resumable = readPendingReserveDeploy(walletCtx.publicKey!.toBase58());
        if (resumable) setResumePending(resumable);
        toast({
          variant: "destructive",
          title: `Deployment incomplete (${CREATE_STEP_LABELS[e.step]})`,
          description: `${msg} -- the Reserve account was already created on-chain before this step. Use Resume Deployment below to finish it safely; it will never recreate the Reserve or a step that already succeeded.`,
        });
      } else if (e instanceof CreateReserveStepError && e.addresses) {
        // create-and-register itself threw. Reconcile against the EXACT
        // Reserve PDA this attempt targeted (not a fuzzy reserveCount
        // comparison, which a concurrent Reserve creation by a different
        // wallet could also move) -- this is precisely the live-observed
        // "Blockhash not found" case where the Reserve was actually created
        // on-chain despite the displayed failure.
        const exists = await reserveAccountExistsOnChain(connection, e.addresses.reserve, programId).catch(() => null);
        if (exists) {
          // It landed after all -- the pending marker already has the full
          // composition, so this is resumable too (most likely straight to
          // seeding, since create-and-register itself is what "succeeded").
          const resumable = readPendingReserveDeploy(walletCtx.publicKey!.toBase58());
          if (resumable) setResumePending(resumable);
          toast({
            title: "Submission status unclear -- Reserve already exists",
            description: "The wallet reported a failure, but this Reserve now exists on-chain. Use Resume Deployment below instead of retrying the form, to avoid creating a duplicate.",
          });
        } else if (exists === null) {
          // Reconciliation read itself failed (still congested) -- leave the
          // pending marker in place; a reload or the next attempt's own
          // mount-time recovery check will retry the reconciliation.
          toast({
            variant: "destructive",
            title: "Deployment status unclear",
            description: `${msg} -- could not verify on-chain state right now (DevNet RPC congestion). Do not retry until you've confirmed via Discover or Explorer whether this Reserve was created.`,
          });
        } else {
          clearPendingReserveDeploy();
          const isRateLimited = msg.includes("429") || msg.toLowerCase().includes("too many requests");
          toast({
            variant: "destructive",
            title: `Deployment Failed (${CREATE_STEP_LABELS["create-and-register"]})`,
            description: isRateLimited
              ? "The Solana DevNet RPC is temporarily rate-limited. No transaction has been submitted -- safe to retry shortly."
              : `${msg} -- confirmed nothing was created on-chain. Safe to retry.`,
          });
        }
      } else {
        // Threw before any Reserve addresses were even derived (e.g. a
        // wallet/connection error) -- nothing could possibly have been
        // submitted.
        clearPendingReserveDeploy();
        const isRateLimited = msg.includes("429") || msg.toLowerCase().includes("too many requests");
        toast({
          variant: "destructive",
          title: "Deployment Failed (setup)",
          description: isRateLimited
            ? "The Solana DevNet RPC is temporarily rate-limited. No transaction has been submitted. Please retry shortly."
            : msg || "The DevNet Reserve creation failed.",
        });
      }
    } finally {
      setIsSubmitting(false);
      setCreateStep(null);
      submittingRef.current = false;
      useAppStore.getState().setTxInFlight(false);
    }
  };

  // Real, on-chain DevNet deployment is the ONLY launch path this app
  // offers now -- the previous pure-simulation fallback (a fictional-asset
  // "Reserve" created purely in localStorage, no wallet signature, no chain
  // interaction) was exactly the legacy/mock behavior removed in this
  // corrective pass (see docs/project/PROJECT_STATUS.md). `isRealDeployment`
  // is still checked below as a fail-closed guard, not a branch to a mock
  // path: every selectable asset now comes from DEVNET_REAL_ASSETS, so it
  // should always be true once at least one asset is selected.
  const handleSubmit = handleSubmitReal;

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12">
      <div className="mb-8">
        <h1 className="text-4xl font-merge-display font-bold mb-2">Launch a Reserve</h1>
        <p className="text-muted-foreground">Launch a new Reserve on SSR.FUN, live on Solana DevNet.</p>
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
                <select
                  id="category"
                  className="flex h-10 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {RESERVE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">Choose the category that best fits this Reserve's strategy or focus.</p>
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
                    {DEVNET_REAL_ASSETS
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
                      {DEVNET_REAL_ASSETS.filter(a => !assets.some(selected => selected.symbol === a.symbol)).length === 0 && (
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
                    <InfoTip label="More information about the initial Reserve value">
                      {isRealDeployment
                        ? "The USD value to seed the reserve with. You'll provide the equivalent DevNet SOL shown below -- it's converted into the selected reserve assets and deposited for you."
                        : "Initial capital to seed the reserve and set the starting AUM."}
                    </InfoTip>
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
                <p className="text-xs text-muted-foreground -mt-4">
                  SSR.fun always keeps at least 0.5% of the Mint Fee and 0.5% annualized of the TVL Fee for the protocol -- if you set a fee below that,
                  the effective fee charged still floors at 0.5% (the Manager receives nothing extra in that case). Above the minimum, the Protocol and
                  Manager split the configured fee 50/50.
                </p>

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
                    {realDeploymentCandidate && (() => {
                      const split = computeEffectiveFeeSplit(BigInt(Math.round(mintFeePct * 100)), PROTOCOL_MIN_MINT_FEE_BPS);
                      return (
                        <p className="text-xs font-merge-mono text-muted-foreground">
                          Effective: {(Number(split.protocolBps) / 100).toFixed(2)}% Protocol + {(Number(split.managerBps) / 100).toFixed(2)}% Manager = {(Number(split.effectiveTotalBps) / 100).toFixed(2)}% total
                        </p>
                      );
                    })()}
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
                    {realDeploymentCandidate && (() => {
                      const split = computeEffectiveFeeSplit(BigInt(Math.round(tvlFeePct * 100)), PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS);
                      return (
                        <p className="text-xs font-merge-mono text-muted-foreground">
                          Effective: {(Number(split.protocolBps) / 100).toFixed(2)}% Protocol + {(Number(split.managerBps) / 100).toFixed(2)}% Manager = {(Number(split.effectiveTotalBps) / 100).toFixed(2)}% total
                        </p>
                      );
                    })()}
                  </div>

                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Buy Tax</span>
                      <span className="font-merge-mono text-primary">{(realDeploymentCandidate ? 0 : managerBuyTaxPct).toFixed(2)}%</span>
                    </Label>
                    {realDeploymentCandidate ? (
                      <p className="text-xs text-muted-foreground">SSR.fun does not charge a tax on buys -- this is always 0% for a real Reserve.</p>
                    ) : (
                      <>
                        <Slider
                          value={[managerBuyTaxPct]}
                          max={2}
                          step={0.05}
                          onValueChange={(v) => setManagerBuyTaxPct(v[0])}
                        />
                        <p className="text-xs text-muted-foreground">Optional additional tax charged on buys. Default is 0%.</p>
                      </>
                    )}
                  </div>

                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Sell Tax</span>
                      <span className="font-merge-mono text-primary">{(realDeploymentCandidate ? 0 : managerSellTaxPct).toFixed(2)}%</span>
                    </Label>
                    {realDeploymentCandidate ? (
                      <p className="text-xs text-muted-foreground">SSR.fun does not charge a tax on sells -- this is always 0% for a real Reserve.</p>
                    ) : (
                      <>
                        <Slider
                          value={[managerSellTaxPct]}
                          max={2}
                          step={0.05}
                          onValueChange={(v) => setManagerSellTaxPct(v[0])}
                        />
                        <p className="text-xs text-muted-foreground">Optional additional tax charged on sells. Default is 0%.</p>
                      </>
                    )}
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
                  <p className="text-xs text-muted-foreground">
                    Address that receives the Manager's fee share on-chain (100%, unless you add more recipients below). Defaults to your connected wallet ({wallet.address ? `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}` : "—"})
                    until you change it -- this is the exact wallet the Review step below will show as Primary.
                  </p>
                </div>

                <div className="space-y-3 pt-2">
                  <Label className="flex justify-between items-center">
                    <span>Additional Fee Recipients ({feeRecipients.length + 1}/10)</span>
                    <span className={`font-merge-mono text-xs ${feeRecipientTotalPct > 100 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {feeRecipientTotalPct.toFixed(1)}% of the Manager's share
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    These percentages divide the <strong>Manager's fee share</strong> -- not the total fee charged to depositors. Whatever's left after
                    the recipients below goes to the Primary Fee Destination above. Up to 10 recipients total, including the Primary.
                  </p>

                  {feeRecipients.length > 0 && (
                    <div className="space-y-2">
                      {feeRecipients.map((r) => (
                        <div key={r.address} className="flex items-center justify-between gap-3 p-2 rounded-lg border border-border bg-muted/20">
                          <span className="font-merge-mono text-xs truncate">{r.address}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="secondary" className="font-merge-mono">{r.pct}% of Manager share</Badge>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeFeeRecipient(r.address)}>
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {feeRecipients.length + 1 < 10 ? (
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
                  ) : (
                    <p className="text-xs text-muted-foreground">Maximum of 10 recipients reached, including the Primary Fee Destination.</p>
                  )}
                  {feeRecipientTotalPct > 100 && (
                    <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>Recipient percentages exceed 100% of the Manager's fee share. Please adjust.</p>
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
                disabled={!initialSeedUsdc || parseFloat(initialSeedUsdc) <= 0 || feeRecipientTotalPct > 100}
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
                      <span className="text-muted-foreground">Mint Fee (configured)</span>
                      <span className="font-merge-mono font-medium">{mintFeePct.toFixed(2)}%</span>
                    </div>
                    {realDeploymentCandidate && (() => {
                      const split = computeEffectiveFeeSplit(BigInt(Math.round(mintFeePct * 100)), PROTOCOL_MIN_MINT_FEE_BPS);
                      return (
                        <div className="flex justify-between text-xs pl-3">
                          <span className="text-muted-foreground">↳ Protocol / Manager (effective)</span>
                          <span className="font-merge-mono text-muted-foreground">{(Number(split.protocolBps) / 100).toFixed(2)}% / {(Number(split.managerBps) / 100).toFixed(2)}%</span>
                        </div>
                      );
                    })()}
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">TVL Fee (configured, annualized)</span>
                      <span className="font-merge-mono font-medium">{tvlFeePct.toFixed(2)}%</span>
                    </div>
                    {realDeploymentCandidate && (() => {
                      const split = computeEffectiveFeeSplit(BigInt(Math.round(tvlFeePct * 100)), PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS);
                      return (
                        <div className="flex justify-between text-xs pl-3">
                          <span className="text-muted-foreground">↳ Protocol / Manager (effective)</span>
                          <span className="font-merge-mono text-muted-foreground">{(Number(split.protocolBps) / 100).toFixed(2)}% / {(Number(split.managerBps) / 100).toFixed(2)}%</span>
                        </div>
                      );
                    })()}
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Buy Tax</span>
                      <span className="font-merge-mono font-medium">{(realDeploymentCandidate ? 0 : managerBuyTaxPct).toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Sell Tax</span>
                      <span className="font-merge-mono font-medium">{(realDeploymentCandidate ? 0 : managerSellTaxPct).toFixed(2)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {isRealDeployment && (
                <div className="bg-card border border-primary/30 rounded-xl overflow-hidden">
                  <div className="bg-primary/5 p-4 border-b border-border">
                    <h3 className="font-semibold flex items-center gap-2">
                      Wallet Cost Summary
                      <InfoTip label="More information about the wallet cost summary">Every DevNet SOL this wallet will actually be asked to spend, shown before Phantom does.</InfoTip>
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
                            <InfoTip label="More information about account creation and rent">Solana requires new accounts (the Reserve, its assets, vaults, and Reserve Token mint) to be rent-exempt -- this SOL isn't a fee, it stays locked in those accounts.</InfoTip>
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
                            <InfoTip label="More information about protocol fees">No fee is charged at creation itself -- Mint Fee ({mintFeePct.toFixed(2)}%) and TVL Fee ({tvlFeePct.toFixed(2)}%) apply to future Buy/holding activity, configured above.</InfoTip>
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
                      <p>1. Create the Reserve + register {assets.length} reserve asset{assets.length === 1 ? "" : "s"} (combined into one transaction)</p>
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
                <p className="text-sm font-semibold text-muted-foreground mb-1">Manager Fee Routing</p>
                <p className="text-xs text-muted-foreground mb-3">
                  This is the exact on-chain configuration that will be submitted. Percentages divide the Manager's fee share, not the total fee.
                </p>
                <div className="space-y-2">
                  {(() => {
                    const additional = feeRecipients.reduce((sum, r) => sum + r.pct, 0);
                    const primaryPct = Math.max(0, 100 - additional);
                    return (
                      <>
                        {primaryPct > 0 && (
                          <div className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                            <span className="font-merge-mono text-xs truncate">{feeDestination || wallet.address}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline" className="bg-background">Primary</Badge>
                              <span className="font-merge-mono font-bold">{primaryPct.toFixed(1)}%</span>
                            </div>
                          </div>
                        )}
                        {feeRecipients.map((r) => (
                          <div key={r.address} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                            <span className="font-merge-mono text-xs truncate">{r.address}</span>
                            <span className="font-merge-mono font-bold shrink-0">{r.pct}%</span>
                          </div>
                        ))}
                      </>
                    );
                  })()}
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
                disabled={isSubmitting || !isRealDeployment || (!costEstimate && !costEstimateError)}
                title={!isRealDeployment ? "Every selected asset must be a supported real DevNet asset." : (!costEstimate && !costEstimateError) ? "Calculating launch cost..." : undefined}
                className="font-bold gap-2 min-w-[150px]"
              >
                {isSubmitting ? (
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> {createStep ? CREATE_STEP_LABELS[createStep] : "Deploying..."}</>
                ) : !costEstimate && !costEstimateError ? (
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Calculating cost...</>
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