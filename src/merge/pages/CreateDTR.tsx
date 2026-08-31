import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_FIXTURES, SOL_TEST_PRICE_USD, DEVUSDC, WRAPPED_SOL_MINT, fetchReserveOnChain, fetchTokenBalanceRaw, computeEffectiveFeeSplit, PROTOCOL_MIN_MINT_FEE_BPS, PROTOCOL_MIN_ANNUAL_TVL_FEE_BPS, validateMetadataUri, describeOnChainError, registerDynamicSupportedAssetMints, type RecipientInput } from "@ssr/sdk";
import { fetchAssetPricesUsd } from "@/lib/assetPricing";
import { useMainnetAssetCatalogue } from "@/hooks/useMainnetAssetCatalogue";
import { matchesAssetSearch } from "@/lib/assetSearch";
import { useAppStore } from "@/store/useAppStore";
import {
  createReserveOnChain,
  resumeReserveDeploymentOnChain,
  checkReserveGenuinelyComplete,
  estimateCreateReserveCost,
  reserveAccountExistsOnChain,
  savePendingReserveDeploy,
  readPendingReserveDeploy,
  clearPendingReserveDeploy,
  determineDeploymentResumePoint,
  isWalletRejectionError,
  classifyCreateReserveError,
  isFeeDestinationCollisionError,
  MAX_ASSETS_PER_RESERVE,
  rawToUiAmount,
  uploadReserveMetadata,
  estimateNetSeedReserveTokens,
  savePendingAssetFunding,
  CreateReserveStepError,
  type AssetFundingProgressEvent,
  type CreateReserveStep,
  type CreateReserveResult,
  type CreateReserveCostEstimate,
  type CreateReserveErrorClass,
  type PendingReserveDeploy,
  type ReserveOnChainStatus,
} from "@/lib/createReserveClient";
import { assessLaunchFeasibility, DEFAULT_FEE_BUFFER_FRACTION, type LaunchAssetPlan } from "@/lib/launchFunding";
import { fileToProfileImageDataUrl, uploadReserveImage } from "@/lib/reserveImageClient";
import { solscanUrl, SSR_PROGRAM_ID, SOLANA_CLUSTER, IS_MAINNET, MAINNET_USDC_MINT, MAINNET_TREASURY_VAULT } from "@/lib/solana-config";
import { createAndRegisterReserveAlt } from "@/lib/reserveAltClient";
import { CopySignatureButton } from "@/components/TransactionConfirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
// Mainnet's asset picker is real Circle USDC (always selectable, the
// protocol's settlement/mint-and-redeem currency -- see
// docs/project/DECISION_LOG.md's Mainnet-launch entries) plus the live
// Jupiter Tokens API V2 verified-token catalogue (see
// useMainnetAssetCatalogue, api/ledger/asset-catalogue.ts) for the rest of
// the basket -- computed inside the component below (SELECTABLE_ASSETS),
// not as a module-level constant like DEVNET_REAL_ASSETS above, since it
// depends on that catalogue fetch's live result.
const MAINNET_USDC_ASSET = { symbol: "USDC", name: "USD Coin", real: true as const, mint: MAINNET_USDC_MINT, decimals: 6 };
const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "DevNet";

const CREATE_STEP_LABELS: Record<CreateReserveStep, string> = {
  "create-and-register": "Step 1/2: Creating Reserve + registering assets...",
  "fund-seed-assets": `Funding seed assets (${CLUSTER_LABEL})...`,
  seed: "Step 2/2: Seeding Reserve...",
  done: "Done",
};

/** How many wallet approvals createReserveOnChain will request for this asset selection -- see createReserveClient.ts's signature-count note. */
/** Rough fallback ONLY for the brief window before the real costEstimate (which has the authoritative numTransactions, including any Jupiter swaps and the real registration-batch count -- see createReserveClient.ts's estimateCreateReserveCost) has loaded -- see its call site, which prefers costEstimate.numTransactions once available. Mirrors estimateCreateReserveCost's own conservative per-batch asset count so this brief-window number doesn't undercount for a large asset selection. */
function expectedApprovalCount(assets: { symbol: string }[]): number {
  const needsSolWrap = assets.some((a) => a.symbol === "SOL");
  const registerBatches = Math.max(1, Math.ceil(assets.length / 6));
  return registerBatches + 1 /* seed */ + (needsSolWrap ? 1 : 0);
}


