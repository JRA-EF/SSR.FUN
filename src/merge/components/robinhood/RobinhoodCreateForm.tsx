// The Robinhood Chain branch of the Create page. Every reserve is its own
// contract deployed through the SSR factory; the creator supplies the starting
// basket from their own wallet.
//
// Step 1 (Identity) asks for exactly what the Solana wizard asks for --
// chain, profile picture, name, ticker, category, description, YouTube
// links, header image -- and the whole profile is stored the same way: the
// pictures go to the content-addressed image store, the text and links to the
// metadata store, and the payload's permanent URL is written on-chain (here as
// the Folio's `mandate`, the EVM counterpart of Solana's metadata_uri -- see
// lib/evmReserveMeta.ts). Only the composition and economics differ, because
// the chains genuinely do: a Robinhood reserve is seeded in kind.
import { useRef, useState } from "react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReactNode } from "react";
import { LaunchShell } from "@/components/LaunchHero";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ERC20_ABI, LIMITS, ROBINHOOD, SAFE_REBALANCE_DEFAULTS, type AssetRef } from "@/lib/evmChain";
import { createReserve, describeEvmError, fmtUnits, parseAmount, parsePercentToD18, pctFromD18, publicClientFor, rhReserveId } from "@/lib/evmReserve";
import { invalidateRobinhoodReserves } from "@/hooks/useRobinhoodReserves";
import { RESERVE_CATEGORIES, DEFAULT_RESERVE_CATEGORY } from "@/lib/types";
import { TICKER_MAX_LENGTH } from "@/lib/calculations";
import { fileToHeaderImageDataUrl, fileToProfileImageDataUrl, fitHeaderImageDataUrl, uploadReserveImage } from "@/lib/reserveImageClient";
import { uploadReserveMetadata, type ReserveMetadataInput } from "@/lib/createReserveClient";
import { normalizeYouTubeChannelUrl, parseYouTubeVideoId } from "@/lib/youtube";
import { connectEvmWallet, useEvmWallet } from "./useEvmWallet";

const cfg = ROBINHOOD;
const pc = publicClientFor(cfg);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
type Status = { text: string; kind: "ok" | "err" | "busy" } | null;

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

  // ---- Economics (step 3)
  const [initialShares, setInitialShares] = useState("10");
  const [mintFeePct, setMintFeePct] = useState("1");
  const [tvlFeePct, setTvlFeePct] = useState("1");
  const [owner, setOwner] = useState("");

  // ---- Composition (step 2). Rows hold the TYPED ticker, resolved against
  // the full asset list on submit -- 281 tokens is far too many for a
  // <select>, so this is a type-to-filter input backed by a datalist.
  const [rows, setRows] = useState<{ symbol: string; amount: string }[]>(() => [
    { symbol: "USDG", amount: "" },
    { symbol: "", amount: "" },
  ]);
  const findAsset = (symbol: string) => cfg.assets.find((a) => a.symbol.toLowerCase() === symbol.trim().toLowerCase());
  const [balances, setBalances] = useState<Record<string, string>>({});
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

  /**
   * Stores the reserve's profile and returns the permanent metadata URL that
   * goes on-chain as the mandate. Every upload is content-addressed and
   * idempotent, so a retry after a wallet rejection re-uses the same rows.
   */
  async function uploadProfile(): Promise<string> {
    const origin = window.location.origin;
    let imageUrl: string | undefined;
    if (profileImageDataUrl) {
      setStatus({ text: "Storing the profile picture...", kind: "busy" });
      imageUrl = await uploadReserveImage(origin, profileImageDataUrl, "robinhood");
    }
    let headerImageUrl: string | undefined;
    if (headerImage) {
      setStatus({ text: "Storing the header image...", kind: "busy" });
      headerImageUrl = await uploadReserveImage(origin, await fitHeaderImageDataUrl(headerImage), "robinhood");
    }
    setStatus({ text: "Storing the reserve profile...", kind: "busy" });
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

  async function submit() {
    if (!wallet || !account) return setStatus({ text: "Connect an EVM wallet first.", kind: "err" });
    setSubmitting(true);
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

      // The profile is stored BEFORE the wallet opens, so a store problem is
      // reported here rather than after assets have moved.
      const mandate = await uploadProfile();

      const { reserve } = await createReserve(
        pc,
        wallet,
        cfg,
        account,
        { name: name.trim(), symbol: symbol.trim(), legs, initialShares: parseAmount(initialShares, 18, "Initial shares"), mintFee, tvlFee, owner: ownerAddr, mandate },
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
                          ? `${asset.note ?? asset.symbol}${balances[asset.address] ? ` · you hold ${balances[asset.address]}` : ""}`
                          : unknown
                            ? "Not a token on Robinhood Chain"
                            : " "}
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
              {headerImage && (
                <div className="relative h-24 sm:h-32 rounded-xl overflow-hidden border border-border">
                  <img src={headerImage} alt="Header preview" className="w-full h-full object-cover" style={{ objectPosition: "center 30%" }} />
                  <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 55%, hsl(var(--background) / 0.9) 100%)" }} />
                </div>
              )}
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12 border-2 border-border shadow-md">
                  {profileImageDataUrl && <AvatarImage src={profileImageDataUrl} alt={symbol || "Reserve"} />}
                  <AvatarFallback className="bg-primary/10 text-primary font-merge-display font-bold">{symbol.slice(0, 2) || "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-merge-display font-bold text-lg truncate">{name}</p>
                  <p className="text-xs text-muted-foreground font-merge-mono">{symbol} &middot; {category}</p>
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-2">Identity</p>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span className="font-medium">{name}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Ticker</span><span className="font-medium font-merge-mono">{symbol}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Chain</span><span className="font-medium">Robinhood Chain</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Category</span><span className="font-medium">{category}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-muted-foreground shrink-0">Description</span><span className="font-medium text-right whitespace-pre-line break-words">{description.trim() || "—"}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-muted-foreground shrink-0">YouTube channel</span><span className="font-medium text-right break-all">{youtubeChannel.trim() ? normalizeYouTubeChannelUrl(youtubeChannel) : "—"}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-muted-foreground shrink-0">Featured video</span><span className="font-medium text-right break-all">{youtubeChannel.trim() && youtubeFeatured.trim() ? normalizeFeaturedVideoUrl(youtubeFeatured) : "—"}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Profile picture</span><span className="font-medium">{profileImageDataUrl ? "Chosen" : "—"}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Header image</span><span className="font-medium">{headerImage ? "Chosen" : "—"}</span></div>
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
              <p className="text-xs text-muted-foreground">
                Launching first stores the profile above (pictures, description, links) and writes its permanent link into the reserve contract, then asks your wallet to approve each asset and deploy.
              </p>
              {!account && <p className="text-sm text-muted-foreground">Connect an EVM wallet to launch.</p>}
            </CardContent>
          </>
        )}

        <CardFooter className="flex items-center justify-between gap-3 border-t border-border/60 pt-5">
          <Button variant="outline" onClick={back} disabled={step === 1 || submitting}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          {step < 4 ? (
            <Button onClick={next} disabled={step === 1 && (!name.trim() || !symbol.trim())}>
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={submit} disabled={!account || submitting}>{submitting ? "Launching..." : "Launch Reserve"}</Button>
          )}
        </CardFooter>
      </Card>

      {status && (
        <p className={`text-sm mt-4 ${status.kind === "ok" ? "text-positive" : status.kind === "err" ? "text-destructive" : "text-muted-foreground"}`}>
          {status.text}
        </p>
      )}
    </LaunchShell>
  );
}
