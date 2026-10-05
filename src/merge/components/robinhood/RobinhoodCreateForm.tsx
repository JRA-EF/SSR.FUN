// The Robinhood Chain branch of the Launch page -- the same four-step wizard
// as the Solana one (CreateDTR.tsx), step for step:
//
//   1. Identity    the chain choice, then exactly the Solana fields, stored
//                  the same way (profile picture / header to the image
//                  store, text + links to the metadata store, the payload's
//                  permanent URL on-chain as the Folio `mandate`).
//   2. Composition the live asset catalogue (api/robinhood/asset-catalogue:
//                  Robinhood stock tokens proven by their code, plus every
//                  launchpad token with a real Uniswap pool), target weights
//                  with sliders, the unallocated rest staying in USDG.
//   3. Economics   ONE initial amount in USDG (never a share count), mint
//                  and TVL fee sliders with the effective protocol/manager
//                  split, fee routing (primary + additional recipients),
//                  co-managers.
//   4. Review      the summary, the metadata URL, a Wallet Cost Summary and
//                  the list of wallet prompts, then Launch.
//
// Launch buys each non-cash leg with the creator's USDG on Uniswap v3
// (lib/evmSwap.ts), deposits the cash leg directly, and deploys with initial
// shares equal to the USDG put in -- one Reserve Token per dollar, as on
// Solana; afterwards the contract mints and redeems against NAV. The
// sequencing is lib/evmLaunch.ts; the arithmetic lib/evmLaunchPlan.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { zeroAddress } from "viem";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { LaunchShell } from "@/components/LaunchHero";
import { InfoTip } from "@/components/InfoTip";
import { AlertCircle, ChevronLeft, ChevronRight, Plus, Rocket, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ERC20_ABI, FEE_REGISTRY_ABI, LIMITS, ROBINHOOD, SAFE_REBALANCE_DEFAULTS, USDG, WETH } from "@/lib/evmChain";
import { describeEvmError, fmtUnits, publicClientFor, rhReserveId } from "@/lib/evmReserve";
import { invalidateRobinhoodReserves } from "@/hooks/useRobinhoodReserves";
import { useRobinhoodAssetCatalogue, type RobinhoodAsset } from "@/hooks/useRobinhoodAssetCatalogue";
import { RESERVE_CATEGORIES, DEFAULT_RESERVE_CATEGORY, type FeeRecipient } from "@/lib/types";
import { TICKER_MAX_LENGTH, formatUsdc } from "@/lib/calculations";
import { assignRemainder, clearAll, splitEvenly, unallocatedBps } from "@/lib/basketAllocation";
import { fileToHeaderImageDataUrl, fileToProfileImageDataUrl, fitHeaderImageDataUrl, uploadReserveImage } from "@/lib/reserveImageClient";
import { uploadReserveMetadata, type ReserveMetadataInput } from "@/lib/createReserveClient";
import { normalizeYouTubeChannelUrl, parseYouTubeVideoId } from "@/lib/youtube";
import {
  RH_MAX_ASSETS_PER_RESERVE,
  coManagersForChain,
  d18ToPercent,
  effectiveFeeSplit,
  estimateLaunchGas,
  feeRecipientsForChain,
  fmtUsdg,
  launchSteps,
  parseUsdgAmount,
  percentToD18,
  planLaunch,
  type LaunchPlan,
  type PlannedAsset,
} from "@/lib/evmLaunchPlan";
import { executeLaunch, quoteLaunch, type LegQuote } from "@/lib/evmLaunch";
import { connectEvmWallet, useEvmWallet } from "./useEvmWallet";

const cfg = ROBINHOOD;
const pc = publicClientFor(cfg);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
type Status = { text: string; kind: "ok" | "err" | "busy" } | null;

/** A selected basket row: a catalogue asset plus its target weight (fraction of 1). */
interface BasketAsset extends RobinhoodAsset {
  weight: number;
}

type IssuerFilter = "all" | "robinhood" | "other";
const ISSUER_FILTER_OPTIONS: { value: IssuerFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "robinhood", label: "Stock tokens (Robinhood)" },
  { value: "other", label: "Other Robinhood Chain tokens" },
];

/** The cash leg is a constant the form knows even when the catalogue is unavailable. */
const USDG_ASSET: RobinhoodAsset = { address: USDG, symbol: "USDG", name: "Global Dollar", decimals: 6, issuer: null, pool: null, depthUsd: null, priceUsd: 1 };

function matchesSearch(a: RobinhoodAsset, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return a.symbol.toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || a.address.toLowerCase().includes(s);
}

/**
 * The featured-video link as a permanent HTTPS URL for the metadata store:
 * a bare id or any YouTube URL shape becomes a canonical watch link, anything
 * else gets a scheme if it lacks one (the server refuses non-HTTPS links).
 */
function normalizeFeaturedVideoUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const id = parseYouTubeVideoId(raw);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
}