export function CreateDTR() {
  const [, setLocation] = useLocation();
  const { wallet, registerRealReserve, syncRealHolding, addKnownAssetMints, setWalletModalOpen } = useAppStore();
  const { toast } = useToast();
  const { connection } = useConnection();
  const walletCtx = useWallet();

  // Mainnet only: the live Jupiter verified-token catalogue for the Reserve
  // Asset picker (see useMainnetAssetCatalogue's header). Registered as
  // dynamically-supported as soon as it loads so createReserveClient.ts's
  // isSupportedAssetMint check (which gates what can actually be submitted
  // on-chain) accepts a brand-new asset nobody has used yet -- distinct from
  // RealReserveSync.tsx's separate, narrower "known on-chain mints"
  // registration, which only covers assets already in use (kept small on
  // purpose for the live discovery poll's RPC cost; this one is a one-shot
  // page-load registration with no polling cost concern).
  const mainnetCatalogue = useMainnetAssetCatalogue(IS_MAINNET);
  useEffect(() => {
    if (IS_MAINNET && mainnetCatalogue.tokens.length > 0) {
      registerDynamicSupportedAssetMints(mainnetCatalogue.tokens.map((t) => t.mint));
    }
  }, [mainnetCatalogue.tokens]);

  const SELECTABLE_ASSETS = useMemo(() => {
    if (!IS_MAINNET) return DEVNET_REAL_ASSETS;
    return [MAINNET_USDC_ASSET, ...mainnetCatalogue.tokens.filter((t) => t.symbol !== MAINNET_USDC_ASSET.symbol)];
  }, [mainnetCatalogue.tokens]);
  const REAL_ASSET_BY_SYMBOL = useMemo(() => new Map(SELECTABLE_ASSETS.map((a) => [a.symbol, a])), [SELECTABLE_ASSETS]);

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
  // Set by jupiterSwap.onSwapStart while a non-USDC asset is being funded via
  // a real Jupiter swap (Mainnet only) -- overrides the generic
  // "fund-seed-assets" step label with something more specific while it's
  // happening. Cleared whenever a fresh submission/resume attempt starts.
  const [jupiterSwapMint, setJupiterSwapMint] = useState<string | null>(null);
  // Per-asset funding progress (launchFunding.ts's state machine, DEC-0151)
  // -- drives the "4 of 10 assets funded" display so a multi-asset launch's
  // several sequential wallet approvals read as visible forward progress
  // instead of an opaque spinner. Cleared whenever a fresh submission/resume
  // attempt starts.
  const [fundingProgress, setFundingProgress] = useState<AssetFundingProgressEvent | null>(null);
  function stepLabel(step: CreateReserveStep | null, fallback: string): string {
    if (!step) return fallback;
    if (step === "fund-seed-assets" && fundingProgress) {
      const swapping = jupiterSwapMint ? ` -- swapping USDC for ${jupiterSwapMint.slice(0, 4)}...${jupiterSwapMint.slice(-4)}` : "";
      return `Funding seed assets: ${fundingProgress.funded} of ${fundingProgress.total} ready${swapping}...`;
    }
    if (step === "fund-seed-assets" && jupiterSwapMint) {
      return `Swapping USDC for ${jupiterSwapMint.slice(0, 4)}...${jupiterSwapMint.slice(-4)} via Jupiter...`;
    }
    return CREATE_STEP_LABELS[step];
  }
  // jupiterSwap.onSwapShortfall (createReserveClient.ts): a swap's real
  // on-chain result landed meaningfully below what was quoted -- the
  // Reserve is still created with the real amount received (never
  // blocked), this just makes sure the creator sees it happened rather
  // than silently ending up with a lighter allocation than the weight
  // slider implied.
  /**
   * The single place a Resume (or a reconciled "actually already complete"
   * recovery -- see the catch blocks below) is turned into UI state:
   * registers the Reserve, syncs the creator's own holding, records any
   * newly-used Mainnet asset mints, shows the completion toast, and
   * navigates to the Reserve's own page. Extracted out of
   * handleResumeDeployment's try block so a genuinely-completed Reserve
   * discovered via on-chain reconciliation (not this specific call's own
   * return value) gets the exact same treatment -- never a different,
   * possibly-inconsistent "well it's sort of done" path.
   */
  function finalizeResumedReserve(result: CreateReserveResult, pending: PendingReserveDeploy) {
    if (!walletCtx.publicKey) return;
    clearPendingReserveDeploy();
    // Same id-scheme requirement as handleSubmitReal's own dtrId -- see its comment above.
    const dtrId = `${SOLANA_CLUSTER}-${result.reserveId}`;
    const onChainResumed: OnChainReserveMeta = {
      programId: SSR_PROGRAM_ID.toBase58(),
      reserveId: result.reserveId,
      reserve: result.reserve,
      reserveTokenMint: result.reserveTokenMint,
      mintAuthority: result.mintAuthority,
      vaultAuthority: result.vaultAuthority,
      manager: walletCtx.publicKey.toBase58(),
      assets: result.assets.map((a, i) => ({
        mint: a.mint,
        symbol: SELECTABLE_ASSETS.find((m) => m.mint === a.mint)?.symbol ?? "?",
        decimals: a.decimals,
        weightBps: a.weightBps,
        reserveAsset: a.reserveAsset,
        vault: a.vault,
        orderIndex: i,
      })),
      status: "active",
      totalTargetWeightBps: 10_000,
      reserveTokenSupplyRaw: String(Math.max(1, Math.floor(pending.seedTotalUsd)) * 1_000_000),
      vaultBalancesRaw: {},
    };
    registerRealReserve({
      id: dtrId,
      name: pending.name,
      ticker: pending.ticker,
      description: "",
      category: DEFAULT_RESERVE_CATEGORY,
      tags: [DEFAULT_RESERVE_CATEGORY, SOLANA_CLUSTER, "real"],
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
      aum: pending.seedTotalUsd,
      liquidityUsdc: pending.seedTotalUsd,
      change24h: 0,
      change7d: 0,
      holders: 1,
      composition: result.assets.map((a) => {
        const meta = SELECTABLE_ASSETS.find((m) => m.mint === a.mint);
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
    if (IS_MAINNET) addKnownAssetMints(result.assets.map((a) => a.mint));
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
  }

  /**
   * Called from a fund-seed-assets/seed step failure's catch block, BEFORE
   * ever reporting "deployment incomplete" to the user -- reads the
   * AUTHORITATIVE on-chain Reserve state (never a wallet balance, never an
   * assumption from the caught exception alone) to check whether seeding
   * actually already succeeded despite this specific call erroring (a
   * client-side pre-flight guard tripping on a stale read, a delayed RPC
   * balance read, or a race with another attempt/tab). Delegates entirely to
   * checkReserveGenuinelyComplete, which is STRICTLY read-only -- it cannot
   * fund, swap, or seed anything under any circumstance, so this can never
   * resubmit or double-submit whatever just (apparently) failed. Returns
   * true if it resolved the Reserve as complete (and already finalized the
   * UI for it) -- false means genuinely still incomplete, the caller's
   * normal failure handling should proceed.
   */
  async function reconcileAlreadyCompleteReserve(pending: PendingReserveDeploy | null): Promise<boolean> {
    if (!pending || !walletCtx.publicKey) return false;
    // checkReserveGenuinelyComplete is strictly read-only -- it cannot fund,
    // swap, or seed anything under any circumstance, so there is zero risk
    // of this reconciliation step itself resubmitting or double-submitting
    // whatever just failed.
    const result = await checkReserveGenuinelyComplete(connection, SSR_PROGRAM_ID, pending).catch(() => null);
    if (!result) return false;
    finalizeResumedReserve(result, pending);
    return true;
  }

  function handleJupiterSwapShortfall(info: { mint: string; targetRaw: bigint; actualRaw: bigint; shortfallPct: number }) {
    const meta = SELECTABLE_ASSETS.find((a) => a.mint === info.mint);
    const symbol = meta?.symbol ?? `${info.mint.slice(0, 4)}...${info.mint.slice(-4)}`;
    const decimals = meta?.decimals ?? 0;
    const actual = rawToUiAmount(info.actualRaw, decimals).toLocaleString();
    const target = rawToUiAmount(info.targetRaw, decimals).toLocaleString();
    // Covers two real cases with the same shape: an executed swap landing
    // below its quote (price movement on a thin-liquidity token), and a
    // dust-sized remaining shortfall skipped entirely because it was too
    // small to reliably swap for at all (see createReserveClient.ts's
    // DUST_DEFICIT_USDC_RAW) -- worded generically so it's accurate either
    // way, never claiming a swap happened when one didn't.
    toast({
      title: `${symbol} funded slightly below target`,
      description: `${symbol} ended up seeded with ${actual} instead of the ~${target} targeted (${(info.shortfallPct * 100).toFixed(1)}% short) -- likely price movement or a remaining gap too small to swap for. Your Reserve was still created/seeded with the real amount held.`,
      variant: "destructive",
    });
  }
  // Set by handleResumeDeployment's catch block when a Resume attempt fails
  // -- classified so the panel below can distinguish a genuinely transient
  // condition (safe to just click Resume again) from a deterministic
  // on-chain validation failure (the exact same transaction WILL fail again
  // until the underlying configuration/program issue is fixed -- see
  // createReserveResume.ts's classifyCreateReserveError). Cleared on every
  // fresh mount-time reconciliation and right before a new Resume attempt,
  // so it never displays stale information about a previous attempt.
  const [resumeError, setResumeError] = useState<{ errorClass: CreateReserveErrorClass; step: CreateReserveStep; message: string; isFeeDestinationCollision: boolean } | null>(null);
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
  // Optional profile picture, picked in Step 1 (Identity): the normalized
  // data URL (see fileToProfileImageDataUrl -- downscaled/re-encoded
  // locally, EXIF stripped) held until the metadata-upload effect below
  // stores it and embeds the resulting permanent URL in this Reserve's
  // metadata payload; launch then also points the Reserve's mutable picture
  // pointer at it (see reserveImageClient.ts's pointer notes).
  const [profileImageDataUrl, setProfileImageDataUrl] = useState<string | null>(null);
  const [profileImageError, setProfileImageError] = useState<string | null>(null);
  // The stored picture's permanent URL from the latest metadata upload --
  // what the just-created Reserve's local registration shows immediately
  // (RealReserveSync re-derives the same value on its next pass).
  const [uploadedProfileImageUrl, setUploadedProfileImageUrl] = useState<string | null>(null);
  const profileImageInputRef = useRef<HTMLInputElement | null>(null);
  const handlePickProfileImage = async (file: File | undefined) => {
    if (!file) return;
    setProfileImageError(null);
    try {
      setProfileImageDataUrl(await fileToProfileImageDataUrl(file));
    } catch (e) {
      setProfileImageDataUrl(null);
      setProfileImageError(e instanceof Error ? e.message : "This file could not be read as an image -- try a different one.");
    }
  };
  
  const [assets, setAssets] = useState<CreateDTRAssetInput[]>([]);
  const [assetSearch, setAssetSearch] = useState("");
  
  const [initialSeedUsdc, setInitialSeedUsdc] = useState("");
  const [mintFeePct, setMintFeePct] = useState(0.5);
  const [tvlFeePct, setTvlFeePct] = useState(1);
  const [managerBuyTaxPct, setManagerBuyTaxPct] = useState(0);
  const [managerSellTaxPct, setManagerSellTaxPct] = useState(0);
  const [feeDestination, setFeeDestination] = useState(wallet.address || "");
  // wallet.address can still be empty at this component's first render (the
  // wallet adapter often resolves the public key asynchronously after
  // mount), in which case the useState initializer above never re-runs to
  // pick it up -- the field would sit visibly blank even though the actual
  // submission logic already falls back to the connected wallet correctly.
  // Backfills it the moment the wallet address becomes known, but never
  // overwrites a value the user has since typed themselves.
  const feeDestinationUserEditedRef = useRef(false);
  useEffect(() => {
    if (!feeDestinationUserEditedRef.current && !feeDestination && wallet.address) {
      setFeeDestination(wallet.address);
    }
  }, [wallet.address, feeDestination]);
  const [feeRecipients, setFeeRecipients] = useState<FeeRecipient[]>([]);
  const [newRecipientAddress, setNewRecipientAddress] = useState("");
  const [newRecipientPct, setNewRecipientPct] = useState("");
  const [feeRecipientAddError, setFeeRecipientAddError] = useState<string | null>(null);
  const [additionalManagers, setAdditionalManagers] = useState<string[]>([]);
  const [newManagerAddress, setNewManagerAddress] = useState("");
  const [costEstimate, setCostEstimate] = useState<CreateReserveCostEstimate | null>(null);
  const [costEstimateError, setCostEstimateError] = useState<string | null>(null);
  // Real current SOL/USD price for the Wallet Cost Summary's "(≈ $X)" line --
  // that display used to multiply by SOL_TEST_PRICE_USD (a fixed $20 DevNet
  // test constant) unconditionally, including on Mainnet, showing a real SOL
  // amount's USD value at a stale price (2026-08-24, road-to-mainnet
  // MCR-01/MMT-01: reported as "$2.64" for 0.13177 SOL, i.e. exactly
  // $20.04/SOL). null (never a fabricated number) until a real price loads;
  // the display falls back to an honest "USD estimate unavailable" rather
  // than ever showing SOL_TEST_PRICE_USD's placeholder on Mainnet.
  const [solPriceUsd, setSolPriceUsd] = useState<number | null>(null);
  useEffect(() => {
    if (!IS_MAINNET) return;
    let cancelled = false;
    fetchAssetPricesUsd([{ mint: WRAPPED_SOL_MINT.toBase58(), decimals: 9 }])
      .then((prices) => {
        if (cancelled) return;
        const info = prices[WRAPPED_SOL_MINT.toBase58()];
        if (info && info.usdPrice !== null && Number.isFinite(info.usdPrice) && info.usdPrice > 0) setSolPriceUsd(info.usdPrice);
      })
      .catch(() => {
        // Best-effort -- the Wallet Cost Summary's SOL amount itself (the
        // number that actually matters for what Phantom will ask for) is
        // computed independently of this and is never affected; only the
        // secondary "(≈ $X)" USD estimate falls back to "unavailable".
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // The permanent metadata URL Review will display and Launch will submit
  // on-chain -- see uploadReserveMetadata's header for the full
  // MetadataUriTooLong root-cause writeup this replaces (the old flow
  // submitted the entire JSON payload inline instead of a short link to it).
  // null while not yet uploaded/uploading/failed; a real https:// URL once ready.
  const [metadataUri, setMetadataUri] = useState<string | null>(null);
  const [metadataUriError, setMetadataUriError] = useState<string | null>(null);
  const [metadataUploading, setMetadataUploading] = useState(false);

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
      estimateCreateReserveCost(connection, realAssets, seedUsd, IS_MAINNET ? (solPriceUsd ?? 0) : SOL_TEST_PRICE_USD, IS_MAINNET)
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
              ? `The Solana ${CLUSTER_LABEL} RPC is temporarily rate-limited. No transaction has been submitted. Please wait a moment and adjust an input to retry.`
              : msg || `Failed to estimate ${CLUSTER_LABEL} transaction costs.`,
          );
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(debounceHandle);
    };
  }, [realDeploymentCandidate, totalWeightForCost, initialSeedUsdc, assets, connection, REAL_ASSET_BY_SYMBOL, solPriceUsd]);

  // Uploads this Reserve's off-chain metadata (name/ticker/description/
  // category/buyTaxPct/sellTaxPct, plus the Step-1 profile picture's
  // permanent URL when one was picked) and resolves the resulting permanent URL
  // BEFORE the user ever reaches Launch -- Review below displays it, and
  // Launch is disabled until it's ready, so an oversized/failed URI is
  // caught long before Phantom would ever open. Debounced the same way as
  // the cost-estimate effect above (typing in Name/Description changes
  // these on every keystroke); re-runs (and re-uploads) whenever the
  // identity fields change, so going back from Review to edit them and
  // returning always reflects the latest content. Content-hashed server-side
  // (see uploadReserveMetadata), so a debounced re-upload of unchanged
  // content is a safe no-op, never a duplicate.
  useEffect(() => {
    if (!realDeploymentCandidate || !name.trim() || !ticker.trim()) {
      setMetadataUri(null);
      setMetadataUriError(null);
      setMetadataUploading(false);
      return;
    }
    let cancelled = false;
    setMetadataUploading(true);
    const debounceHandle = setTimeout(() => {
      (async () => {
        const origin = window.location.origin;
        const cluster = IS_MAINNET ? ("mainnet" as const) : ("devnet" as const);
        // Store the Step-1 picture first (content-addressed, idempotent --
        // a debounced re-upload of the same picture is a no-op server-side)
        // so its permanent URL rides inside the metadata payload below,
        // exactly like a Manage-page picture used to.
        const imageUrl = profileImageDataUrl ? await uploadReserveImage(origin, profileImageDataUrl, cluster) : undefined;
        if (!cancelled) setUploadedProfileImageUrl(imageUrl ?? null);
        return uploadReserveMetadata(
          origin,
          {
            name,
            ticker,
            description,
            category,
            buyTaxPct: managerBuyTaxPct,
            sellTaxPct: managerSellTaxPct,
            ...(imageUrl ? { imageUrl } : {}),
          },
          cluster,
        );
      })()
        .then((uri) => {
          if (cancelled) return;
          setMetadataUri(uri);
          setMetadataUriError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setMetadataUri(null);
          setMetadataUriError(e instanceof Error ? e.message : "Failed to upload Reserve metadata.");
        })
        .finally(() => {
          if (!cancelled) setMetadataUploading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(debounceHandle);
    };
  }, [realDeploymentCandidate, name, ticker, description, category, managerBuyTaxPct, managerSellTaxPct, profileImageDataUrl]);

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
    // A wallet reconnect/refresh always re-derives Resume state fresh from
    // real on-chain data below -- any diagnostic from a PREVIOUS session's
    // failed attempt is stale the moment that happens, never carried forward.
    setResumeError(null);
    const programId = SSR_PROGRAM_ID;
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
    setResumeError(null);
    setCreateStep("fund-seed-assets");
    setJupiterSwapMint(null);
    setFundingProgress(null);
    useAppStore.getState().setTxInFlight(true);
    try {
      const pendingAtStart = resumePending;
      const result = await resumeReserveDeploymentOnChain({
        connection,
        wallet: walletCtx,
        pending: pendingAtStart,
        onProgress: setCreateStep,
        onAssetProgress: setFundingProgress,
        programId: SSR_PROGRAM_ID,
        allowFaucet: !IS_MAINNET,
        jupiterSwap: IS_MAINNET ? { enabled: true, seedTotalUsd: pendingAtStart.seedTotalUsd, onSwapStart: setJupiterSwapMint, onSwapShortfall: handleJupiterSwapShortfall } : undefined,
        // 0 (never the DevNet SOL_TEST_PRICE_USD default) when the real price
        // hasn't loaded yet -- seedRawAmountForAsset throws its own clear
        // error rather than silently wrapping the wrong amount of real SOL.
        solPriceUsd: IS_MAINNET ? (solPriceUsd ?? 0) : SOL_TEST_PRICE_USD,
        clusterLabel: CLUSTER_LABEL,
      });
      finalizeResumedReserve(result, pendingAtStart);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isWalletRejectionError(e)) {
        toast({ title: "Cancelled in wallet", description: "Nothing was submitted -- safe to try Resume again whenever you're ready." });
      } else if (e instanceof CreateReserveStepError && (await reconcileAlreadyCompleteReserve(resumePending))) {
        // Seeding (or an earlier/concurrent attempt) actually succeeded on
        // real, authoritative on-chain state despite this call erroring --
        // already finalized as a success above; nothing further to do here.
      } else if (e instanceof CreateReserveStepError) {
        // Classified so the Resume panel below can tell a genuinely
        // transient failure (safe to just click Resume again) apart from a
        // deterministic one (the exact same transaction will fail again
        // until the underlying configuration/program issue is actually
        // fixed) -- see createReserveResume.ts's classifyCreateReserveError.
        // Never auto-retried either way; every Resume click remains an
        // explicit user action (submittingRef's re-entrancy guard already
        // prevents a duplicate submission while one is in flight).
        const errorClass = classifyCreateReserveError(e);
        const isFeeDestinationCollision = isFeeDestinationCollisionError(e);
        setResumeError({ errorClass, step: e.step, message: describeOnChainError(e), isFeeDestinationCollision });
        // "ambiguous" means a transaction WAS submitted and confirmation
        // simply couldn't be verified within the polling window -- it is
        // NOT a failure (it may already have landed, or still land), so it
        // must never be titled/styled the same as a real failure: doing so
        // is exactly what reads as "stuck in a loop" even though clicking
        // Resume again (which always re-reads real on-chain state first,
        // never blindly resubmits) is the correct, safe recovery action.
        toast(
          errorClass === "ambiguous"
            ? {
                title: `Outcome unknown -- verifying (${CREATE_STEP_LABELS[e.step]})`,
                description: `${msg} This was not a failure -- your Reserve's on-chain identity is unchanged, and Resume will re-check real on-chain state before submitting anything. Click Resume Deployment again once ready.`,
              }
            : {
                variant: "destructive",
                title: `Resume failed (${CREATE_STEP_LABELS[e.step]})`,
                description:
                  errorClass === "deterministic"
                    ? `${msg} -- your Reserve's on-chain identity is unchanged, but this specific failure will not resolve itself on a plain retry. See the details below before trying again.`
                    : `${msg} -- your Reserve's on-chain identity is unchanged. Click Resume Deployment again once ready; nothing already confirmed will be resubmitted.`,
              },
        );
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

  /**
   * Re-reads real on-chain state for the pending Reserve without submitting
   * anything -- lets a user confirm whether a previously-deterministic
   * blocking condition (e.g. the fee-destination collision) has since been
   * resolved (a program upgrade, a ProtocolConfig change) before trying
   * Resume again, rather than either blindly retrying or being permanently
   * stuck behind a stale diagnostic.
   */
  const handleCheckResumeStatusAgain = async () => {
    if (!resumePending || submittingRef.current) return;
    setRecovering(true);
    setResumeError(null);
    try {
      const programId = SSR_PROGRAM_ID;
      const candidateMints = resumePending.assets.map((a) => new PublicKey(a.mint));
      const onChain = await fetchReserveOnChain(connection, programId, new PublicKey(resumePending.reserve), candidateMints);
      const resumePoint = determineDeploymentResumePoint({
        reserveExists: onChain !== null,
        reserveStatus: (onChain?.status as ReserveOnChainStatus | undefined) ?? null,
        onChainAssetCount: onChain?.assetCount ?? 0,
        expectedAssetCount: resumePending.assets.length,
      });
      if (resumePoint.kind === "already-complete") {
        clearPendingReserveDeploy();
        toast({ title: "Deployment already completed", description: `Your Reserve "${resumePending.name}" already finished successfully on-chain.` });
        setResumePending(null);
        setLocation(`/dtr/devnet-${resumePending.reserveId}`);
      } else if (resumePoint.kind === "asset-count-mismatch") {
        setResumeMismatch(
          `On-chain Reserve ${resumePending.reserve} has ${resumePoint.onChainAssetCount} registered asset(s), but this pending deployment expected ${resumePoint.expectedAssetCount}. This needs manual verification on Explorer before continuing.`,
        );
      } else {
        toast({ title: "Still incomplete", description: "This Reserve's seeding still has not completed on-chain. Resume is available whenever you're ready to try again." });
      }
    } catch {
      toast({ variant: "destructive", title: "Could not check status", description: `The on-chain status read itself failed (likely ${CLUSTER_LABEL} RPC congestion) -- this is unrelated to the earlier Resume failure. Try again in a moment.` });
    } finally {
      setRecovering(false);
    }
  };

  /**
   * Explicit, user-initiated abandonment -- the only way this app ever
   * clears a pending-deployment marker without either confirmed on-chain
   * completion or a fresh on-chain read confirming create-and-register never
   * landed at all. Never touches on-chain state and never the Reserve
   * itself, which stays exactly as-is (still real, still discoverable by
   * address, still resumable later by re-adding the marker manually if
   * ever needed) -- this only stops THIS browser from tracking it locally,
   * so the form can be used to start a genuinely separate Reserve instead of
   * being stuck showing this Resume panel forever.
   */
  const handleAbandonPendingDeploy = () => {
    clearPendingReserveDeploy();
    setResumePending(null);
    setResumeError(null);
    toast({
      title: "Stopped tracking this deployment",
      description: `"${resumePending?.name}" (${resumePending?.reserve}) is still real on-chain, unchanged -- this only stops this browser from tracking it. You can now start a new Reserve.`,
    });
  };

  if (recovering) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-4">
          <Rocket className="w-16 h-16 text-primary mx-auto mb-4 animate-pulse" />
          <h1 className="text-2xl font-merge-display font-bold">Recovering...</h1>
          <p className="text-muted-foreground">Checking Solana {CLUSTER_LABEL} for a Reserve creation left in progress before this page reloaded.</p>
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
              <Badge className="font-merge-mono">Solana {CLUSTER_LABEL}</Badge>
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
            {resumeError && resumeError.errorClass === "deterministic" && (
              <div className="p-3 rounded-lg border border-destructive/40 bg-destructive/10 text-sm space-y-2">
                <div className="flex items-center gap-2 font-semibold text-destructive">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {resumeError.isFeeDestinationCollision ? "This Reserve cannot finish seeding yet" : `Resume failed (${CREATE_STEP_LABELS[resumeError.step]})`}
                </div>
                {resumeError.isFeeDestinationCollision ? (
                  <p className="text-muted-foreground">
                    This wallet is both this Reserve's manager and SSR.fun's configured Protocol fee-destination wallet. Completing seeding for this exact combination requires a Protocol
                    program update that has not been deployed to {CLUSTER_LABEL} yet -- retrying will fail the same way every time. Your Reserve's on-chain identity and every already-completed step
                    are unchanged and safe. Contact the SSR.fun team, or check again below in case this has since been resolved.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    {resumeError.message} Your Reserve's on-chain identity is unchanged, but this specific failure will not resolve itself on a plain retry.
                  </p>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t border-border/40 pt-6">
            <Button variant="ghost" size="sm" onClick={handleAbandonPendingDeploy} disabled={isSubmitting} className="text-muted-foreground">
              Cancel Deploy
            </Button>
            <div className="flex items-center gap-2">
            {resumeError && resumeError.errorClass === "deterministic" ? (
              <>
                <Button variant="outline" onClick={handleCheckResumeStatusAgain} disabled={isSubmitting} className="gap-2">
                  Check status again
                </Button>
                <Button variant="secondary" onClick={handleResumeDeployment} disabled={isSubmitting} className="font-bold gap-2 min-w-[180px]">
                  {isSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> {stepLabel(createStep, "Resuming...")}
                    </>
                  ) : (
                    "Try again anyway"
                  )}
                </Button>
              </>
            ) : (
              <Button onClick={handleResumeDeployment} disabled={isSubmitting} className="font-bold gap-2 min-w-[180px]">
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> {stepLabel(createStep, "Resuming...")}
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4" /> Resume Deployment
                  </>
                )}
              </Button>
            )}
            </div>
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
          <h1 className="text-3xl font-merge-display font-bold">Connect Wallet<br />to Deploy</h1>
          {/* Inline margins: FABLE's unlayered element reset zeroes <p> margins
              with higher cascade priority than Tailwind's layered spacing. */}
          <p className="text-muted-foreground" style={{ marginTop: 15, marginBottom: 12 }}>
            You need to connect a wallet to deploy<br />and manage a Reserve.
          </p>
          <Button className="rounded-full h-12 px-10 text-base mt-6" onClick={() => setWalletModalOpen(true)}>
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  const handleNext = () => setStep((s) => Math.min(4, s + 1));
  const handleBack = () => setStep((s) => Math.max(1, s - 1));

  const addAsset = (symbol: string, assetName: string) => {
    // Mirrors the deployed program's own per-Reserve asset limit (see
    // MAX_ASSETS_PER_RESERVE) -- refusing here, before anything is
    // submitted, is what keeps an over-limit basket from starting a
    // deployment the program would reject partway through registration.
    if (assets.length >= MAX_ASSETS_PER_RESERVE) return;
    if (!assets.some(a => a.symbol === symbol)) {
      setAssets([...assets, { symbol, name: assetName, weight: 0.1 }]);
    }
  };
  const atAssetLimit = assets.length >= MAX_ASSETS_PER_RESERVE;

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

  // Every early-out below used to fail completely silently -- confirmed root
  // cause of a live report ("click add it doesn't really add them... just
  // stays there and doesn't do anything", 2026-08-24, road-to-mainnet
  // MCR-01): the single most likely real trigger is the last check below --
  // the Primary Fee Destination field is pre-filled with the connected
  // wallet's own address (DEC-0124), so pasting that SAME address again as
  // an "additional" recipient (an easy thing to do when only one wallet is
  // available to test with) was silently rejected every time. Every guard
  // here now explains itself instead of just returning.
  const addFeeRecipient = () => {
    setFeeRecipientAddError(null);
    const address = newRecipientAddress.trim();
    const pct = parseFloat(newRecipientPct);
    if (!address) {
      setFeeRecipientAddError("Enter a wallet address first.");
      return;
    }
    if (!pct || pct <= 0) {
      setFeeRecipientAddError("Enter a percentage greater than 0.");
      return;
    }
    if (feeRecipients.length + 1 >= 10) {
      setFeeRecipientAddError("Maximum of 10 recipients reached, including the Primary Fee Destination.");
      return;
    }
    if (feeRecipients.some((r) => r.address === address)) {
      setFeeRecipientAddError("That address is already an additional recipient.");
      return;
    }
    if (address === (feeDestination || wallet.address)) {
      setFeeRecipientAddError("That's already the Primary Fee Destination above -- it doesn't need to be added again as an additional recipient.");
      return;
    }
    setFeeRecipients([...feeRecipients, { address, pct }]);
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
    // Blocks before Phantom ever opens -- never a wallet popup followed by a
    // failed/declined on-chain rejection for something checkable up front.
    // Mirrors the Launch button's own disabled condition below; re-checked
    // here too since this handler is the actual point of no return.
    if (metadataUploading || !metadataUri) {
      toast({
        variant: "destructive",
        title: "Metadata not ready",
        description: metadataUriError ?? "Reserve metadata is still uploading -- please wait a moment and try again.",
      });
      return;
    }
    try {
      validateMetadataUri(metadataUri);
    } catch (e) {
      toast({ variant: "destructive", title: "Metadata URL rejected", description: e instanceof Error ? e.message : "Invalid metadata URL." });
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setCreateStep("create-and-register");
    setJupiterSwapMint(null);
    setFundingProgress(null);
    const programId = SSR_PROGRAM_ID;
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
      // Complete launch-feasibility preflight BEFORE creating the Reserve
      // PDA (launchFunding.ts, DEC-0151): per-asset allocation practicality
      // (dust-sized swap allocations are rejected with a precise recommended
      // minimum, never an arbitrary blanket number) and, critically, whether
      // this wallet actually holds enough USDC for the whole funding plan --
      // the confirmed root cause of Reserve 11's five consecutive Jupiter
      // 6024 (InsufficientFunds) failures was a launch started against a
      // wallet holding $0.49 USDC. An RPC failure READING the balance never
      // blocks the launch (the per-swap preflight inside funding still
      // guards) -- only a real, readable insufficiency does.
      if (IS_MAINNET) {
        let walletUsdcRaw: bigint | null = null;
        try {
          walletUsdcRaw = BigInt(await fetchTokenBalanceRaw(connection, new PublicKey(MAINNET_USDC_MINT), walletCtx.publicKey));
        } catch {
          walletUsdcRaw = null;
        }
        if (walletUsdcRaw !== null) {
          const plan: LaunchAssetPlan[] = realAssets.map((a) => ({
            mint: a.mint,
            seedWeightFraction: a.seedWeightFraction,
            kind: a.mint === MAINNET_USDC_MINT ? ("usdc" as const) : a.mint === WRAPPED_SOL_MINT.toBase58() ? ("wrapped-sol" as const) : ("swap" as const),
          }));
          const feasibility = assessLaunchFeasibility({ assets: plan, seedTotalUsd, walletUsdcRaw });
          if (!feasibility.feasible) {
            toast({
              variant: "destructive",
              title: "This launch isn't fundable yet",
              description: `${feasibility.reasons.join(". ")}.${
                feasibility.minimumRecommendedSeedUsd > seedTotalUsd
                  ? ` The recommended minimum initial amount for this composition is $${feasibility.minimumRecommendedSeedUsd.toFixed(2)}.`
                  : ""
              } Nothing was created on-chain.`,
            });
            return;
          }
        }
      }

      const result = await createReserveOnChain({
        connection,
        wallet: walletCtx,
        metadataUri,
        mintFeeBps: Math.round(mintFeePct * 100),
        tvlFeeBps: Math.round(tvlFeePct * 100),
        feeDestination: feeDestinationKey,
        feeRecipients: recipientsForChain,
        additionalManagers,
        assets: realAssets,
        seedTotalUsd,
        programId: SSR_PROGRAM_ID,
        allowFaucet: !IS_MAINNET,
        jupiterSwap: IS_MAINNET ? { enabled: true, seedTotalUsd, onSwapStart: setJupiterSwapMint, onSwapShortfall: handleJupiterSwapShortfall } : undefined,
        // 0 (never the DevNet SOL_TEST_PRICE_USD default) when the real price
        // hasn't loaded yet -- seedRawAmountForAsset throws its own clear
        // error rather than silently wrapping the wrong amount of real SOL.
        solPriceUsd: IS_MAINNET ? (solPriceUsd ?? 0) : SOL_TEST_PRICE_USD,
        clusterLabel: CLUSTER_LABEL,
        onProgress: setCreateStep,
        onAssetProgress: setFundingProgress,
        // Persist per-asset funding progress on every transition so a
        // refresh/reconnect resumes from the first genuinely unresolved
        // asset, reconciling any submitted swap signature instead of
        // re-swapping (launchFunding.ts, DEC-0151).
        onFundingStateChange: (record) => savePendingAssetFunding(walletCtx.publicKey!.toBase58(), record),
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
            assets: realAssets.map((a) => ({ mint: a.mint, decimals: a.decimals, seedWeightFraction: a.seedWeightFraction, weightBps: a.weightBps })),
            seedTotalUsd,
          });
        },
      });
      clearPendingReserveDeploy();

      // Point the new Reserve's mutable picture pointer at the Step-1
      // picture so later signature-free edits and the pointer-map display
      // path both start out consistent. Best-effort: the metadata payload
      // submitted on-chain above already embeds the same picture's
      // content-addressed URL, so a failure here changes nothing visible.
      if (profileImageDataUrl) {
        void uploadReserveImage(window.location.origin, profileImageDataUrl, IS_MAINNET ? "mainnet" : "devnet", result.reserve).catch(() => {});
      }

      // Must match RealReserveSync.tsx's own `${SOLANA_CLUSTER}-${reserveId}`
      // id scheme exactly (see onChainReserve.ts's buildDtrFromDiscoveredReserve)
      // -- a mismatched prefix here would register this freshly-created
      // Reserve under a DIFFERENT dtrId than the one the next discovery poll
      // derives for the same on-chain account, producing two DTR entries for
      // one real Reserve.
      const dtrId = `${SOLANA_CLUSTER}-${result.reserveId}`;
      const onChain: OnChainReserveMeta = {
        programId: SSR_PROGRAM_ID.toBase58(),
        reserveId: result.reserveId,
        reserve: result.reserve,
        reserveTokenMint: result.reserveTokenMint,
        mintAuthority: result.mintAuthority,
        vaultAuthority: result.vaultAuthority,
        manager: walletCtx.publicKey.toBase58(),
        assets: result.assets.map((a, i) => ({
          mint: a.mint,
          symbol: SELECTABLE_ASSETS.find((m) => m.mint === a.mint)?.symbol ?? "?",
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
        tags: [category, SOLANA_CLUSTER, "real"],
        logoSeed: dtrId,
        logoUrl: uploadedProfileImageUrl ?? undefined,
        dtrAddress: result.reserve,
        managerAddress: walletCtx.publicKey.toBase58(),
        delegates: [],
        feeConfig: {
          mintFeePct,
          tvlFeePct,
          // Forward-looking secondary-market configuration -- stored on-chain
          // in metadataUri, not enforced by mint/redeem (see the Fee
          // Configuration step's copy).
          managerBuyTaxPct,
          managerSellTaxPct,
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
      // So THIS browser's own just-created Reserve is discoverable
      // immediately, before api/ledger/known-asset-mints.ts's daily-refreshed
      // list would otherwise catch up -- see useAppStore.mainnetKnownAssetMints.
      if (IS_MAINNET) addKnownAssetMints(realAssets.map((a) => a.mint));

      // One-approval trading from day one (DEC-0171): create + register the
      // Reserve's trading lookup table as the deployment's final step, so
      // this Reserve's very first Buy/Sell composes into a single wallet
      // approval instead of falling back to the multi-approval flow (the
      // exact gap behind the live 2026-08-27 four-approval ECHO purchase:
      // no Reserve had a table registered). Best-effort by design: the
      // Reserve is already fully deployed at this point, so a declined
      // popup or a transient failure loses nothing -- trading falls back
      // exactly as before, and the table can be added later from Manage or
      // automatically on the first trade that needs it.
      if (IS_MAINNET) {
        try {
          setCreateStep(null);
          await createAndRegisterReserveAlt(connection, walletCtx, {
            ssrProgramId: SSR_PROGRAM_ID,
            reserve: new PublicKey(result.reserve),
            reserveTokenMint: new PublicKey(result.reserveTokenMint),
            mintAuthority: new PublicKey(result.mintAuthority),
            vaultAuthority: new PublicKey(result.vaultAuthority),
            protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
            assets: result.assets.map((a) => ({ mint: a.mint, reserveAsset: a.reserveAsset, vault: a.vault })),
          });
          toast({ title: "One-approval trading enabled", description: "Buys and Sells of this Reserve complete in a single wallet approval for every trader." });
        } catch {
          toast({
            title: "One-approval trading not enabled yet",
            description: "Your Reserve is fully deployed. This optional setup was skipped -- it can be enabled any time from the Manage page, and the first trade that needs it will offer it again.",
          });
        }
      }

      toast({
        title: `Reserve deployed on Solana ${IS_MAINNET ? "Mainnet" : "DevNet"}`,
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
        // Before reporting failure, re-check the AUTHORITATIVE on-chain
        // Reserve state directly -- a wallet-side error (RPC confirmation
        // timeout, a stale local balance read used only for the error
        // message, etc.) does not necessarily mean the on-chain transaction
        // itself didn't land. checkReserveGenuinelyComplete is strictly
        // read-only, so this can never resubmit or double-submit whatever
        // just (apparently) failed -- see docs/project/DECISION_LOG.md's
        // entry for this pass for the live incident this fixes (Creator
        // received the correct Reserve Token amount on-chain while the UI
        // still reported "received less than expected: 0%").
        if (await reconcileAlreadyCompleteReserve(resumable)) return;
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
            description: `${msg} -- could not verify on-chain state right now (${CLUSTER_LABEL} RPC congestion). Do not retry until you've confirmed via Discover or Explorer whether this Reserve was created.`,
          });
        } else {
          clearPendingReserveDeploy();
          const isRateLimited = msg.includes("429") || msg.toLowerCase().includes("too many requests");
          toast({
            variant: "destructive",
            title: `Deployment Failed (${CREATE_STEP_LABELS["create-and-register"]})`,
            description: isRateLimited
              ? `The Solana ${CLUSTER_LABEL} RPC is temporarily rate-limited. No transaction has been submitted -- safe to retry shortly.`
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
            ? `The Solana ${CLUSTER_LABEL} RPC is temporarily rate-limited. No transaction has been submitted. Please retry shortly.`
            : msg || `The ${CLUSTER_LABEL} Reserve creation failed.`,
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
  // path: every selectable asset now comes from SELECTABLE_ASSETS, so it
  // should always be true once at least one asset is selected.
  const handleSubmit = handleSubmitReal;

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 relative">
      {/* Full-bleed hero art behind the page top (public/create-hero.jpg) —
          the shared mascot-hero treatment: left scrim for the title, bottom
          fade into the ground, hides itself if the file is absent. */}
      <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[460px] overflow-hidden pointer-events-none -z-10">
        <img
          src="/create-hero.jpg"
          alt=""
          className="w-full h-full object-cover"
          style={{ objectPosition: "center 9%" }}
          onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
        />
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, hsl(var(--background) / 0.78) 0%, hsl(var(--background) / 0.25) 45%, hsl(var(--background) / 0.05) 100%)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 0%, hsl(var(--background) / 0.15) 68%, hsl(var(--background)) 100%)" }} />
      </div>

      <div className="mb-8">
        <h1 className="text-4xl font-merge-display font-bold mb-2">Launch a Reserve</h1>
        <p className="text-muted-foreground">Launch a new Reserve on SSR.FUN, live on Solana {CLUSTER_LABEL}.</p>
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
              <div className="space-y-2">
                <Label>Profile Picture (optional)</Label>
                <div className="flex items-start gap-4">
                  <Avatar className="h-16 w-16 border-2 border-border shadow-md">
                    {profileImageDataUrl && <AvatarImage src={profileImageDataUrl} alt={ticker || "Reserve"} />}
                    <AvatarFallback className="bg-primary/10 text-primary text-xl font-merge-display font-bold">
                      {ticker.slice(0, 2) || "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="space-y-2">
                    <input
                      ref={profileImageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) => {
                        void handlePickProfileImage(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => profileImageInputRef.current?.click()}>
                        Choose Image
                      </Button>
                      {profileImageDataUrl && (
                        <Button variant="ghost" size="sm" onClick={() => setProfileImageDataUrl(null)}>
                          Remove
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Shown next to this Reserve everywhere in the app. PNG, JPEG, WebP, or GIF -- large images are resized automatically. You can also add or change it later from the Manage page.
                    </p>
                  </div>
                </div>
                {profileImageError && <p className="text-sm text-destructive">{profileImageError}</p>}
              </div>

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
                  {IS_MAINNET && mainnetCatalogue.status === "loading" && (
                    <p className="text-xs text-muted-foreground">Loading the full Mainnet asset list...</p>
                  )}
                  {IS_MAINNET && mainnetCatalogue.status === "unavailable" && (
                    <p className="text-xs text-muted-foreground">Showing USDC only -- the full Mainnet asset list is temporarily unavailable.</p>
                  )}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by name, ticker, or contract address..."
                      className="pl-9"
                      value={assetSearch}
                      onChange={(e) => setAssetSearch(e.target.value)}
                    />
                  </div>

                  <div className="border border-border rounded-lg max-h-[300px] overflow-y-auto p-2 bg-muted/20 space-y-1">
                    {SELECTABLE_ASSETS
                      .filter(a => !assets.some(selected => selected.symbol === a.symbol))
                      .filter(a => matchesAssetSearch(a, assetSearch))
                      .map(asset => (
                        <div key={asset.symbol} className="flex items-center justify-between p-2 hover:bg-muted rounded-md transition-colors">
                          <div>
                            <span className="font-semibold">{asset.name}</span>
                            <span className="text-xs text-muted-foreground ml-2 font-merge-mono">{asset.symbol}</span>
                            <div className="text-xs text-muted-foreground font-merge-mono">{asset.mint.slice(0, 4)}...{asset.mint.slice(-4)}</div>
                          </div>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={atAssetLimit} onClick={() => addAsset(asset.symbol, asset.name)}>
                            <Plus className="w-4 h-4 text-primary" />
                          </Button>
                        </div>
                      ))}
                      {atAssetLimit && (
                        <div className="p-3 text-center text-sm text-muted-foreground">
                          This Reserve holds the maximum of {MAX_ASSETS_PER_RESERVE} assets. Remove one to add a different asset.
                        </div>
                      )}
                      {(() => {
                        const remaining = SELECTABLE_ASSETS.filter(a => !assets.some(selected => selected.symbol === a.symbol));
                        if (remaining.length === 0) {
                          return <div className="p-4 text-center text-sm text-muted-foreground">All available assets added.</div>;
                        }
                        const noMatches = assetSearch.trim().length > 0 && remaining.every((a) => !matchesAssetSearch(a, assetSearch));
                        if (noMatches) {
                          return <div className="p-4 text-center text-sm text-muted-foreground">No assets match "{assetSearch.trim()}".</div>;
                        }
                        return null;
                      })()}
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
                        ? IS_MAINNET
                          ? "The USD value to seed the reserve with, funded directly from this wallet's real USDC balance."
                          : "The USD value to seed the reserve with. You'll provide the equivalent DevNet SOL shown below -- it's converted into the selected reserve assets and deposited for you."
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
                  {isRealDeployment && !IS_MAINNET ? (
                    <p className="text-xs text-muted-foreground flex justify-between">
                      <span>
                        &asymp; <span className="font-merge-mono">{((parseFloat(initialSeedUsdc) || 0) / SOL_TEST_PRICE_USD).toFixed(5)} SOL</span> at the DevNet test price of ${SOL_TEST_PRICE_USD.toFixed(2)}/SOL
                      </span>
                    </p>
                  ) : isRealDeployment ? (
                    <p className="text-xs text-muted-foreground flex justify-between">
                      <span>Funded directly in USDC from this wallet.</span>
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
                  Setting the Mint Fee or TVL Fee to 0% means neither the Protocol nor the Manager collects anything -- there is no forced minimum fee.
                  For any fee you set above 0%, SSR.fun always keeps at least 0.5% for the protocol; above that 0.5% floor, the Protocol and Manager
                  split the configured fee 50/50.
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
                      <span className="font-merge-mono text-primary">{managerBuyTaxPct.toFixed(2)}%</span>
                    </Label>
                    <Slider
                      value={[managerBuyTaxPct]}
                      max={2}
                      step={0.05}
                      onValueChange={(v) => setManagerBuyTaxPct(v[0])}
                    />
                    <p className="text-xs text-muted-foreground">
                      For future secondary-market trading (e.g. a DEX listing) -- not applied when minting directly from the Reserve. Default is 0%.
                    </p>
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
                    <p className="text-xs text-muted-foreground">
                      For future secondary-market trading (e.g. a DEX listing) -- not applied when redeeming directly from the Reserve. Default is 0%.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground italic">
                  Buy Tax and Sell Tax are saved with this Reserve for when a secondary market exists, but are not enforced by any on-chain instruction today -- minting and redeeming directly from the Reserve are never taxed.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-semibold text-lg pb-2">Fee Routing</h3>
                <div className="space-y-2">
                  <Label htmlFor="dest">Primary Fee Destination Wallet</Label>
                  <Input
                    id="dest"
                    value={feeDestination}
                    onChange={(e) => {
                      feeDestinationUserEditedRef.current = true;
                      setFeeDestination(e.target.value);
                    }}
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
                        onChange={(e) => {
                          setNewRecipientAddress(e.target.value);
                          setFeeRecipientAddError(null);
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="%"
                        className="w-24 font-merge-mono"
                        min="0"
                        max="100"
                        value={newRecipientPct}
                        onChange={(e) => {
                          setNewRecipientPct(e.target.value);
                          setFeeRecipientAddError(null);
                        }}
                      />
                      <Button variant="outline" onClick={addFeeRecipient} className="shrink-0 gap-1.5">
                        <Plus className="w-4 h-4" /> Add
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Maximum of 10 recipients reached, including the Primary Fee Destination.</p>
                  )}
                  {feeRecipientAddError && (
                    <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>{feeRecipientAddError}</p>
                    </div>
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
                {isRealDeployment && <Badge className="font-merge-mono">Solana {CLUSTER_LABEL}</Badge>}
              </CardTitle>
              <CardDescription>
                {isRealDeployment
                  ? `This will submit real transactions to the deployed SSR Protocol program on Solana ${CLUSTER_LABEL}.`
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
                          <span className="text-muted-foreground"> (see Wallet Cost Summary below for the exact {IS_MAINNET ? "USDC and SOL" : "SOL"} requested)</span>
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
                      <span className="text-muted-foreground">Buy Tax (future secondary market)</span>
                      <span className="font-merge-mono font-medium">{managerBuyTaxPct.toFixed(2)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Sell Tax (future secondary market)</span>
                      <span className="font-merge-mono font-medium">{managerSellTaxPct.toFixed(2)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {isRealDeployment && (
                <div className={`bg-card border rounded-xl overflow-hidden ${metadataUriError ? "border-destructive/50" : "border-border"}`}>
                  <div className="bg-muted/50 p-4 border-b border-border">
                    <h3 className="font-semibold flex items-center gap-2">
                      Reserve Metadata URL
                      <InfoTip label="More information about the Reserve metadata URL">
                        Your Reserve's name, ticker, description, and category are stored at this permanent URL -- only this short link (never the text itself) is submitted on-chain, since Solana account space is limited.
                      </InfoTip>
                    </h3>
                  </div>
                  <div className="p-4">
                    {metadataUploading && (
                      <p className="text-sm text-muted-foreground flex items-center gap-2">
                        <div className="w-3.5 h-3.5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" /> Uploading metadata...
                      </p>
                    )}
                    {!metadataUploading && metadataUriError && (
                      <p className="text-sm text-destructive">{metadataUriError}</p>
                    )}
                    {!metadataUploading && !metadataUriError && metadataUri && (
                      <p className="text-sm font-merge-mono break-all">{metadataUri}</p>
                    )}
                    {!metadataUploading && !metadataUriError && !metadataUri && (
                      <p className="text-sm text-muted-foreground">Enter a Name and Ticker to generate a metadata URL.</p>
                    )}
                  </div>
                </div>
              )}

              {isRealDeployment && (
                <div className="bg-card border border-primary/30 rounded-xl overflow-hidden">
                  <div className="bg-primary/5 p-4 border-b border-border">
                    <h3 className="font-semibold flex items-center gap-2">
                      Wallet Cost Summary
                      <InfoTip label="More information about the wallet cost summary">
                        {IS_MAINNET
                          ? "Everything this wallet will be asked to spend, shown before Phantom does: your Reserve's assets are paid in USDC (plus wrapped SOL for a SOL holding), while account rent and network fees are paid in SOL. Totals are across every transaction below -- Phantom shows one popup per transaction, so any single popup will show less than the total."
                          : "Every SOL this wallet will actually be asked to spend, shown before Phantom does. This is the TOTAL across every transaction below -- Phantom shows one popup per transaction, so any single popup will show less than this total, not the same number."}
                      </InfoTip>
                    </h3>
                  </div>
                  <div className="p-4 space-y-3">
                    {costEstimateError && (
                      <p className="text-sm text-destructive">{costEstimateError}</p>
                    )}
                    {!costEstimateError && !costEstimate && (
                      <p className="text-sm text-muted-foreground">Estimating costs from live {CLUSTER_LABEL} rent rates...</p>
                    )}
                    {costEstimate && (() => {
                      // The three-section Mainnet layout (DEC-0153, requested
                      // by Creator): (1) what goes INTO the Reserve, in USD,
                      // split by the currency it's actually paid in; (2) fees
                      // and overhead in their native currency (SOL); (3)
                      // totals in USD. DevNet keeps the original SOL-only
                      // layout (its assets are faucet-minted test tokens with
                      // no USDC involved).
                      const seedTotalUsdUi = parseFloat(initialSeedUsdc) || 10;
                      const solFraction = totalWeight > 0 ? assets.filter((a) => a.symbol === "SOL").reduce((s, a) => s + a.weight, 0) / totalWeight : 0;
                      const solLegUsd = seedTotalUsdUi * solFraction;
                      const usdcCapitalUsd = Math.max(0, seedTotalUsdUi - solLegUsd);
                      // Matches the launch-feasibility preflight's own buffer
                      // exactly (assessLaunchFeasibility) -- the wallet-should-
                      // hold figure shown here is the same number the preflight
                      // enforces at submit.
                      const usdcToHoldUsd = usdcCapitalUsd * (1 + DEFAULT_FEE_BUFFER_FRACTION);
                      const overheadLamports = costEstimate.totalRentLamports + costEstimate.networkFeeLamportsEstimate;
                      const solToUsd = (lamports: bigint): number | null =>
                        IS_MAINNET ? (solPriceUsd !== null ? (Number(lamports) / 1e9) * solPriceUsd : null) : (Number(lamports) / 1e9) * SOL_TEST_PRICE_USD;
                      const overheadUsd = solToUsd(overheadLamports);
                      const fmtUsd = (v: number | null) => (v === null ? "USD unavailable" : `$${v.toFixed(2)}`);

                      if (!IS_MAINNET) {
                        return (
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
                            <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                              <span>Estimated total SOL required</span>
                              <span className="font-merge-mono text-primary">
                                {(Number(costEstimate.totalLamports) / 1e9).toFixed(5)} SOL
                                <span className="text-muted-foreground font-normal"> (&asymp; ${((Number(costEstimate.totalLamports) / 1e9) * SOL_TEST_PRICE_USD).toFixed(2)})</span>
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Total across all {costEstimate.numTransactions} transactions above -- each Phantom popup below will ask for only its own share of this, never this full amount at once.
                            </p>
                          </>
                        );
                      }

                      return (
                        <>
                          <p className="text-xs font-semibold text-foreground">Goes into your Reserve (its actual holdings)</p>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground flex items-center gap-1">
                              Paid in USDC
                              <InfoTip label="More information about the USDC-funded portion">
                                Funds this Reserve's USDC holding and buys each other asset for you via a real Jupiter swap. Your wallet should hold about {fmtUsd(usdcToHoldUsd)} USDC -- the extra {(DEFAULT_FEE_BUFFER_FRACTION * 100).toFixed(0)}% covers swap fees and price movement, and whatever the swaps don't use stays in your wallet. This is checked before anything is created.
                              </InfoTip>
                            </span>
                            <span className="font-merge-mono">
                              {fmtUsd(usdcCapitalUsd)}
                              {usdcCapitalUsd > 0 && <span className="text-muted-foreground"> (hold &asymp; {fmtUsd(usdcToHoldUsd)} USDC)</span>}
                            </span>
                          </div>
                          {solLegUsd > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground flex items-center gap-1">
                                Paid by wrapping your SOL
                                <InfoTip label="More information about the SOL-funded portion">This Reserve holds SOL, and that holding is funded by wrapping your own SOL directly -- no USDC is spent for it.</InfoTip>
                              </span>
                              <span className="font-merge-mono">
                                {fmtUsd(solLegUsd)}
                                <span className="text-muted-foreground"> ({(Number(costEstimate.solSeedFundingLamports) / 1e9).toFixed(5)} SOL)</span>
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between text-sm font-semibold">
                            <span>Reserve assets subtotal</span>
                            <span className="font-merge-mono">${seedTotalUsdUi.toFixed(2)}</span>
                          </div>

                          <p className="pt-3 border-t border-border/50 text-xs font-semibold text-foreground">Fees &amp; overhead (paid in SOL)</p>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground flex items-center gap-1">
                              Account creation &amp; rent
                              <InfoTip label="More information about account creation and rent">Solana requires new accounts (the Reserve, its assets, vaults, and Reserve Token mint) to be rent-exempt -- this SOL isn't a fee, it stays locked in those accounts.</InfoTip>
                            </span>
                            <span className="font-merge-mono">
                              {(Number(costEstimate.totalRentLamports) / 1e9).toFixed(5)} SOL
                              <span className="text-muted-foreground"> (&asymp; {fmtUsd(solToUsd(costEstimate.totalRentLamports))})</span>
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Estimated network fees ({costEstimate.numTransactions} transactions)</span>
                            <span className="font-merge-mono">
                              {(Number(costEstimate.networkFeeLamportsEstimate) / 1e9).toFixed(5)} SOL
                              <span className="text-muted-foreground"> (&asymp; {fmtUsd(solToUsd(costEstimate.networkFeeLamportsEstimate))})</span>
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground flex items-center gap-1">
                              Protocol fees
                              <InfoTip label="More information about protocol fees">No fee is charged at creation itself -- Mint Fee ({mintFeePct.toFixed(2)}%) and TVL Fee ({tvlFeePct.toFixed(2)}%) apply to future Buy/holding activity, configured above.</InfoTip>
                            </span>
                            <span className="font-merge-mono text-muted-foreground">$0.00 now</span>
                          </div>

                          <div className="pt-3 border-t border-border/50 space-y-1.5">
                            <div className="flex justify-between text-sm font-semibold">
                              <span>Total (USD)</span>
                              <span className="font-merge-mono text-primary">
                                {overheadUsd === null ? `$${seedTotalUsdUi.toFixed(2)} + SOL overhead (USD unavailable)` : `≈ $${(seedTotalUsdUi + overheadUsd).toFixed(2)}`}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Requested as {(Number(costEstimate.totalLamports) / 1e9).toFixed(5)} SOL
                              {usdcCapitalUsd > 0 ? <> plus &asymp; {fmtUsd(usdcToHoldUsd)} of your USDC</> : null}, across {costEstimate.numTransactions} transactions -- each Phantom popup asks for only its own share, never the full amount at once.
                            </p>
                          </div>
                        </>
                      );
                    })()}
                    <div className="pt-3 border-t border-border/50 space-y-1.5 text-xs text-muted-foreground">
                      {(() => {
                        // Registering many assets can take more than one transaction --
                        // Solana caps a single transaction's size, and a large asset
                        // selection (roughly 7+) doesn't fit alongside creating the
                        // Reserve in just one (see createReserveClient.ts's
                        // packInstructionsBySize). registerBatches here is the same
                        // conservative estimate costEstimate.numTransactions itself uses
                        // -- the real submission splits by exact measured size, so the
                        // real count in the popups below may differ slightly.
                        const registerBatches = Math.max(1, Math.ceil(assets.length / 6));
                        const needsSolWrap = assets.some((a) => a.symbol === "SOL");
                        // Mainnet only: one wallet-approved Jupiter swap per non-USDC,
                        // non-SOL asset -- the same per-mint filter
                        // estimateCreateReserveCost's jupiterSwapCount uses, so the
                        // steps listed here always add up to the headline count. An
                        // asset the wallet already holds enough of skips its swap at
                        // launch time, which is why the headline says "up to".
                        const swapCount = IS_MAINNET ? assets.filter((a) => a.symbol !== "SOL" && REAL_ASSET_BY_SYMBOL.get(a.symbol)?.mint !== MAINNET_USDC_MINT).length : 0;
                        // +1 on Mainnet: the optional one-approval-trading
                        // setup that runs as deployment's final step (DEC-0171).
                        const approvals = (costEstimate ? costEstimate.numTransactions : expectedApprovalCount(assets) + swapCount) + (IS_MAINNET ? 1 : 0);
                        let step = 1;
                        const lines: ReactNode[] = [];
                        if (registerBatches === 1) {
                          lines.push(
                            <p key="register">
                              {step++}. Create the Reserve + register {assets.length} reserve asset{assets.length === 1 ? "" : "s"} (one transaction)
                            </p>,
                          );
                        } else {
                          lines.push(
                            <p key="register">
                              {step++}. Create the Reserve, then register {assets.length} reserve assets across {registerBatches} transactions -- Solana limits how many can fit in one
                            </p>,
                          );
                        }
                        if (needsSolWrap) lines.push(<p key="wrap">{step++}. Wrap your SOL for the seed deposit</p>);
                        if (swapCount > 0) {
                          lines.push(
                            <p key="swaps">
                              {swapCount > 1 ? `${step}-${step + swapCount - 1}` : step}. Swap your USDC for {swapCount === 1 ? "the other reserve asset" : `each of the other ${swapCount} reserve assets`} (one approval per
                              swap; an asset your wallet already holds enough of is skipped)
                            </p>,
                          );
                          step += swapCount;
                        }
                        lines.push(<p key="seed">{step++}. Seed the Reserve (deposits the assets, mints your initial Reserve Tokens)</p>);
                        if (IS_MAINNET) {
                          lines.push(
                            <p key="alt">
                              {step}. Enable one-approval trading (optional one-time setup, ~0.002 SOL -- future buys and sells of this Reserve then need a single wallet approval; skipping it changes nothing else)
                            </p>,
                          );
                        }
                        return (
                          <>
                            <p className="font-semibold text-foreground">
                              This will request {swapCount > 0 ? "up to " : ""}
                              {approvals} wallet approvals:
                            </p>
                            {lines}
                          </>
                        );
                      })()}
                      {(() => {
                        const grossSeedTokens = Math.max(1, Math.floor(parseFloat(initialSeedUsdc) || 10));
                        const split = computeEffectiveFeeSplit(BigInt(Math.round(mintFeePct * 100)), PROTOCOL_MIN_MINT_FEE_BPS);
                        const netSeedTokens = estimateNetSeedReserveTokens(grossSeedTokens, mintFeePct);
                        // On Mainnet, any non-SOL asset is paid for in USDC (directly
                        // for the USDC holding, via Jupiter swaps for the rest) -- say
                        // so, rather than describing only the SOL side of the spend.
                        const spendsUsdc = IS_MAINNET && assets.some((a) => a.symbol !== "SOL");
                        return (
                          <p className="pt-1">
                            Expected result: you'll spend the {spendsUsdc ? "SOL and USDC" : "SOL"} above and receive{" "}
                            <span className="font-merge-mono text-foreground">
                              ~{netSeedTokens.toLocaleString(undefined, { maximumFractionDigits: 6 })} {ticker || "Reserve"}
                            </span>{" "}
                            tokens
                            -- the initial seed is a mint like any other, so the {(Number(split.effectiveTotalBps) / 100).toFixed(2)}% Protocol + Manager mint fee applies to it too. Any test-asset
                            amounts appearing and disappearing from your wallet mid-flow (e.g. minted then immediately deposited) are expected intermediate steps, not final balances -- deployment
                            isn't complete until the last step confirms.
                          </p>
                        );
                      })()}
                      <p>Newly created tokens can take a few minutes to show a name/symbol in Phantom instead of "Unknown" -- this is a {CLUSTER_LABEL} metadata-indexing delay, not an error.</p>
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
                disabled={isSubmitting || !isRealDeployment || (!costEstimate && !costEstimateError) || metadataUploading || !metadataUri}
                title={
                  !isRealDeployment
                    ? `Every selected asset must be a supported real ${CLUSTER_LABEL} asset.`
                    : !costEstimate && !costEstimateError
                      ? "Calculating launch cost..."
                      : metadataUploading
                        ? "Uploading Reserve metadata..."
                        : !metadataUri
                          ? (metadataUriError ?? "Enter a Name and Ticker so Reserve metadata can be uploaded.")
                          : undefined
                }
                className="font-bold gap-2 min-w-[150px]"
              >
                {isSubmitting ? (
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> {stepLabel(createStep, "Deploying...")}</>
                ) : !costEstimate && !costEstimateError ? (
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Calculating cost...</>
                ) : metadataUploading ? (
                  <><div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Uploading metadata...</>
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