const usd = (n: number | null, digits = 2) => (n === null ? "USD unavailable" : `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);

export function RobinhoodCreateForm({ chainPicker }: { chainPicker?: ReactNode } = {}) {
  const { wallet, account } = useEvmWallet();

  // ---- Identity (step 1): the same fields, in the same order, as CreateDTR.
  const [profileImageDataUrl, setProfileImageDataUrl] = useState<string | null>(null);
  const [profileImageError, setProfileImageError] = useState<string | null>(null);
  const profileImageInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [category, setCategory] = useState<string>(DEFAULT_RESERVE_CATEGORY);
  const [description, setDescription] = useState("");
  const [youtubeChannel, setYoutubeChannel] = useState("");
  const [youtubeFeatured, setYoutubeFeatured] = useState("");
  const headerImageInputRef = useRef<HTMLInputElement | null>(null);
  const [headerImage, setHeaderImage] = useState<string | null>(null);
  const [headerImageError, setHeaderImageError] = useState<string | null>(null);

  // ---- Composition (step 2)
  const catalogue = useRobinhoodAssetCatalogue(true);
  const [assets, setAssets] = useState<BasketAsset[]>([]);
  const [assetSearch, setAssetSearch] = useState("");
  const [issuerFilter, setIssuerFilter] = useState<IssuerFilter>("all");

  // ---- Economics (step 3)
  const [initialSeedUsdg, setInitialSeedUsdg] = useState("");
  const [mintFeePct, setMintFeePct] = useState(0.5);
  const [tvlFeePct, setTvlFeePct] = useState(1);
  const [feeDestination, setFeeDestination] = useState("");
  const feeDestinationUserEditedRef = useRef(false);
  useEffect(() => {
    if (!feeDestinationUserEditedRef.current && !feeDestination && account) setFeeDestination(account);
  }, [account, feeDestination]);
  const [feeRecipients, setFeeRecipients] = useState<FeeRecipient[]>([]);
  const [newRecipientAddress, setNewRecipientAddress] = useState("");
  const [newRecipientPct, setNewRecipientPct] = useState("");
  const [feeRecipientAddError, setFeeRecipientAddError] = useState<string | null>(null);
  const [additionalManagers, setAdditionalManagers] = useState<string[]>([]);
  const [newManagerAddress, setNewManagerAddress] = useState("");
  const [managerAddError, setManagerAddError] = useState<string | null>(null);

  // The DAO's fee rule, read live from the registry (the chain's own numbers, not asserted).
  const [feeRule, setFeeRule] = useState<{ num: bigint; den: bigint; floor: bigint }>({ num: 1n, den: 2n, floor: 5n * 10n ** 15n });
  useEffect(() => {
    pc.readContract({ address: cfg.feeRegistry, abi: FEE_REGISTRY_ABI, functionName: "getFeeDetails", args: [zeroAddress] })
      .then(([, num, den, floor]) => setFeeRule({ num, den, floor }))
      .catch(() => {});
  }, []);

  // ---- Review (step 4)
  const [metadataUri, setMetadataUri] = useState<string | null>(null);
  const [metadataUriError, setMetadataUriError] = useState<string | null>(null);
  const [metadataUploading, setMetadataUploading] = useState(false);
  const [quotes, setQuotes] = useState<LegQuote[] | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [gasPriceWei, setGasPriceWei] = useState<bigint | null>(null);
  const [walletUsdg, setWalletUsdg] = useState<bigint | null>(null);
  const [walletEth, setWalletEth] = useState<bigint | null>(null);

  const [status, setStatus] = useState<Status>(null);
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);

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

  // ---- basket helpers (the Solana wizard's, verbatim in behaviour)
  const selectable: RobinhoodAsset[] = useMemo(() => {
    const fromCatalogue = catalogue.tokens.filter((t) => t.address.toLowerCase() !== USDG.toLowerCase());
    return [USDG_ASSET, ...fromCatalogue];
  }, [catalogue.tokens]);
  const atAssetLimit = assets.length >= RH_MAX_ASSETS_PER_RESERVE;
  const addAsset = (a: RobinhoodAsset) => {
    if (assets.length >= RH_MAX_ASSETS_PER_RESERVE) return;
    if (!assets.some((x) => x.address.toLowerCase() === a.address.toLowerCase())) setAssets([...assets, { ...a, weight: 0.1 }]);
  };
  const removeAsset = (address: string) => setAssets(assets.filter((a) => a.address.toLowerCase() !== address.toLowerCase()));
  const updateWeight = (address: string, w: number) => setAssets(assets.map((a) => (a.address.toLowerCase() === address.toLowerCase() ? { ...a, weight: Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0 } : a)));
  const applyWeights = (next: number[]) => setAssets((prev) => prev.map((a, i) => ({ ...a, weight: next[i] ?? a.weight })));
  const assignRestTo = (address: string) =>
    setAssets((prev) => {
      const i = prev.findIndex((a) => a.address.toLowerCase() === address.toLowerCase());
      const next = assignRemainder(prev.map((a) => a.weight), i);
      return prev.map((a, j) => ({ ...a, weight: next[j] ?? a.weight }));
    });
  const totalWeight = assets.reduce((s, a) => s + a.weight, 0);
  const unallocatedWeight = Math.max(0, 1 - totalWeight);
  const feeRecipientTotalPct = feeRecipients.reduce((s, r) => s + r.pct, 0);
  const priceOf = (address: Address): number | null => {
    if (address.toLowerCase() === USDG.toLowerCase()) return 1;
    return assets.find((a) => a.address.toLowerCase() === address.toLowerCase())?.priceUsd ?? catalogue.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())?.priceUsd ?? null;
  };
  const ethUsd = catalogue.tokens.find((t) => t.address.toLowerCase() === WETH.toLowerCase())?.priceUsd ?? null;

  const addFeeRecipient = () => {
    setFeeRecipientAddError(null);
    const address = newRecipientAddress.trim();
    const pct = parseFloat(newRecipientPct);
    if (!address) return setFeeRecipientAddError("Enter a wallet address first.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return setFeeRecipientAddError("That is not a valid 0x address.");
    if (!pct || pct <= 0) return setFeeRecipientAddError("Enter a percentage greater than 0.");
    if (feeRecipients.length + 1 >= 10) return setFeeRecipientAddError("Maximum of 10 recipients reached, including the Primary Fee Destination.");
    if (feeRecipients.some((r) => r.address.toLowerCase() === address.toLowerCase())) return setFeeRecipientAddError("That address is already an additional recipient.");
    if (address.toLowerCase() === (feeDestination || account || "").toLowerCase()) {
      return setFeeRecipientAddError("That's already the Primary Fee Destination above -- it doesn't need to be added again as an additional recipient.");
    }
    setFeeRecipients([...feeRecipients, { address, pct }]);
    setNewRecipientAddress("");
    setNewRecipientPct("");
  };
  const removeFeeRecipient = (address: string) => setFeeRecipients(feeRecipients.filter((r) => r.address !== address));
  const addManager = () => {
    setManagerAddError(null);
    const address = newManagerAddress.trim();
    if (!address) return setManagerAddError("Enter a wallet address first.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return setManagerAddError("That is not a valid 0x address.");
    if (address.toLowerCase() === (account ?? "").toLowerCase()) return setManagerAddError("That's your own wallet -- it is the root Manager already.");
    if (additionalManagers.some((m) => m.toLowerCase() === address.toLowerCase())) return setManagerAddError("That address is already a co-manager.");
    setAdditionalManagers([...additionalManagers, address]);
    setNewManagerAddress("");
  };
  const removeManager = (address: string) => setAdditionalManagers(additionalManagers.filter((a) => a !== address));

  // ---- the plan (pure) -- recomputed from the form on every render
  const planned: { plan: LaunchPlan | null; error: string | null } = useMemo(() => {
    try {
      if (assets.length === 0) return { plan: null, error: null };
      const seed = parseUsdgAmount(initialSeedUsdg || "0");
      const planAssets: PlannedAsset[] = assets.map((a) => ({ address: a.address, symbol: a.symbol, decimals: a.decimals, weight: a.weight, pool: a.pool }));
      return { plan: planLaunch(planAssets, seed, USDG), error: null };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [assets, initialSeedUsdg]);
  const plan = planned.plan;
  const planKey = plan ? plan.legs.map((l) => `${l.asset.address}:${l.usdgRaw}`).join("|") : "";

  /** Blocks Next until the current step is actually answerable. */
  function stepError(atStep: number): string | null {
    if (atStep === 1) {
      if (!name.trim()) return "Give the reserve a name.";
      if (!symbol.trim()) return "Give the reserve a ticker.";
    }
    if (atStep === 2) {
      if (assets.length === 0) return "Add at least one asset.";
      if (totalWeight > 1.0001) return "Total weight exceeds 100%. Please adjust allocations.";
    }
    if (atStep === 3) {
      if (!initialSeedUsdg || parseFloat(initialSeedUsdg) <= 0) return "Enter the initial amount in USDG.";
      if (feeRecipientTotalPct > 100) return "Recipient percentages exceed 100% of the Manager's fee share.";
      try {
        const mintFee = percentToD18(mintFeePct);
        if (mintFee > LIMITS.MAX_MINT_FEE) return `Mint fee cannot exceed ${d18ToPercent(LIMITS.MAX_MINT_FEE)}%.`;
        if (mintFee !== 0n && mintFee < LIMITS.MIN_MINT_FEE) return `A non-zero mint fee must be at least ${d18ToPercent(LIMITS.MIN_MINT_FEE)}%.`;
        if (percentToD18(tvlFeePct) > LIMITS.MAX_TVL_FEE) return `TVL fee cannot exceed ${d18ToPercent(LIMITS.MAX_TVL_FEE)}% a year.`;
        // The primary destination defaults to the wallet, which may not be
        // connected yet (the form can be filled first); validate what is set.
        if (feeDestination || account) feeRecipientsForChain(feeDestination || account || "", feeRecipients);
        coManagersForChain(account ?? "", additionalManagers);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      if (planned.error) return planned.error;
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

  async function connect() {
    try {
      await connectEvmWallet();
    } catch (e) {
      setStatus({ text: describeEvmError(e), kind: "err" });
    }
  }

  // Wallet balances for the cost summary.
  useEffect(() => {
    if (!account) {
      setWalletUsdg(null);
      setWalletEth(null);
      return;
    }
    let cancelled = false;
    Promise.all([pc.readContract({ address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }), pc.getBalance({ address: account })])
      .then(([u, e]) => {
        if (!cancelled) {
          setWalletUsdg(u);
          setWalletEth(e);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account, step]);

  /**
   * Stores the reserve's profile and returns the permanent metadata URL that
   * goes on-chain as the mandate. Every upload is content-addressed and
   * idempotent, so a retry after a wallet rejection re-uses the same rows.
   */
  async function uploadProfile(): Promise<string> {
    const origin = window.location.origin;
    let imageUrl: string | undefined;
    if (profileImageDataUrl) {
      imageUrl = await uploadReserveImage(origin, profileImageDataUrl, "robinhood");
    }
    let headerImageUrl: string | undefined;
    if (headerImage) {
      headerImageUrl = await uploadReserveImage(origin, await fitHeaderImageDataUrl(headerImage), "robinhood");
    }
    const channelUrl = youtubeChannel.trim() ? normalizeYouTubeChannelUrl(youtubeChannel) : "";
    const featuredUrl = channelUrl ? normalizeFeaturedVideoUrl(youtubeFeatured) : "";
    const input: ReserveMetadataInput = {
      name: name.trim(),
      ticker: symbol.trim(),
      description,
      category,
      // Manager buy/sell taxes are a Solana-side rule the EVM contracts do
      // not implement; stored as 0 so the payload shape stays shared.
      buyTaxPct: 0,
      sellTaxPct: 0,
      ...(imageUrl ? { imageUrl } : {}),
      ...(headerImageUrl ? { headerImageUrl } : {}),
      ...(channelUrl ? { youtubeChannelUrl: channelUrl } : {}),
      ...(featuredUrl ? { youtubeFeaturedVideoUrl: featuredUrl } : {}),
    };
    return uploadReserveMetadata(origin, input, "robinhood");
  }

  // Entering Review: store the profile (so the metadata URL can be shown,
  // as on Solana), quote every swap leg live, and read the gas price.
  const identityKey = [name, symbol, category, description, youtubeChannel, youtubeFeatured, profileImageDataUrl ?? "", headerImage ?? ""].join("\u0001");
  useEffect(() => {
    if (step !== 4) return;
    let cancelled = false;
    setMetadataUploading(true);
    setMetadataUriError(null);
    uploadProfile()
      .then((uri) => {
        if (!cancelled) setMetadataUri(uri);
      })
      .catch((e) => {
        if (!cancelled) {
          setMetadataUri(null);
          setMetadataUriError(e instanceof Error ? e.message : "The reserve profile could not be stored.");
        }
      })
      .finally(() => {
        if (!cancelled) setMetadataUploading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, identityKey]);

  useEffect(() => {
    if (step !== 4 || !plan) return;
    let cancelled = false;
    setQuotes(null);
    setQuoteError(null);
    const handle = setTimeout(() => {
      Promise.all([quoteLaunch(pc, plan, priceOf), pc.getGasPrice().catch(() => null)])
        .then(([q, gp]) => {
          if (cancelled) return;
          setQuotes(q);
          setGasPriceWei(gp);
        })
        .catch((e) => {
          if (!cancelled) setQuoteError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, planKey]);

  async function submit() {
    if (!wallet || !account) return setStatus({ text: "Connect an EVM wallet first.", kind: "err" });
    for (const s of [1, 2, 3]) {
      const e = stepError(s);
      if (e) return setStatus({ text: e, kind: "err" });
    }
    if (!plan) return setStatus({ text: planned.error ?? "The basket could not be planned.", kind: "err" });
    setSubmitting(true);
    try {
      const mintFee = percentToD18(mintFeePct);
      const tvlFee = percentToD18(tvlFeePct);
      const chainRecipients = feeRecipientsForChain(feeDestination || account, feeRecipients);
      const coManagers = coManagersForChain(account, additionalManagers);

      // Fresh quotes at the moment of launch, never the ones shown a minute ago.
      setStatus({ text: "Quoting the basket on Uniswap...", kind: "busy" });
      const freshQuotes = await quoteLaunch(pc, plan, priceOf);

      // The profile is stored BEFORE the wallet opens, so a store problem is
      // reported here rather than after assets have moved.
      let mandate = metadataUri;
      if (!mandate) {
        setStatus({ text: "Storing the reserve profile...", kind: "busy" });
        mandate = await uploadProfile();
        setMetadataUri(mandate);
      }

      const { reserve } = await executeLaunch(
        pc,
        wallet,
        cfg,
        account,
        { plan, quotes: freshQuotes, name: name.trim(), symbol: symbol.trim(), mintFee, tvlFee, owner: account, feeRecipients: chainRecipients, coManagers, mandate },
        (m) => setStatus({ text: m, kind: "busy" }),
      );
      invalidateRobinhoodReserves();
      window.location.hash = `#/dtr/${rhReserveId(reserve)}`;
    } catch (e) {
      setStatus({ text: describeEvmError(e), kind: "err" });
    } finally {
      setSubmitting(false);
    }
  }

  const mintSplit = effectiveFeeSplit(percentToD18(mintFeePct), feeRule.num, feeRule.den, feeRule.floor);
  const tvlSplit = effectiveFeeSplit(percentToD18(tvlFeePct), feeRule.num, feeRule.den, feeRule.floor);
  const seedUsd = parseFloat(initialSeedUsdg) || 0;

  return (
    <LaunchShell subtitle="Launch a new Reserve on SSR.FUN, live on Robinhood Chain." step={step}>
      <Card className="border-border/60 shadow-lg">
        {step === 1 && (
          <>
            <CardHeader>
              <CardTitle className="text-2xl font-merge-display">Reserve Identity</CardTitle>
              <CardDescription>Define the basic information for your new reserve.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* The chain is the first thing a creator decides, so it is the
                  first field of Identity -- not chrome standing above every step. */}
              {chainPicker && <div className="pb-6 border-b border-border/40">{chainPicker}</div>}

              <div className="flex items-center gap-3 flex-wrap">
                <Button variant={account ? "outline" : "default"} onClick={connect}>
                  {account ? short(account) : "Connect EVM wallet"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {account ? "Connected to Robinhood Chain" : "You can fill this in first and connect before launching."}
                </span>
              </div>

              <div className="space-y-2">
                <Label>Profile Picture (optional)</Label>
                <div className="flex items-start gap-4">
                  <Avatar className="h-16 w-16 border-2 border-border shadow-md">
                    {profileImageDataUrl && <AvatarImage src={profileImageDataUrl} alt={symbol || "Reserve"} />}
                    <AvatarFallback className="bg-primary/10 text-primary text-xl font-merge-display font-bold">
                      {symbol.slice(0, 2) || "?"}
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
                      Shown next to this Reserve everywhere in the app. PNG, JPEG, WebP, or GIF -- large images are resized automatically.
                    </p>
                  </div>
                </div>
                {profileImageError && <p className="text-sm text-destructive">{profileImageError}</p>}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="rhc-name">Reserve Name</Label>
                  <Input id="rhc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Strategic Tech Reserve" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rhc-symbol">Ticker</Label>
                  <Input
                    id="rhc-symbol"
                    value={symbol}
                    className="uppercase"
                    maxLength={TICKER_MAX_LENGTH}
                    placeholder="e.g. TECH"
                    onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, TICKER_MAX_LENGTH))}
                  />
                  <p className="text-xs text-muted-foreground">Up to {TICKER_MAX_LENGTH} letters, no numbers.</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rhc-category">Category</Label>
                <select
                  id="rhc-category"
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
                <Label htmlFor="rhc-description">Description</Label>
                <Textarea
                  id="rhc-description"
                  placeholder="Describe the strategy and focus of this reserve..."
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rhc-youtube-channel">YouTube channel <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="rhc-youtube-channel"
                    placeholder="e.g. youtube.com/@yourchannel"
                    value={youtubeChannel}
                    onChange={(e) => setYoutubeChannel(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Shown on your Reserve's page so holders can find your videos.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rhc-youtube-featured">Featured video link <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="rhc-youtube-featured"
                    placeholder="e.g. youtube.com/watch?v=..."
                    value={youtubeFeatured}
                    onChange={(e) => setYoutubeFeatured(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Plays at the top of the video panel on your Reserve's page.</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Header image <span className="text-muted-foreground font-normal">(optional)</span></Label>
                {headerImage && (
                  <div className="relative h-24 sm:h-32 rounded-xl overflow-hidden border border-border">
                    <img src={headerImage} alt="Header preview" className="w-full h-full object-cover" style={{ objectPosition: "center 30%" }} />
                    <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 55%, hsl(var(--background) / 0.9) 100%)" }} />
                  </div>
                )}
                <input
                  ref={headerImageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setHeaderImageError(null);
                    void fileToHeaderImageDataUrl(file).then(setHeaderImage).catch((err) => {
                      setHeaderImage(null);
                      setHeaderImageError(err instanceof Error ? err.message : "This file could not be read as an image -- try a different one.");
                    });
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => headerImageInputRef.current?.click()}>
                    {headerImage ? "Replace Image" : "Choose Image"}
                  </Button>
                  {headerImage && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setHeaderImage(null)}>Remove</Button>
                  )}
                </div>
                {headerImageError && <p className="text-xs text-destructive">{headerImageError}</p>}
                <p className="text-xs text-muted-foreground">
                  Shown full-width across the top of your Reserve's page, softly faded at the bottom. JPG or PNG (WebP and GIF work too). Ideal size: a wide landscape image, 1800 x 600 pixels or larger -- about a 3:1 crop. Keep the subject near the center; the bottom third fades into the page, and phones show a tighter middle slice. Large files are resized automatically.
                </p>
              </div>
            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <span />
              <Button onClick={next} disabled={!name.trim() || !symbol.trim()} className="font-bold gap-2">
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
                  {catalogue.status === "loading" && <p className="text-xs text-muted-foreground">Loading the Robinhood Chain asset list...</p>}
                  {catalogue.status === "unavailable" && (
                    <p className="text-xs text-muted-foreground">Showing USDG only -- the Robinhood Chain asset list is temporarily unavailable.</p>
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
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-2">
                      <label htmlFor="rh-issuer-filter" className="text-xs text-muted-foreground">Asset type</label>
                      <select
                        id="rh-issuer-filter"
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                        value={issuerFilter}
                        onChange={(e) => setIssuerFilter(e.target.value as IssuerFilter)}
                      >
                        {ISSUER_FILTER_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    {catalogue.status === "ready" && (
                      <span className="text-xs text-muted-foreground">{selectable.length.toLocaleString()} assets, found on Uniswap and refreshed daily</span>
                    )}
                  </div>
                  <div className="border border-border rounded-lg max-h-[300px] overflow-y-auto p-2 bg-muted/20 space-y-1">
                    {(() => {
                      const remaining = selectable.filter((a) => !assets.some((s) => s.address.toLowerCase() === a.address.toLowerCase()));
                      const shown = remaining
                        .filter((a) => matchesSearch(a, assetSearch))
                        .filter((a) => issuerFilter === "all" || (issuerFilter === "robinhood" ? a.issuer === "robinhood" : a.issuer !== "robinhood"))
                        .slice(0, 300);
                      if (remaining.length === 0) return <div className="p-4 text-center text-sm text-muted-foreground">All available assets added.</div>;
                      if (shown.length === 0) {
                        return (
                          <div className="p-4 text-center text-sm text-muted-foreground">
                            {assetSearch.trim() ? `No assets match "${assetSearch.trim()}".` : "No eligible assets of that type."}
                          </div>
                        );
                      }
                      return shown.map((asset) => (
                        <div key={asset.address} className="flex items-center justify-between p-2 hover:bg-muted rounded-md transition-colors">
                          <div className="min-w-0">
                            <span className="font-semibold">{asset.name}</span>
                            <span className="text-xs text-muted-foreground ml-2 font-merge-mono">{asset.symbol}</span>
                            {asset.issuer === "robinhood" && (
                              <span
                                className="text-[10px] uppercase tracking-wide ml-2 px-1.5 py-0.5 rounded border border-primary/40 text-primary"
                                title="An official Robinhood stock token, proven by its contract code -- not by its name."
                              >
                                Stock token
                              </span>
                            )}
                            <div className="text-xs text-muted-foreground font-merge-mono">
                              {asset.address.slice(0, 6)}...{asset.address.slice(-4)}
                              {asset.priceUsd !== null && asset.symbol !== "USDG" && <span className="ml-2">{usd(asset.priceUsd, asset.priceUsd < 1 ? 6 : 2)}</span>}
                              {asset.depthUsd !== null && <span className="ml-2">· pool {usd(asset.depthUsd, 0)}</span>}
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" disabled={atAssetLimit} onClick={() => addAsset(asset)}>
                            <Plus className="w-4 h-4 text-primary" />
                          </Button>
                        </div>
                      ));
                    })()}
                    {atAssetLimit && (
                      <div className="p-3 text-center text-sm text-muted-foreground">
                        This Reserve holds the maximum of {RH_MAX_ASSETS_PER_RESERVE} assets. Remove one to add a different asset.
                      </div>
                    )}
                  </div>
                </div>

                {/* Selected Basket */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center bg-muted/50 p-3 rounded-lg border border-border">
                    <span className="font-semibold text-sm">Total Allocated</span>
                    <div className="flex items-center gap-3">
                      {assets.length > 0 && (
                        <div className="flex items-center gap-1">
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" title="Give every selected asset an equal share of 100%" onClick={() => applyWeights(splitEvenly(assets.length))}>
                            Split evenly
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" title="Set every asset to 0% and leave the basket in USDG" onClick={() => applyWeights(clearAll(assets.length))}>
                            Clear
                          </Button>
                        </div>
                      )}
                      <span className={`font-merge-mono font-bold ${totalWeight > 1.0001 ? "text-destructive" : "text-primary"}`}>{(totalWeight * 100).toFixed(1)}%</span>
                    </div>
                  </div>

                  {unallocatedWeight > 0 && totalWeight <= 1.0001 && (
                    <div className="flex justify-between items-center p-3 rounded-lg border border-dashed border-border/80 text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-muted-foreground/30"></div>
                        <span className="text-muted-foreground italic">Unallocated USDG Reserve</span>
                      </div>
                      <span className="font-merge-mono text-muted-foreground">{(unallocatedWeight * 100).toFixed(1)}%</span>
                    </div>
                  )}

                  <div className="space-y-3">
                    {assets.map((asset) => (
                      <div key={asset.address} className="p-3 border border-border rounded-lg bg-card space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-semibold">{asset.symbol}</span>
                            <span className="text-xs text-muted-foreground truncate max-w-[100px]">{asset.name}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center">
                              <Input
                                type="number"
                                className="w-20 h-8 text-right font-merge-mono"
                                value={+(asset.weight * 100).toFixed(1)}
                                onChange={(e) => updateWeight(asset.address, parseFloat(e.target.value) / 100)}
                                step="0.1"
                                min="0"
                                max="100"
                              />
                              <span className="text-muted-foreground ml-1 text-sm">%</span>
                            </div>
                            {unallocatedBps(assets.map((a) => a.weight)) > 0 && (
                              <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs font-merge-mono" title={`Add the remaining ${(unallocatedWeight * 100).toFixed(1)}% to ${asset.symbol}`} onClick={() => assignRestTo(asset.address)}>
                                +{(unallocatedWeight * 100).toFixed(1)}%
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeAsset(asset.address)}>
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                        <Slider value={[asset.weight * 100]} max={100} step={1} onValueChange={(v) => updateWeight(asset.address, v[0] / 100)} />
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
              <Button variant="ghost" onClick={back} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button onClick={next} disabled={assets.length === 0 || totalWeight > 1.0001} className="font-bold gap-2">
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
                  <Label htmlFor="rh-seed" className="flex items-center gap-2">
                    Initial Reserve Value (USDG)
                    <InfoTip label="More information about the initial Reserve value">
                      The USDG to seed the reserve with, from this wallet. Each non-cash asset is bought with it on Uniswap at launch; the unallocated rest stays in the reserve as USDG. You receive one Reserve Token per USDG put in -- after that, tokens are minted and redeemed against the reserve&rsquo;s NAV.
                    </InfoTip>
                  </Label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-3 flex items-center text-muted-foreground text-sm">$</span>
                    <Input id="rh-seed" type="number" placeholder="e.g. 10.00" className="font-merge-mono pl-6" value={initialSeedUsdg} onChange={(e) => setInitialSeedUsdg(e.target.value)} />
                  </div>
                  <p className="text-xs text-muted-foreground flex justify-between">
                    <span>Funded directly in USDG from this wallet.</span>
                    {walletUsdg !== null && (
                      <span>
                        Wallet Balance: <span className="font-merge-mono">{fmtUsdg(walletUsdg)} USDG</span>
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                <h3 className="font-semibold text-lg pb-2">Fee Configuration</h3>
                <p className="text-xs text-muted-foreground -mt-4">
                  The protocol keeps {d18ToPercent((feeRule.num * 10n ** 18n) / (feeRule.den || 1n)).toFixed(0)}% of every fee, never less than a {d18ToPercent(feeRule.floor).toFixed(2)}% floor; the Manager receives the rest.
                  The split below is read live from the chain&rsquo;s fee registry, and the Review step shows exactly what will be submitted.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Mint Fee</span>
                      <span className="font-merge-mono text-primary">{mintFeePct.toFixed(2)}%</span>
                    </Label>
                    <Slider value={[mintFeePct]} max={5} step={0.05} onValueChange={(v) => setMintFeePct(v[0])} />
                    <p className="text-xs text-muted-foreground">Charged on new issuance. Protocol default is 0.50%.</p>
                    <p className="text-xs font-merge-mono text-muted-foreground">
                      Effective: {d18ToPercent(mintSplit.protocolD18).toFixed(2)}% Protocol + {d18ToPercent(mintSplit.managerD18).toFixed(2)}% Manager = {d18ToPercent(mintSplit.totalD18).toFixed(2)}% total
                    </p>
                  </div>
                  <div className="space-y-3">
                    <Label className="flex justify-between">
                      <span>Annualized TVL Fee</span>
                      <span className="font-merge-mono text-primary">{tvlFeePct.toFixed(2)}%</span>
                    </Label>
                    <Slider value={[tvlFeePct]} max={5} step={0.05} onValueChange={(v) => setTvlFeePct(v[0])} />
                    <p className="text-xs text-muted-foreground">Accrues to Manager. Protocol default is 1.00%.</p>
                    <p className="text-xs font-merge-mono text-muted-foreground">
                      Effective: {d18ToPercent(tvlSplit.protocolD18).toFixed(2)}% Protocol + {d18ToPercent(tvlSplit.managerD18).toFixed(2)}% Manager = {d18ToPercent(tvlSplit.totalD18).toFixed(2)}% total
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground italic">
                  Buy Tax and Sell Tax are a Solana-only rule: on Robinhood Chain every buy and sell is an in-kind mint or redeem against the contract, so there is nothing for a tax to attach to.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="font-semibold text-lg pb-2">Fee Routing</h3>
                <div className="space-y-2">
                  <Label htmlFor="rh-dest">Primary Fee Destination Wallet</Label>
                  <Input
                    id="rh-dest"
                    value={feeDestination}
                    onChange={(e) => {
                      feeDestinationUserEditedRef.current = true;
                      setFeeDestination(e.target.value);
                    }}
                    className="font-merge-mono text-sm"
                    placeholder={account ?? "0x..."}
                  />
                  <p className="text-xs text-muted-foreground">
                    Address that receives the Manager&rsquo;s fee share on-chain (100%, unless you add more recipients below). Defaults to your connected wallet ({account ? short(account) : "—"})
                    until you change it -- this is the exact wallet the Review step below will show as Primary.
                  </p>
                </div>

                <div className="space-y-3 pt-2">
                  <Label className="flex justify-between items-center">
                    <span>Additional Fee Recipients ({feeRecipients.length + 1}/10)</span>
                    <span className={`font-merge-mono text-xs ${feeRecipientTotalPct > 100 ? "text-destructive" : "text-muted-foreground"}`}>{feeRecipientTotalPct.toFixed(1)}% of the Manager&rsquo;s share</span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    These percentages divide the <strong>Manager&rsquo;s fee share</strong> -- not the total fee charged to depositors. Whatever&rsquo;s left after the recipients below goes to the Primary Fee Destination above. Up to 10 recipients total, including the Primary.
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
                      <Input placeholder="Recipient wallet address" className="font-merge-mono text-sm" value={newRecipientAddress} onChange={(e) => { setNewRecipientAddress(e.target.value); setFeeRecipientAddError(null); }} />
                      <Input type="number" placeholder="%" className="w-24 font-merge-mono" min="0" max="100" value={newRecipientPct} onChange={(e) => { setNewRecipientPct(e.target.value); setFeeRecipientAddError(null); }} />
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
                      <p>Recipient percentages exceed 100% of the Manager&rsquo;s fee share. Please adjust.</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-semibold text-lg pb-2">Co-Managers</h3>
                <p className="text-xs text-muted-foreground">
                  Add other wallets as Reserve Managers. They&rsquo;ll be able to rebalance, run auctions and edit the profile, but won&rsquo;t be able to change fees or manage other co-managers -- only the root Manager (you) can do that.
                </p>
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
                  <Input placeholder="Manager wallet address" className="font-merge-mono text-sm" value={newManagerAddress} onChange={(e) => { setNewManagerAddress(e.target.value); setManagerAddError(null); }} />
                  <Button variant="outline" onClick={addManager} className="shrink-0 gap-1.5">
                    <Plus className="w-4 h-4" /> Add
                  </Button>
                </div>
                {managerAddError && (
                  <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <p>{managerAddError}</p>
                  </div>
                )}
              </div>
            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <Button variant="ghost" onClick={back} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button onClick={next} disabled={!initialSeedUsdg || parseFloat(initialSeedUsdg) <= 0 || feeRecipientTotalPct > 100} className="font-bold gap-2">
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
                <Badge className="font-merge-mono">Robinhood Chain</Badge>
              </CardTitle>
              <CardDescription>This will submit real transactions to the SSR factory on Robinhood Chain: your USDG buys the basket on Uniswap, then the reserve is deployed holding it.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                {headerImage && (
                  <div className="relative h-24 sm:h-32 overflow-hidden border-b border-border">
                    <img src={headerImage} alt="Header preview" className="w-full h-full object-cover" style={{ objectPosition: "center 30%" }} />
                    <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 55%, hsl(var(--background) / 0.9) 100%)" }} />
                  </div>
                )}
                <div className="bg-muted/50 p-4 border-b border-border flex justify-between items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar className="h-12 w-12 border-2 border-border shadow-md">
                      {profileImageDataUrl && <AvatarImage src={profileImageDataUrl} alt={symbol || "Reserve"} />}
                      <AvatarFallback className="bg-primary/10 text-primary font-merge-display font-bold">{symbol.slice(0, 2) || "?"}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <h3 className="text-xl font-merge-display font-bold truncate">{name}</h3>
                      <Badge variant="secondary" className="font-merge-mono mt-1">{symbol}</Badge>
                    </div>
                  </div>
                  <Badge variant="outline" className="bg-background shrink-0">{category}</Badge>
                </div>
                <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-2">Description</p>
                      <p className="text-sm whitespace-pre-line">{description || "No description provided."}</p>
                    </div>
                    {(youtubeChannel.trim() || youtubeFeatured.trim()) && (
                      <div className="text-xs space-y-1">
                        <div className="flex justify-between gap-6"><span className="text-muted-foreground shrink-0">YouTube channel</span><span className="font-medium text-right break-all">{youtubeChannel.trim() ? normalizeYouTubeChannelUrl(youtubeChannel) : "—"}</span></div>
                        <div className="flex justify-between gap-6"><span className="text-muted-foreground shrink-0">Featured video</span><span className="font-medium text-right break-all">{youtubeChannel.trim() && youtubeFeatured.trim() ? normalizeFeaturedVideoUrl(youtubeFeatured) : "—"}</span></div>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-2">Economics</p>
                    <div className="rounded-2xl border border-border/60 overflow-hidden">
                      {(() => {
                        const rows: Array<{ label: ReactNode; value: ReactNode; sub?: boolean }> = [
                          { label: "Initial Reserve Value", value: <span className="font-merge-mono font-medium">{formatUsdc(seedUsd)} <span className="text-muted-foreground font-sans">in USDG (see Wallet Cost Summary below)</span></span> },
                          { label: "Reserve Tokens minted to you", value: <span className="font-merge-mono font-medium">{seedUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })} {symbol || "Reserve"} <span className="text-muted-foreground font-sans">(1 per USDG; no fee at creation)</span></span> },
                          { label: "Mint Fee (configured)", value: <span className="font-merge-mono font-medium">{mintFeePct.toFixed(2)}%</span> },
                          { sub: true, label: "↳ Protocol / Manager (effective)", value: <span className="font-merge-mono text-muted-foreground">{d18ToPercent(mintSplit.protocolD18).toFixed(2)}% / {d18ToPercent(mintSplit.managerD18).toFixed(2)}%</span> },
                          { label: "TVL Fee (configured, annualized)", value: <span className="font-merge-mono font-medium">{tvlFeePct.toFixed(2)}%</span> },
                          { sub: true, label: "↳ Protocol / Manager (effective)", value: <span className="font-merge-mono text-muted-foreground">{d18ToPercent(tvlSplit.protocolD18).toFixed(2)}% / {d18ToPercent(tvlSplit.managerD18).toFixed(2)}%</span> },
                          { label: "Rebalance pricing", value: <span className="font-merge-mono font-medium">atomic swap, {String(SAFE_REBALANCE_DEFAULTS.maxAuctionLength)}s auction cap</span> },
                        ];
                        return rows.map((row, i) => (
                          <div key={i} className={`flex justify-between gap-6 px-4 py-2.5 ${row.sub ? "text-xs" : "text-sm"} ${i % 2 === 0 ? "bg-secondary/50" : "bg-card"} ${row.sub ? "pl-7" : ""}`}>
                            <span className="text-muted-foreground">{row.label}</span>
                            <span className="text-right">{row.value}</span>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              <div className={`bg-card border rounded-xl overflow-hidden ${metadataUriError ? "border-destructive/50" : "border-border"}`}>
                <div className="bg-muted/50 p-4 border-b border-border">
                  <h3 className="font-semibold flex items-center gap-2">
                    Reserve Metadata URL
                    <InfoTip label="More information about the Reserve metadata URL">
                      Your Reserve&rsquo;s name, ticker, description, category, pictures and links are stored at this permanent URL -- only this short link is written on-chain, as the reserve contract&rsquo;s mandate, exactly like a Solana Reserve&rsquo;s metadata URI.
                    </InfoTip>
                  </h3>
                </div>
                <div className="p-4">
                  {metadataUploading && (
                    <p className="text-sm text-muted-foreground flex items-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" /> Uploading metadata...
                    </p>
                  )}
                  {!metadataUploading && metadataUriError && <p className="text-sm text-destructive">{metadataUriError}</p>}
                  {!metadataUploading && !metadataUriError && metadataUri && <p className="text-sm font-merge-mono break-all">{metadataUri}</p>}
                </div>
              </div>

              <div className="bg-card border border-primary/30 rounded-xl overflow-hidden">
                <div className="bg-primary/5 p-4 border-b border-border">
                  <h3 className="font-semibold flex items-center gap-2">
                    Wallet Cost Summary
                    <InfoTip label="More information about the wallet cost summary">
                      Everything this wallet will be asked to spend, shown before your wallet does: each asset going into your Reserve is bought with your USDG on Uniswap (the USDG holding is deposited directly), and gas is paid in ETH. Totals are across every transaction below -- your wallet shows one prompt per transaction, so any single prompt will show less than the total.
                    </InfoTip>
                  </h3>
                </div>
                <div className="p-4 space-y-3">
                  {planned.error && <p className="text-sm text-destructive">{planned.error}</p>}
                  {quoteError && <p className="text-sm text-destructive">{quoteError}</p>}
                  {!planned.error && !quoteError && !quotes && <p className="text-sm text-muted-foreground">Quoting the basket on Uniswap...</p>}
                  {plan && quotes && (() => {
                    const swapCount = plan.legs.filter((l) => l.kind === "swap").length;
                    const gas = estimateLaunchGas(plan.legs.length, swapCount);
                    const gasWei = gasPriceWei === null ? null : gas * gasPriceWei;
                    const gasEth = gasWei === null ? null : Number(gasWei) / 1e18;
                    const gasUsd = gasEth === null || ethUsd === null ? null : gasEth * ethUsd;
                    const steps = launchSteps(plan);
                    return (
                      <>
                        <p className="text-xs font-semibold text-foreground">Goes into your Reserve (its actual holdings)</p>
                        {quotes.map((q) => (
                          <div key={q.leg.asset.address} className="flex justify-between text-sm gap-4">
                            <span className="text-muted-foreground">{q.leg.asset.symbol}</span>
                            <span className="font-merge-mono text-right">
                              {usd(Number(q.leg.usdgRaw) / 1e6)}
                              <span className="text-muted-foreground">
                                {q.leg.kind === "usdg"
                                  ? " (your USDG, deposited directly)"
                                  : ` (≈ ${fmtUnits(q.quotedOut, q.leg.asset.decimals, 6)} ${q.leg.asset.symbol}, bought with your USDG${q.impactBps > 0 ? `, ~${(q.impactBps / 100).toFixed(2)}% price impact` : ""})`}
                              </span>
                            </span>
                          </div>
                        ))}
                        <div className="flex justify-between text-sm font-semibold">
                          <span>Reserve assets subtotal</span>
                          <span className="font-merge-mono">{fmtUsdg(plan.seedUsdgRaw)} USDG</span>
                        </div>
                        {walletUsdg !== null && (
                          <p className={`text-xs ${walletUsdg < plan.seedUsdgRaw ? "text-destructive" : "text-muted-foreground"}`}>
                            This wallet holds {fmtUsdg(walletUsdg)} USDG{walletUsdg < plan.seedUsdgRaw ? ` -- it needs ${fmtUsdg(plan.seedUsdgRaw)} USDG. Add USDG or lower the initial amount.` : "."}
                          </p>
                        )}
                        <p className="pt-3 border-t border-border/50 text-xs font-semibold text-foreground">Fees &amp; overhead (paid in ETH)</p>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Estimated gas ({steps.length} transactions)</span>
                          <span className="font-merge-mono">
                            {gasEth === null ? "estimate unavailable" : `${gasEth.toFixed(6)} ETH`}
                            {gasUsd !== null && <span className="text-muted-foreground"> (≈ {usd(gasUsd)})</span>}
                          </span>
                        </div>
                        {walletEth !== null && gasWei !== null && walletEth < gasWei && (
                          <p className="text-xs text-destructive">This wallet holds {fmtUnits(walletEth, 18, 6)} ETH, under the estimated gas. Add ETH on Robinhood Chain first.</p>
                        )}
                        <div className="pt-3 border-t border-border/50 space-y-1.5">
                          <div className="flex justify-between text-sm font-semibold">
                            <span>Total (USD)</span>
                            <span className="font-merge-mono text-primary">{gasUsd === null ? `${usd(seedUsd)} + gas` : `≈ ${usd(seedUsd + gasUsd)}`}</span>
                          </div>
                        </div>
                        <div className="pt-3 border-t border-border/50 space-y-1.5 text-xs text-muted-foreground">
                          <p className="font-semibold text-foreground">This will request up to {steps.length} wallet approvals:</p>
                          {steps.map((s, i) => (
                            <p key={i}>{i + 1}. {s}</p>
                          ))}
                          <p className="pt-1">
                            Expected result: you&rsquo;ll spend the USDG and ETH above and receive{" "}
                            <span className="font-merge-mono text-foreground">{seedUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })} {symbol || "Reserve"}</span> tokens -- one per USDG, with no fee on the initial seed. Each swap accepts at most 1% less than quoted; a thin pool is refused before anything is sent.
                          </p>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-3">Target Composition</p>
                <div className="space-y-2">
                  {[...assets].sort((a, b) => b.weight - a.weight).map((asset) => (
                    <div key={asset.address} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{asset.symbol}</span>
                        <span className="text-muted-foreground text-xs">{asset.name}</span>
                      </div>
                      <span className="font-merge-mono font-bold">{(asset.weight * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  {unallocatedWeight > 0 && (
                    <div className="flex justify-between items-center p-2 rounded border border-dashed border-border/80 text-sm">
                      <span className="text-muted-foreground italic">Unallocated USDG Reserve</span>
                      <span className="font-merge-mono text-muted-foreground">{(unallocatedWeight * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1">Manager Fee Routing</p>
                <p className="text-xs text-muted-foreground mb-3">This is the exact on-chain configuration that will be submitted. Percentages divide the Manager&rsquo;s fee share, not the total fee.</p>
                <div className="space-y-2">
                  {(() => {
                    const additional = feeRecipients.reduce((s, r) => s + r.pct, 0);
                    const primaryPct = Math.max(0, 100 - additional);
                    return (
                      <>
                        {primaryPct > 0 && (
                          <div className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                            <span className="font-merge-mono text-xs truncate">{feeDestination || account || "connect a wallet"}</span>
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
                  <p className="text-sm font-semibold text-muted-foreground mb-3">Co-Managers</p>
                  <div className="space-y-2">
                    {additionalManagers.map((address) => (
                      <div key={address} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                        <span className="font-merge-mono text-xs truncate">{address}</span>
                        <Badge variant="secondary" className="shrink-0">Co-Manager</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!account && <p className="text-sm text-muted-foreground">Connect an EVM wallet to launch.</p>}
            </CardContent>
            <CardFooter className="justify-between border-t border-border/40 pt-6">
              <Button variant="ghost" onClick={back} disabled={submitting} className="gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button
                onClick={submit}
                disabled={!account || submitting || !plan || !quotes || metadataUploading || !metadataUri}
                title={!account ? "Connect an EVM wallet to launch." : !quotes ? "Quoting the basket..." : metadataUploading ? "Uploading Reserve metadata..." : !metadataUri ? metadataUriError ?? "Storing the reserve profile..." : undefined}
                className="font-bold gap-2 min-w-[150px]"
              >
                {submitting ? (
                  <><span className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Launching...</>
                ) : !quotes && !quoteError ? (
                  <><span className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" /> Quoting...</>
                ) : (
                  <><Rocket className="w-4 h-4" /> Launch Reserve</>
                )}
              </Button>
            </CardFooter>
          </>
        )}
      </Card>

      {status && (
        <p className={`text-sm mt-4 ${status.kind === "ok" ? "text-positive" : status.kind === "err" ? "text-destructive" : "text-muted-foreground"}`}>
          {status.text}
        </p>
      )}
    </LaunchShell>
  );
}
