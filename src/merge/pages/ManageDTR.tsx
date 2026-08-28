import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useAppStore, isManagerOrDelegate, canManageDelegates, canRebalance } from "@/store/useAppStore";
import { resolveDtrPageState, parseOnChainReserveId, TEST_ASSET_PRICES_USD, onChainDelegateFromDiscovered, computeMarketCap, type AssetPriceInfo } from "@/lib/onChainReserve";
import { fetchAssetPricesUsd } from "@/lib/assetPricing";
import { buildDelegateCandidateWallets, rememberDelegateWallet, forgetDelegateWallet } from "@/lib/delegateDiscoveryCandidates";
import { explorerUrl, SSR_PROGRAM_ID, IS_MAINNET, MAINNET_USDC_MINT, MAINNET_TREASURY_VAULT } from "@/lib/solana-config";
import { createAndRegisterReserveAlt, fetchReserveAltAddress } from "@/lib/reserveAltClient";
import { transactionConfirmedToast } from "@/components/TransactionConfirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { formatPct, formatUsdc, formatUsdcOrUnavailable } from "@/lib/calculations";
import { type ManagerPermissions, emptyPermissions } from "@/lib/types";
import { ChevronLeft, Shield, Users, Sliders, Save, Plus, X, Trash2, Edit2, AlertCircle, Tag, PowerOff, XCircle, Coins, History, ExternalLink, Search } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Slider } from "@/components/ui/slider";
import { displayDelegateName, getDelegateLabel, setDelegateLabel, shortenAddress } from "@/lib/delegateLabels";
import { decodeOnChainPermissions, hasOnChainPermission, ON_CHAIN_PERMISSION_FLAGS, PERMISSION_FLAGS } from "@/lib/onChainPermissions";
import {
  fetchReserveOnChain,
  fetchManagerFeeRecipients,
  discoverDelegatesForReserve,
  DEVNET_FIXTURES,
  DEVUSDC,
  findReserve,
  validateFeeRecipientInputs,
  type ActivityLogEntry,
  type ManagerFeeRecipientsOnChain,
  type RecipientInput,
} from "@ssr/sdk";
import {
  executeAddDelegate,
  executeCloseReserve,
  executeCollectManagerFeeShare,
  executeInitializeManagerFeeRecipients,
  executeUpdateFeeRecipients,
  executeFundReserveAsset,
  executeInitiateWindDown,
  executeRemoveDelegate,
  executeRemoveReserveAsset,
  executeSubmitRebalance,
  executeUpdateDelegatePermissions,
  type RebalanceAssetPlan,
} from "@/lib/managementClient";
import { fileToProfileImageDataUrl, uploadReserveImage } from "@/lib/reserveImageClient";
import { applySliderWeightChange, type SliderAsset } from "@/lib/rebalanceSlider";

/**
 * Real DevNet SPL mints eligible to be added as a new Reserve Asset -- the
 * same set CreateDTR.tsx offers at creation time, minus wrapped SOL
 * (composition-management is meant for ordinary SPL test assets, not the
 * native-SOL zap leg). Empty on Mainnet: Mainnet Reserves are USDC-only for
 * this launch (see docs/project/DECISION_LOG.md's Mainnet-launch entries) --
 * DevNet's devUSDC/mock mints don't exist on Mainnet at all, so offering
 * them here would just be a confusing dead option, never a genuine one.
 */
const ADDABLE_ASSETS = IS_MAINNET
  ? []
  : [
      { symbol: DEVUSDC.symbol, mint: DEVUSDC.mint, decimals: DEVUSDC.decimals },
      ...Object.values(DEVNET_FIXTURES.mints).map((m) => ({ symbol: m.symbol.toUpperCase(), mint: m.address, decimals: m.decimals })),
    ];

// The rebalance slider model's permanent cash slot -- real USDC on Mainnet,
// devUSDC on DevNet (see the effect below that seeds proposedWeightsBps).
const CASH_SLOT_MINT = IS_MAINNET ? MAINNET_USDC_MINT : DEVUSDC.mint;
const CASH_SLOT_SYMBOL = IS_MAINNET ? "USDC" : DEVUSDC.symbol;
const CASH_SLOT_DECIMALS = IS_MAINNET ? 6 : DEVUSDC.decimals;
const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "DevNet";

/**
 * Verified-on-chain delegate row -- reused by both the Overview summary
 * (label-editing only) and the Delegates tab (full permission-editing and
 * removal for a real Reserve). Local labels are display-only and never
 * imply on-chain storage; see delegateLabels.ts. Real permission edits and
 * removal submit an actual signed update_delegate_permissions/remove_delegate
 * transaction -- see managementClient.ts.
 *
 * Whether THIS SPECIFIC delegate can be edited/removed by the current
 * signer depends on its own `restricted` flag (see
 * update_delegate_permissions.rs/remove_delegate.rs): a restricted
 * delegate's permissions/removal is gated by the signer's own
 * ADD_RESTRICTED_DELEGATE/REMOVE_RESTRICTED_DELEGATE permission; an
 * unrestricted delegate can only be edited/removed by the Root Manager,
 * regardless of any delegate permission -- so `canEditPermissions`/
 * `canRemove` must be computed per-row, not from a single page-level flag.
 */
function OnChainDelegateRow({
  reserveAddress,
  wallet,
  delegateAccount,
  permissions,
  restricted,
  canEditLabel,
  canEditPermissions,
  canRemove,
  busy,
  onSavePermissions,
  onRemove,
}: {
  reserveAddress: string;
  wallet: string;
  delegateAccount: string;
  permissions: number;
  restricted: boolean;
  canEditLabel: boolean;
  canEditPermissions?: boolean;
  canRemove?: boolean;
  busy?: boolean;
  onSavePermissions?: (newPermissions: number) => void;
  onRemove?: () => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(getDelegateLabel(reserveAddress, wallet) ?? "");
  const [editingPerms, setEditingPerms] = useState(false);
  const [permDraft, setPermDraft] = useState(permissions);
  const label = getDelegateLabel(reserveAddress, wallet);
  const caps = decodeOnChainPermissions(permissions);

  return (
    <div className="border border-border rounded-lg p-4 bg-card/50 space-y-2">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{label ?? shortenAddress(wallet)}</span>
            {label && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase">Local label</Badge>}
            <Badge variant={restricted ? "secondary" : "outline"} className="text-[9px] px-1 py-0 h-4 uppercase">
              {restricted ? "Restricted" : "Unrestricted"}
            </Badge>
            <Badge className="text-[9px] px-1 py-0 h-4 uppercase" style={{ background: "var(--verified, #2f9e6f)", color: "white" }}>
              Verified on-chain
            </Badge>
          </div>
          <p className="font-merge-mono text-xs text-muted-foreground break-all">{wallet}</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {caps.length > 0 ? (
              caps.map((c) => <Badge key={c} variant="secondary" className="text-[10px] py-0">{c}</Badge>)
            ) : (
              <span className="text-xs text-muted-foreground italic">No capabilities granted</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {canEditLabel && (
            <Button variant="outline" size="sm" onClick={() => { setLabelDraft(label ?? ""); setEditingLabel((v) => !v); }} className="gap-1.5">
              <Tag className="w-3.5 h-3.5" /> {label ? "Edit label" : "Set local label"}
            </Button>
          )}
          {onSavePermissions && (
            <Button
              variant="outline" size="sm"
              disabled={!canEditPermissions || busy}
              title={!canEditPermissions ? "You need the Root Manager or the matching restricted-delegate permission to edit this delegate." : undefined}
              onClick={() => { setPermDraft(permissions); setEditingPerms((v) => !v); }}
              className="gap-1.5"
            >
              <Edit2 className="w-3.5 h-3.5" /> Edit permissions
            </Button>
          )}
          {onRemove && (
            <Button
              variant="destructive" size="sm"
              disabled={!canRemove || busy}
              title={!canRemove ? "You need the Root Manager or the matching restricted-delegate permission to remove this delegate." : undefined}
              onClick={onRemove}
              className="gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" /> {busy ? "Confirming..." : "Remove"}
            </Button>
          )}
        </div>
      </div>
      {editingLabel && (
        <div className="flex gap-2 pt-2 border-t border-border/50">
          <Input
            placeholder="e.g. Ops wallet (local label only)"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            className="text-sm"
          />
          <Button size="sm" onClick={() => { setDelegateLabel(reserveAddress, wallet, labelDraft); setEditingLabel(false); }}>Save</Button>
        </div>
      )}
      {editingPerms && onSavePermissions && (
        <div className="pt-3 border-t border-border/50 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ON_CHAIN_PERMISSION_FLAGS.map((f) => (
              <div key={f.bit} className="flex items-center space-x-2">
                <Checkbox
                  id={`onchain-perm-${wallet}-${f.bit}`}
                  checked={(permDraft & f.bit) !== 0}
                  onCheckedChange={() => setPermDraft((prev) => (prev & f.bit) !== 0 ? prev & ~f.bit : prev | f.bit)}
                />
                <label htmlFor={`onchain-perm-${wallet}-${f.bit}`} className="text-sm font-medium leading-none">{f.label}</label>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditingPerms(false)}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={() => { onSavePermissions(permDraft); setEditingPerms(false); }}>
              {busy ? "Confirming..." : "Save Permissions"}
            </Button>
          </div>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/30">
        Delegate account: <span className="font-merge-mono break-all">{delegateAccount}</span>. Wallet address, capabilities, scope, and
        status above are read live from Solana {CLUSTER_LABEL}; the name is a local label stored only in this browser, never on-chain.
      </p>
    </div>
  );
}

export function ManageDTR() {
  const { dtrId } = useParams();
  const { wallet, dtrs, quarantinedReserves, chainDiscoveryStatus, addDelegate, updateDelegatePermissions, removeDelegate, rebalanceDTR, mergeOnChainReserve, setOnChainDelegates, setReserveProfileImage } = useAppStore();
  const pageState = resolveDtrPageState(dtrId, dtrs, quarantinedReserves, chainDiscoveryStatus);
  const dtr = pageState.kind === "found" ? pageState.dtr : undefined;
  const { toast } = useToast();
  const { connection } = useConnection();
  const walletCtx = useWallet();

  // One-approval trading (DEC-0161): whether this Reserve has its trading
  // address lookup table registered -- without one, a Buy/Sell that can't
  // fit Solana's transaction-size limit falls back to several separate
  // wallet approvals.
  const [tradingAlt, setTradingAlt] = useState<string | null | "loading">("loading");
  const [enablingAlt, setEnablingAlt] = useState(false);
  const reserveForAlt = dtr?.onChain?.reserve;
  useEffect(() => {
    if (!IS_MAINNET || !reserveForAlt) return;
    let cancelled = false;
    fetchReserveAltAddress(reserveForAlt)
      .then((alt) => {
        if (!cancelled) setTradingAlt(alt);
      })
      .catch(() => {
        if (!cancelled) setTradingAlt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reserveForAlt]);

  const enableOneApprovalTrading = async () => {
    if (!dtr?.onChain || !walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    setEnablingAlt(true);
    try {
      const alt = await createAndRegisterReserveAlt(connection, walletCtx, {
        ssrProgramId: SSR_PROGRAM_ID,
        reserve: new PublicKey(dtr.onChain.reserve),
        reserveTokenMint: new PublicKey(dtr.onChain.reserveTokenMint),
        mintAuthority: new PublicKey(dtr.onChain.mintAuthority),
        vaultAuthority: new PublicKey(dtr.onChain.vaultAuthority),
        protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
        assets: dtr.onChain.assets.map((a) => ({ mint: a.mint, reserveAsset: a.reserveAsset, vault: a.vault })),
      });
      setTradingAlt(alt);
      toast({ title: "One-approval trading enabled", description: "Buys and Sells of this Reserve can now complete in a single wallet approval for every trader." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not enable one-approval trading", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setEnablingAlt(false);
    }
  };

  // See DTRDetail.tsx's identical direct-check effect for the full
  // root-cause explanation -- covers the gap where discovery already
  // completed a pass ("ready") but this specific Reserve wasn't in it yet.
  const [directCheck, setDirectCheck] = useState<"idle" | "checking" | "confirmed-absent">("idle");
  useEffect(() => {
    if (pageState.kind !== "not-found") {
      if (directCheck !== "idle") setDirectCheck("idle");
      return;
    }
    const reserveId = parseOnChainReserveId(dtrId);
    if (reserveId === null) return;
    let cancelled = false;
    setDirectCheck("checking");
    const [reserveAddress] = findReserve(reserveId, SSR_PROGRAM_ID);
    fetchReserveOnChain(connection, SSR_PROGRAM_ID, reserveAddress, [])
      .then((onChain) => {
        if (cancelled) return;
        if (!onChain) setDirectCheck("confirmed-absent");
      })
      .catch(() => {
        // Inconclusive transport failure -- not confirmation of absence.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageState.kind, dtrId, connection]);

  const [activeTab, setActiveTab] = useState<"overview" | "delegates" | "rebalance" | "activity">("overview");

  // DL-01b fix: lazy-loaded only when the Activity tab is actually opened
  // (never an unconditional background poll). Reads from the Reserve
  // Activity Log's own Postgres index (api/devnet/reserve-activity.ts,
  // lib/reserve-activity/) instead of walking live RPC directly from the
  // browser -- a live-RPC hiccup during that endpoint's best-effort
  // background sync is reported via `activitySyncError` but never blocks
  // reading whatever is already indexed, and the index holds this
  // Reserve's COMPLETE history (resumable backfill), not just a recent
  // window.
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[] | null>(null);
  const [activityStatus, setActivityStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activitySyncError, setActivitySyncError] = useState<string | null>(null);
  const [activityBackfillComplete, setActivityBackfillComplete] = useState(true);
  useEffect(() => {
    if (activeTab !== "activity" || !dtr?.onChain || activityStatus !== "idle") return;
    let cancelled = false;
    setActivityStatus("loading");
    fetch(`/api/devnet/reserve-activity?reserve=${encodeURIComponent(dtr.onChain.reserve)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load the activity log.");
        return data as { entries: ActivityLogEntry[]; backfillComplete: boolean; syncError: string | null };
      })
      .then((data) => {
        if (cancelled) return;
        setActivityLog(data.entries);
        setActivitySyncError(data.syncError);
        setActivityBackfillComplete(data.backfillComplete);
        setActivityStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setActivityStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, dtr?.onChain?.reserve]);

  // Delegate State
  const [newDelegateAddress, setNewDelegateAddress] = useState("");
  const [newDelegatePerms, setNewDelegatePerms] = useState<ManagerPermissions>(emptyPermissions());

  // On-chain delegate management (real Reserves only) -- separate state from
  // the simulated-demo fields above, since granting an on-chain delegate
  // also needs a restricted/unrestricted choice (add_delegate.rs) that has
  // no equivalent in the local simulation.
  const [onChainNewDelegateWallet, setOnChainNewDelegateWallet] = useState("");
  const [onChainNewDelegatePermBits, setOnChainNewDelegatePermBits] = useState(0);
  const [onChainNewDelegateRestricted, setOnChainNewDelegateRestricted] = useState(true);
  const [editingDelegate, setEditingDelegate] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<ManagerPermissions>(emptyPermissions());

  // Rebalance State
  const [rebalanceEdits, setRebalanceEdits] = useState<Record<string, number>>({});
  const [adjustRemaining, setAdjustRemaining] = useState(true);
  // AR-01 fix: search box for the redesigned Rebalance tab's asset picker
  // (mirrors CreateDTR.tsx's Basket Composition step -- search+add on the
  // left, current holdings with before/after weight comparison on the
  // right), separate from Delegates tab's own search-less list.
  const [rebalanceAssetSearch, setRebalanceAssetSearch] = useState("");
  const [onChainTxPending, setOnChainTxPending] = useState<string | null>(null); // which action is in flight, for button disabling

  // Profile-picture editor (Overview tab's Reserve Identity card). The
  // picked file is normalized to a small data URL locally (see
  // reserveImageClient.ts) and held here for preview until saved.
  const [pendingProfileImage, setPendingProfileImage] = useState<string | null>(null);
  const [profileImageError, setProfileImageError] = useState<string | null>(null);
  // True while a picked picture is uploading/saving -- its own flag (not
  // onChainTxPending) because saving a picture no longer submits any
  // transaction at all.
  const [savingProfileImage, setSavingProfileImage] = useState(false);
  const profileImageInputRef = useRef<HTMLInputElement | null>(null);

  // DEC-0094: multi-recipient Manager fees. `feeRecipientsData` is refetched
  // independently of the main Reserve poll (it lives in a separate
  // ManagerFeeRecipients account) -- `initialized: false` with a single
  // synthesized entry means this Reserve hasn't opted into multi-recipient
  // routing yet, see fetchManagerFeeRecipients's doc comment.
  const [feeRecipientsData, setFeeRecipientsData] = useState<ManagerFeeRecipientsOnChain | null>(null);
  // CLAIMANT-ONLY UI (2026-08-14 pass, see docs/project/DECISION_LOG.md):
  // keyed by recipient wallet, independent of `onChainTxPending` -- clicking
  // one recipient's Collect button must never show another recipient's row
  // as "collecting" or disable it. Also records this session's own last
  // successful collection per wallet (signature + confirmed time) for
  // immediate feedback; the Activity Log tab is the durable, cross-session
  // source of truth for collection history.
  const [collectingRecipient, setCollectingRecipient] = useState<string | null>(null);
  const [lastRecipientCollection, setLastRecipientCollection] = useState<Record<string, { signature: string; ts: number }>>({});
  const [routingEditorOpen, setRoutingEditorOpen] = useState(false);
  const [routingRecipients, setRoutingRecipients] = useState<{ address: string; pct: number }[]>([]);
  const [newRoutingAddress, setNewRoutingAddress] = useState("");
  const [newRoutingPct, setNewRoutingPct] = useState("");

  async function refreshFeeRecipients() {
    if (!dtr?.onChain) return;
    try {
      const programId = new PublicKey(dtr.onChain.programId);
      const data = await fetchManagerFeeRecipients(
        connection,
        programId,
        new PublicKey(dtr.onChain.reserve),
        dtr.onChain.feeDestination ?? dtr.managerAddress,
        dtr.onChain.pendingManagerFeeShares ?? "0",
      );
      setFeeRecipientsData(data);
    } catch {
      // Transient RPC failure -- leave the last-known data in place rather
      // than flashing an empty state; the next poll will retry.
    }
  }

  useEffect(() => {
    void refreshFeeRecipients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dtr?.onChain?.reserve]);

  /**
   * CLAIMANT-ONLY collect for exactly ONE recipient row (2026-08-14 pass,
   * see docs/project/DECISION_LOG.md). Deliberately does NOT use the shared
   * `onChainTxPending`/`runOnChainAction` machinery every other action on
   * this page uses -- that flag is page-wide, and reusing it here would put
   * every OTHER recipient's Collect button into a disabled "in flight" state
   * the moment any one of them is clicked, which the product spec explicitly
   * forbids. `collectingRecipient` tracks only the one wallet actually being
   * collected. Refreshes via `refreshFeeRecipients` (this section's own
   * authoritative on-chain source), not the full-page `refreshRealReserveNow`
   * -- a Manager fee collection never changes anything else on the page.
   */
  async function collectRecipientFee(recipientWallet: string) {
    if (!dtr?.onChain || collectingRecipient) return;
    setCollectingRecipient(recipientWallet);
    try {
      const signature = await executeCollectManagerFeeShare(
        connection,
        walletCtx,
        dtr.onChain.reserve,
        dtr.onChain.reserveTokenMint,
        recipientWallet,
        feeRecipientsData!.initialized,
      );
      toast(transactionConfirmedToast(signature, "Fee collected"));
      setLastRecipientCollection((prev) => ({ ...prev, [recipientWallet]: { signature, ts: Math.floor(Date.now() / 1000) } }));
      await refreshFeeRecipients();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.error("Collect Manager Fee Share failed:", raw);
      toast({ variant: "destructive", title: "Collect failed", description: raw });
    } finally {
      setCollectingRecipient(null);
    }
  }

  function openRoutingEditor() {
    setRoutingRecipients(
      (feeRecipientsData?.recipients ?? []).map((r) => ({ address: r.wallet, pct: r.allocationBps / 100 })),
    );
    setRoutingEditorOpen(true);
  }

  function addRoutingRecipient() {
    const pct = parseFloat(newRoutingPct);
    if (!newRoutingAddress.trim() || !pct || pct <= 0) return;
    if (routingRecipients.length >= 10) return;
    if (routingRecipients.some((r) => r.address === newRoutingAddress.trim())) return;
    setRoutingRecipients([...routingRecipients, { address: newRoutingAddress.trim(), pct }]);
    setNewRoutingAddress("");
    setNewRoutingPct("");
  }

  function removeRoutingRecipient(address: string) {
    setRoutingRecipients(routingRecipients.filter((r) => r.address !== address));
  }

  const routingTotalPct = routingRecipients.reduce((sum, r) => sum + r.pct, 0);

  async function submitRoutingChange() {
    if (!dtr?.onChain) return;
    const recipients: RecipientInput[] = routingRecipients.map((r) => ({ wallet: r.address, allocationBps: Math.round(r.pct * 100) }));
    try {
      validateFeeRecipientInputs(recipients);
    } catch (e) {
      toast({ variant: "destructive", title: "Invalid routing", description: e instanceof Error ? e.message : String(e) });
      return;
    }
    setOnChainTxPending("Update Fee Routing");
    try {
      let signature: string;
      if (feeRecipientsData?.initialized) {
        const currentRecipients = feeRecipientsData.recipients.map((r) => ({ wallet: r.wallet, pendingFeeShares: r.pendingFeeShares }));
        signature = await executeUpdateFeeRecipients(connection, walletCtx, dtr.onChain.reserve, currentRecipients, recipients);
      } else {
        signature = await executeInitializeManagerFeeRecipients(connection, walletCtx, dtr.onChain.reserve, recipients);
      }
      toast(transactionConfirmedToast(signature, "Fee routing updated"));
      setRoutingEditorOpen(false);
      await refreshFeeRecipients();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.error("Update Fee Routing failed:", raw);
      toast({
        variant: "destructive",
        title: "Could not update fee routing",
        description: /PendingFeesBlockRoutingChange/.test(raw)
          ? "One or more current recipients still had an uncollected balance that couldn't be paid out automatically. Try again, or collect fees individually first."
          : raw,
      });
    } finally {
      setOnChainTxPending(null);
    }
  }

  // Composition management (Phase F) state -- on-chain Reserves only.
  const [fundAmounts, setFundAmounts] = useState<Record<string, string>>({});

  // DEC-0084: slider-based local-preview rebalance editor for the real
  // on-chain branch. `sessionAddedAssets` holds assets the user has added
  // to the proposed composition THIS SESSION but not yet submitted --
  // ordinary slider rows, removable pre-submit with zero transactions.
  // `proposedWeightsBps` is the live proposed composition in bps, seeded
  // (fill-gaps-only) from each on-chain asset's real weight. Neither state
  // is touched by adjusting a slider, adding, or removing an asset -- only
  // Submit Rebalance ever prompts the wallet.
  const [sessionAddedAssets, setSessionAddedAssets] = useState<{ mint: string; symbol: string; decimals: number }[]>([]);
  const [proposedWeightsBps, setProposedWeightsBps] = useState<Record<string, number>>({});

  // Seeds proposedWeightsBps from each on-chain asset's real weight
  // whenever a new mint appears (e.g. after Submit Rebalance's own
  // refresh) -- fills gaps only, never clobbers an in-progress edit. If the
  // Reserve's on-chain assets don't already sum to 10,000bps and the cash
  // slot isn't already registered, auto-seeds a cash-slot row (as a
  // session-added asset) holding the slack -- this model has no separate
  // "unallocated" concept, the cash slot absorbs it.
  useEffect(() => {
    if (!dtr?.onChain) return;
    const onChainAssets = dtr.onChain.assets;
    const existingTotal = onChainAssets.reduce((s, a) => s + a.weightBps, 0);
    const slack = Math.max(0, 10_000 - existingTotal);
    const hasOnChainCashSlot = onChainAssets.some((a) => a.mint === CASH_SLOT_MINT);
    // The cash slot (devUSDC on DevNet, real USDC on Mainnet) is this
    // model's permanent cash slot -- always present in the proposed
    // composition (even at 0%) so every edit has somewhere to move weight
    // to/from, and any currently-unallocated on-chain weight (slack) is
    // folded into its seed value rather than left floating outside the
    // model, which would otherwise make 100% unreachable by any slider edit.
    setProposedWeightsBps((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const a of onChainAssets) {
        if (!(a.mint in next)) {
          next[a.mint] = a.mint === CASH_SLOT_MINT ? a.weightBps + slack : a.weightBps;
          changed = true;
        }
      }
      if (!hasOnChainCashSlot && !(CASH_SLOT_MINT in next)) {
        next[CASH_SLOT_MINT] = slack;
        changed = true;
      }
      return changed ? next : prev;
    });
    if (!hasOnChainCashSlot) {
      setSessionAddedAssets((prev) => (prev.some((a) => a.mint === CASH_SLOT_MINT) ? prev : [...prev, { mint: CASH_SLOT_MINT, symbol: CASH_SLOT_SYMBOL, decimals: CASH_SLOT_DECIMALS }]));
    }
    // Drops a session-added asset once it's CONFIRMED to actually appear
    // on-chain (i.e., genuinely present in onChainAssets), never on the
    // mere assumption that a just-submitted transaction succeeded. Submit
    // Rebalance used to prune the just-registered mint from
    // sessionAddedAssets immediately on a successful signature -- but an
    // RPC read moments after "confirmed" can still lag behind (a real
    // Solana read-after-write consistency gap, especially through a
    // load-balanced/proxied endpoint), so the very next refresh could
    // still not show the new asset yet. Pruning early in that window made
    // it vanish from proposedAssetRows entirely (no longer an on-chain row,
    // no longer a session row either) -- its weight silently dropped out of
    // the 100% total, producing a false "must total exactly 100%" error
    // right after a real, successful approval. proposedAssetRows already
    // excludes a session-added asset once it's genuinely on-chain (see its
    // own filter below), so pruning here -- driven by the same confirmed
    // onChainAssets this effect already reacts to -- can never race ahead
    // of the truth the way the optimistic prune could.
    const onChainMints = new Set(onChainAssets.map((a) => a.mint));
    setSessionAddedAssets((prev) => {
      const pruned = prev.filter((a) => !onChainMints.has(a.mint));
      return pruned.length === prev.length ? prev : pruned;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dtr?.onChain?.assets.map((a) => `${a.mint}:${a.weightBps}`).join(",")]);

  /** Re-fetches this Reserve's on-chain state immediately after a confirmed composition/wind-down/rebalance tx, rather than waiting for RealReserveSync's next poll. `extraCandidateMints` covers a mint just registered this call (e.g. via add_reserve_asset_active) that wouldn't otherwise be in the known asset list yet. */
  async function refreshRealReserveNow(extraCandidateMints: string[] = []) {
    if (!dtr?.onChain) return;
    try {
      const programId = new PublicKey(dtr.onChain.programId);
      const reserveAddress = new PublicKey(dtr.onChain.reserve);
      const knownMints = new Set(dtr.onChain.assets.map((a) => a.mint));
      const mints = [...dtr.onChain.assets.map((a) => new PublicKey(a.mint)), ...extraCandidateMints.filter((m) => !knownMints.has(m)).map((m) => new PublicKey(m))];
      const onChain = await fetchReserveOnChain(connection, programId, reserveAddress, mints);
      if (onChain) {
        // Best-effort, same reasoning as RealReserveSync.tsx's own pricing
        // fetch -- never blocks this refresh; falls back to an empty price
        // map, and mergeOnChainIntoDTR/computeAumFromPrices report the
        // honest "unavailable" state rather than a stale/fabricated number.
        const priceByMint: Record<string, AssetPriceInfo> = IS_MAINNET
          ? await fetchAssetPricesUsd(onChain.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals }))).catch(() => ({}))
          : {};
        mergeOnChainReserve(
          dtr.id,
          {
            reserveId: dtr.onChain.reserveId,
            reserve: dtr.onChain.reserve,
            reserveTokenMint: dtr.onChain.reserveTokenMint,
            mintAuthority: dtr.onChain.mintAuthority,
            vaultAuthority: dtr.onChain.vaultAuthority,
            assets: dtr.onChain.assets.map((a) => ({ mint: a.mint, symbol: a.symbol, decimals: a.decimals, weightBps: a.weightBps, reserveAsset: a.reserveAsset, vault: a.vault })),
          },
          onChain,
          priceByMint,
          IS_MAINNET,
        );
        // mergeOnChainReserve/mergeOnChainIntoDTR deliberately never touches
        // delegatesOnChain (it has no fresh delegate data to merge) -- it
        // used to be left entirely to RealReserveSync's next background poll
        // tick, up to 120s away under backoff. That's what made Grant/Update/
        // Remove Delegate's own "immediate refresh" never actually show the
        // change it just made. Re-verify delegates directly here too, right
        // after every refresh, using the SAME shared candidate list
        // (buildDelegateCandidateWallets) RealReserveSync uses -- authoritative
        // on-chain reads, never trusted from local state alone.
        const delegates = await discoverDelegatesForReserve(
          connection,
          programId,
          reserveAddress,
          buildDelegateCandidateWallets(dtr.onChain.reserve, onChain.manager, wallet.address),
        );
        setOnChainDelegates(dtr.id, delegates.map(onChainDelegateFromDiscovered), onChain.delegateCount);
      }
    } catch {
      // Best-effort immediate refresh; RealReserveSync's regular poll will catch up regardless.
    }
  }

  /** Wraps an on-chain management action with pending-state tracking, a toast, and an immediate refresh -- shared by every Phase F/G button below. */
  async function runOnChainAction(label: string, action: () => Promise<string>, extraCandidateMints: string[] = []) {
    setOnChainTxPending(label);
    try {
      const signature = await action();
      toast(transactionConfirmedToast(signature, `${label} confirmed`));
      await refreshRealReserveNow(extraCandidateMints);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Full technical detail (decoded ssr_protocol/Anchor error name + raw
      // message, via describeOnChainError inside managementClient.ts's own
      // throw) always goes to the console -- only a plain-language summary
      // reaches the toast, per the specific required copy for these two
      // failure modes. Every other action here keeps the decoded-but-still-
      // technical message as-is; it's already honest (see errors.ts), just
      // not one of the two the product spec calls out with fixed wording.
      console.error(`${label} failed:`, raw);
      const description =
        label === "Collect Fees"
          ? "Fees could not be collected. No funds were moved."
          : label === "Close Reserve" && /PendingFeesNotCollected|ReserveTokenSupplyNotZero/.test(raw)
            ? "This Reserve cannot close until all holder claims and outstanding fees are settled."
            : raw;
      toast({ variant: "destructive", title: `${label} failed`, description });
    } finally {
      setOnChainTxPending(null);
    }
  }

  if (!dtr) {
    const stillIndexing = pageState.kind === "indexing" || (pageState.kind === "not-found" && directCheck !== "confirmed-absent" && parseOnChainReserveId(dtrId) !== null);
    if (stillIndexing) {
      return (
        <div className="container mx-auto px-4 py-24 text-center">
          <h1 className="text-3xl font-merge-display font-bold mb-4">Verifying on {CLUSTER_LABEL}...</h1>
          <p className="text-muted-foreground mb-8">This Reserve was just created or resumed and is still being confirmed on Solana {CLUSTER_LABEL}. It will appear automatically in a moment.</p>
        </div>
      );
    }
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <h1 className="text-3xl font-merge-display font-bold mb-4">Reserve Not Found</h1>
        <Button asChild><Link href="/">Return Home</Link></Button>
      </div>
    );
  }

  if (!wallet.connected || !isManagerOrDelegate(dtr, wallet.address)) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <Shield className="w-16 h-16 text-destructive mx-auto mb-4" />
          <h1 className="text-3xl font-merge-display font-bold">Access Denied</h1>
          <p className="text-muted-foreground">
            You are not the Manager or an authorized Delegate for this reserve.
          </p>
          <Button asChild variant="outline">
            <Link href={`/dtr/${dtr.id}`}>Return to Reserve</Link>
          </Button>
        </div>
      </div>
    );
  }

  const isRoot = dtr.managerAddress === wallet.address;
  const hasManageDelegates = canManageDelegates(dtr, wallet.address);
  const hasRebalance = canRebalance(dtr, wallet.address);
  // Real on-chain permission checks (root manager OR a genuinely permitted
  // delegate, per dtr.onChain.delegatesOnChain -- see hasOnChainPermission's
  // fail-closed contract). Only meaningful for a genuinely on-chain Reserve;
  // the !dtr.onChain branches above (hasManageDelegates/hasRebalance) keep
  // using the local-simulated system for a purely local/demo Reserve.
  const canUpdateMetadataOnChain = isRoot || hasOnChainPermission(dtr.onChain, wallet.address, PERMISSION_FLAGS.UPDATE_METADATA);
  const canUpdateTargetsOnChain = isRoot || hasOnChainPermission(dtr.onChain, wallet.address, PERMISSION_FLAGS.UPDATE_TARGETS);
  const canManageLiquidityConfigOnChain = isRoot || hasOnChainPermission(dtr.onChain, wallet.address, PERMISSION_FLAGS.MANAGE_LIQUIDITY_CONFIG);
  const canAddRestrictedDelegateOnChain = isRoot || hasOnChainPermission(dtr.onChain, wallet.address, PERMISSION_FLAGS.ADD_RESTRICTED_DELEGATE);
  const canRemoveRestrictedDelegateOnChain = isRoot || hasOnChainPermission(dtr.onChain, wallet.address, PERMISSION_FLAGS.REMOVE_RESTRICTED_DELEGATE);
  const canManageFeesOnChain = isRoot || hasOnChainPermission(dtr.onChain, wallet.address, PERMISSION_FLAGS.MANAGE_FEES);
  // Unified gate for the rebalance-edit table, shared by both the on-chain
  // (real permission) and simulated (local permission) branches.
  const canEditRebalance = dtr.onChain ? canUpdateTargetsOnChain : hasRebalance;

  // Handlers: Profile picture (Reserve Identity card). Whether the current
  // signer may change it: for a real on-chain Reserve, the root manager or a
  // delegate holding the update-metadata permission. Since the
  // signature-free pointer flow, saving submits NO transaction, so this is
  // UI policy only (kept aligned with the permission update_metadata would
  // enforce), not an on-chain gate -- see the DECISION_LOG entry for the
  // accepted trade-off. A purely local/simulated Reserve has no gate beyond
  // the page's own manager-or-delegate access check above.
  const canEditProfilePicture = dtr.onChain ? canUpdateMetadataOnChain : true;

  const handlePickProfileImage = async (file: File | undefined) => {
    if (!file) return;
    setProfileImageError(null);
    try {
      setPendingProfileImage(await fileToProfileImageDataUrl(file));
    } catch (e) {
      setPendingProfileImage(null);
      setProfileImageError(e instanceof Error ? e.message : "This file could not be read as an image -- try a different one.");
    }
  };

  const handleSaveProfileImage = () => {
    if (!pendingProfileImage) return;
    setProfileImageError(null);
    const onChainMeta = dtr.onChain;
    if (!onChainMeta) {
      // Purely local/simulated Reserve: nothing on-chain to update.
      setReserveProfileImage(dtr.id, pendingProfileImage);
      setPendingProfileImage(null);
      toast({ title: "Profile picture updated", description: "This Reserve now shows the new picture." });
      return;
    }
    // Real on-chain Reserve: store the picture (content-addressed,
    // idempotent) and repoint this Reserve's mutable picture pointer in the
    // same upload -- no metadata republish, no update_metadata transaction,
    // no wallet approval (see reserveImageClient.ts's pointer notes; the
    // previous flow's one-wallet-approval metadata republish is in git
    // history). Shown immediately; RealReserveSync's next discovery pass
    // re-derives the same value from the pointer map for every viewer.
    setSavingProfileImage(true);
    void (async () => {
      try {
        const imageUrl = await uploadReserveImage(window.location.origin, pendingProfileImage, IS_MAINNET ? "mainnet" : "devnet", onChainMeta.reserve);
        setReserveProfileImage(dtr.id, imageUrl);
        setPendingProfileImage(null);
        toast({ title: "Profile picture updated", description: "This Reserve now shows the new picture everywhere in the app." });
      } catch (e) {
        setProfileImageError(e instanceof Error ? e.message : "Failed to save the profile picture. Please try again.");
      } finally {
        setSavingProfileImage(false);
      }
    })();
  };

  // Handlers: Delegates
  const handleAddDelegate = () => {
    const res = addDelegate(dtr.id, newDelegateAddress, newDelegatePerms);
    if (res.success) {
      toast({ title: "Delegate Added", description: res.message });
      setNewDelegateAddress("");
      setNewDelegatePerms(emptyPermissions());
    } else {
      toast({ variant: "destructive", title: "Error", description: res.message });
    }
  };

  const handleUpdateDelegate = (address: string) => {
    const res = updateDelegatePermissions(dtr.id, address, editPerms);
    if (res.success) {
      toast({ title: "Permissions Updated", description: res.message });
      setEditingDelegate(null);
    } else {
      toast({ variant: "destructive", title: "Error", description: res.message });
    }
  };

  const handleRemoveDelegate = (address: string) => {
    const res = removeDelegate(dtr.id, address);
    if (res.success) {
      toast({ title: "Delegate Removed", description: res.message });
    } else {
      toast({ variant: "destructive", title: "Error", description: res.message });
    }
  };

  const startEditingDelegate = (address: string, perms: ManagerPermissions) => {
    setEditingDelegate(address);
    setEditPerms(perms);
  };

  const toggleNewPerm = (key: keyof ManagerPermissions) => {
    setNewDelegatePerms(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleEditPerm = (key: keyof ManagerPermissions) => {
    setEditPerms(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Handlers: Rebalance
  const handleWeightEdit = (symbol: string, valueStr: string) => {
    const val = parseFloat(valueStr);
    if (isNaN(val)) {
      const newEdits = { ...rebalanceEdits };
      delete newEdits[symbol];
      setRebalanceEdits(newEdits);
    } else {
      setRebalanceEdits({ ...rebalanceEdits, [symbol]: val / 100 });
    }
  };

  const executeRebalance = () => {
    const res = rebalanceDTR(dtr.id, rebalanceEdits, adjustRemaining);
    if (res.success) {
      toast({ title: "Rebalance Executed", description: res.message });
      setRebalanceEdits({});
    } else {
      toast({ variant: "destructive", title: "Rebalance Failed", description: res.message });
    }
  };

  const getPreviewWeights = () => {
    if (Object.keys(rebalanceEdits).length === 0) return { comp: dtr.composition, unallocated: dtr.unallocatedPct };
    
    // Simulate applyRebalance locally for preview
    const editedSymbols = new Set(Object.keys(rebalanceEdits));
    const edited = dtr.composition.map((a) =>
      editedSymbols.has(a.symbol) ? { ...a, weight: rebalanceEdits[a.symbol] } : a,
    );

    if (!adjustRemaining) {
      const total = edited.reduce((sum, a) => sum + a.weight, 0);
      return { comp: edited, unallocated: Math.max(0, 1 - total) };
    }

    const editedSum = edited
      .filter((a) => editedSymbols.has(a.symbol))
      .reduce((sum, a) => sum + a.weight, 0);
    const remaining = Math.max(0, 1 - editedSum);
    const othersOriginalSum = dtr.composition
      .filter((a) => !editedSymbols.has(a.symbol))
      .reduce((sum, a) => sum + a.weight, 0);

    const scaled = edited.map((a) => {
      if (editedSymbols.has(a.symbol)) return a;
      if (othersOriginalSum <= 0) return a;
      const original = dtr.composition.find((o) => o.symbol === a.symbol)!.weight;
      return { ...a, weight: remaining * (original / othersOriginalSum) };
    });

    return { comp: scaled, unallocated: 0 };
  };

  const preview = getPreviewWeights();
  const previewTotal = preview.comp.reduce((sum, a) => sum + a.weight, 0) + preview.unallocated;
  const isPreviewValid = previewTotal <= 1.0001 && Object.keys(rebalanceEdits).length > 0;

  // DEC-0084: proposed composition for the real on-chain branch's slider
  // editor -- existing on-chain assets (orderIndex order) followed by any
  // asset added this session but not yet submitted. This order is exactly
  // the order_index order Submit Rebalance must use.
  const proposedAssetRows = dtr.onChain
    ? [
        ...[...dtr.onChain.assets].sort((a, b) => a.orderIndex - b.orderIndex).map((a) => ({
          mint: a.mint,
          symbol: a.symbol,
          decimals: a.decimals,
          isNew: false,
          benchmarkBps: a.weightBps,
        })),
        ...sessionAddedAssets
          .filter((sa) => !dtr.onChain!.assets.some((a) => a.mint === sa.mint))
          .map((sa) => ({ ...sa, isNew: true, benchmarkBps: 0 })),
      ]
    : [];
  const totalProposedBps = proposedAssetRows.reduce((sum, r) => sum + (proposedWeightsBps[r.mint] ?? 0), 0);
  const totalReserveUsd = dtr.onChain
    ? dtr.onChain.assets.reduce((sum, a) => {
        const balanceHuman = Number(dtr.onChain!.vaultBalancesRaw[a.mint] ?? "0") / 10 ** a.decimals;
        return sum + balanceHuman * (TEST_ASSET_PRICES_USD[a.mint] ?? 0);
      }, 0)
    : 0;

  /**
   * Applies one slider/input edit via the devUSDC-priority cash-bucket model
   * -- pure local state, never a transaction. Reads the PRIOR bps map from
   * inside the setState updater (not from the render-time `proposedWeightsBps`
   * closure) -- a continuous Slider drag fires onValueChange many times in
   * rapid succession, often batched by React before a re-render lands, and
   * every one of those calls needs to build on the one immediately before it
   * rather than all redistributing from the same stale starting snapshot
   * (which was breaking the "always sums to exactly 10000" invariant under
   * fast dragging -- confirmed root cause of the false "must total 100%"
   * error some users hit after a real edit that already was 100%).
   */
  function handleSliderChange(mint: string, newWeightBps: number) {
    setProposedWeightsBps((prev) => {
      const current: SliderAsset[] = proposedAssetRows.map((r) => ({ mint: r.mint, weightBps: prev[r.mint] ?? 0 }));
      const updated = applySliderWeightChange(current, mint, newWeightBps, CASH_SLOT_MINT);
      const next = { ...prev };
      for (const a of updated) next[a.mint] = a.weightBps;
      return next;
    });
  }

  /** One click moves an asset from the search list into the proposed composition -- pure local state, never a transaction. Seeded at 0% so it never silently displaces another asset's weight. */
  function handleAddAssetToSession(asset: { symbol: string; mint: string; decimals: number }) {
    setSessionAddedAssets((prev) => (prev.some((a) => a.mint === asset.mint) ? prev : [...prev, asset]));
    setProposedWeightsBps((prev) => (asset.mint in prev ? prev : { ...prev, [asset.mint]: 0 }));
  }

  /** Undoes an in-session add -- zeroes its slider (redistributing its weight away first) then drops the row. Pure local state, never a transaction; a not-yet-submitted asset was never registered on-chain, so there is nothing to undo there either. */
  function handleRemoveSessionAsset(mint: string) {
    handleSliderChange(mint, 0);
    setSessionAddedAssets((prev) => prev.filter((a) => a.mint !== mint));
    setProposedWeightsBps((prev) => {
      const next = { ...prev };
      delete next[mint];
      return next;
    });
  }

  // A session-added asset left at 0% is simply never submitted -- no point
  // registering a zero-weight asset (wastes an asset slot for nothing), so
  // it silently drops out of the plan rather than round-tripping through
  // add_reserve_asset_active(0) followed by nothing.
  const rebalanceAssetPlan: RebalanceAssetPlan[] = dtr.onChain
    ? [
        ...[...dtr.onChain.assets].sort((a, b) => a.orderIndex - b.orderIndex).map((a) => ({
          mint: a.mint,
          isNew: false,
          targetWeightBps: proposedWeightsBps[a.mint] ?? a.weightBps,
        })),
        ...sessionAddedAssets
          .map((sa) => ({ mint: sa.mint, isNew: true, targetWeightBps: proposedWeightsBps[sa.mint] ?? 0 }))
          .filter((a) => a.targetWeightBps > 0),
      ]
    : [];
  const submitNeedsLiquidityConfig = rebalanceAssetPlan.some((a) => a.isNew);
  const canSubmitRebalance = canUpdateTargetsOnChain && (!submitNeedsLiquidityConfig || canManageLiquidityConfigOnChain);
  const hasRebalanceChanges = dtr.onChain
    ? submitNeedsLiquidityConfig || dtr.onChain.assets.some((a) => (proposedWeightsBps[a.mint] ?? a.weightBps) !== a.weightBps)
    : false;

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-8">
        <Link href={`/dtr/${dtr.id}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-4 transition-colors">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Reserve
        </Link>
        <div className="flex items-start gap-4">
          <Avatar className="h-16 w-16 border-2 border-border shadow-md">
            {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
            <AvatarFallback className="bg-primary/10 text-primary text-xl font-merge-display font-bold">
              {dtr.ticker.slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-3xl font-merge-display font-bold tracking-tight mb-1">Manager Dashboard</h1>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{dtr.name}</span>
              <Badge variant="secondary" className="font-merge-mono text-xs">{dtr.ticker}</Badge>
              {isRoot && <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">Root Manager</Badge>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
        <div className="md:col-span-1 space-y-2">
          <button
            onClick={() => setActiveTab("overview")}
            className={`w-full text-left px-4 py-3 rounded-lg font-medium transition-colors flex items-center gap-3 ${activeTab === "overview" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            <Shield className="w-4 h-4" /> Overview
          </button>
          
          <button
            onClick={() => setActiveTab("delegates")}
            className={`w-full text-left px-4 py-3 rounded-lg font-medium transition-colors flex items-center gap-3 ${activeTab === "delegates" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            <Users className="w-4 h-4" /> Delegates
          </button>

          <button
            onClick={() => setActiveTab("rebalance")}
            className={`w-full text-left px-4 py-3 rounded-lg font-medium transition-colors flex items-center gap-3 ${activeTab === "rebalance" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            <Sliders className="w-4 h-4" /> Rebalance
          </button>

          {dtr.onChain && (
            <button
              onClick={() => setActiveTab("activity")}
              className={`w-full text-left px-4 py-3 rounded-lg font-medium transition-colors flex items-center gap-3 ${activeTab === "activity" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              <History className="w-4 h-4" /> Activity
            </button>
          )}
        </div>

        <div className="md:col-span-3">
          {activeTab === "overview" && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Reserve Identity</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-2">Profile Picture</p>
                    <div className="flex items-start gap-4">
                      <Avatar className="h-16 w-16 border-2 border-border shadow-md">
                        {(pendingProfileImage ?? dtr.logoUrl) && <AvatarImage src={pendingProfileImage ?? dtr.logoUrl} alt={dtr.ticker} />}
                        <AvatarFallback className="bg-primary/10 text-primary text-xl font-merge-display font-bold">
                          {dtr.ticker.slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      {canEditProfilePicture ? (
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
                            <Button variant="outline" size="sm" disabled={savingProfileImage} onClick={() => profileImageInputRef.current?.click()}>
                              Choose Image
                            </Button>
                            {pendingProfileImage && (
                              <>
                                <Button size="sm" disabled={savingProfileImage} onClick={handleSaveProfileImage}>
                                  {savingProfileImage ? "Saving..." : "Save Picture"}
                                </Button>
                                <Button variant="ghost" size="sm" disabled={savingProfileImage} onClick={() => setPendingProfileImage(null)}>
                                  Cancel
                                </Button>
                              </>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Shown next to this Reserve everywhere in the app. PNG, JPEG, WebP, or GIF -- large images are resized automatically. Saving updates the picture immediately for everyone.
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Only the Root Manager, or a delegate granted the "Update Metadata" permission, can change this Reserve's picture.
                        </p>
                      )}
                    </div>
                    {profileImageError && <p className="text-sm text-destructive mt-2">{profileImageError}</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Name</p>
                      <p className="font-medium">{dtr.name}</p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Ticker</p>
                      <p className="font-merge-mono font-medium">{dtr.ticker}</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-1">Root Manager</p>
                    <p className="font-merge-mono text-sm break-all bg-muted/50 p-2 rounded border border-border">{dtr.managerAddress}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-1">Reserve Contract</p>
                    <p className="font-merge-mono text-sm break-all bg-muted/50 p-2 rounded border border-border">{dtr.dtrAddress}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Performance & Scale</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">AUM</p>
                      <p className="font-merge-mono font-bold text-lg">{formatUsdcOrUnavailable(dtr.aum, !(IS_MAINNET && dtr.onChain?.priceSource === "unavailable"), { compact: true })}</p>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">Market Cap</p>
                      <p className="font-merge-mono font-bold text-lg">
                        {formatUsdcOrUnavailable(computeMarketCap(dtr.onChain?.reserveTokenSupplyRaw ?? "0", dtr.tokenPrice), !(IS_MAINNET && dtr.onChain?.priceSource === "unavailable"), { compact: true })}
                      </p>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">Holders</p>
                      <p className="font-merge-mono font-bold text-lg">{dtr.holders.toLocaleString()}</p>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">Total Delegates</p>
                      <p className="font-merge-mono font-bold text-lg">
                        {dtr.onChain ? (dtr.onChain.delegateCountOnChain ?? "—") : dtr.delegates.length}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {IS_MAINNET && dtr.onChain && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xl font-merge-display">One-Approval Trading</CardTitle>
                    <CardDescription>
                      A one-time on-chain lookup table for this Reserve lets every Buy and Sell complete in a single wallet approval instead of several
                      separate ones. Creating it costs a small one-time network deposit (~0.003 SOL) paid by your wallet.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {tradingAlt === "loading" ? (
                      <p className="text-sm text-muted-foreground">Checking whether one-approval trading is enabled…</p>
                    ) : tradingAlt ? (
                      <div className="flex items-center gap-2 text-sm">
                        <Badge variant="secondary">Enabled</Badge>
                        <span className="font-merge-mono text-xs text-muted-foreground break-all">{tradingAlt}</span>
                      </div>
                    ) : (
                      <Button onClick={() => void enableOneApprovalTrading()} disabled={enablingAlt || !walletCtx.publicKey}>
                        {enablingAlt ? "Enabling…" : "Enable one-approval trading"}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-xl font-merge-display">Delegates</CardTitle>
                    <CardDescription>
                      {dtr.onChain ? "Verified on-chain delegates for this Reserve." : "Simulated delegates for this demo Reserve."}
                    </CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setActiveTab("delegates")}>Manage &rarr;</Button>
                </CardHeader>
                <CardContent>
                  {dtr.onChain ? (
                    (dtr.onChain.delegatesOnChain ?? []).length === 0 ? (
                      <div className="text-center p-6 border border-dashed border-border rounded-lg text-muted-foreground text-sm">
                        {dtr.onChain.delegateCountOnChain
                          ? `${dtr.onChain.delegateCountOnChain} delegate(s) reported on-chain, but none matched this pass's candidate wallets -- see the Delegates tab.`
                          : "No delegates found on-chain for this Reserve."}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {(dtr.onChain.delegatesOnChain ?? []).map((del) => (
                          <div key={del.wallet} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border/50 bg-muted/20">
                            <div className="min-w-0">
                              <p className="font-medium truncate">{displayDelegateName(dtr.onChain!.reserve, del.wallet)}</p>
                              <p className="text-xs text-muted-foreground font-merge-mono">{shortenAddress(del.wallet)}</p>
                            </div>
                            <div className="flex flex-wrap gap-1 justify-end shrink-0 max-w-[50%]">
                              {decodeOnChainPermissions(del.permissions).slice(0, 2).map((c) => (
                                <Badge key={c} variant="secondary" className="text-[9px] py-0">{c}</Badge>
                              ))}
                              {decodeOnChainPermissions(del.permissions).length > 2 && (
                                <Badge variant="secondary" className="text-[9px] py-0">+{decodeOnChainPermissions(del.permissions).length - 2}</Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  ) : dtr.delegates.length === 0 ? (
                    <div className="text-center p-6 border border-dashed border-border rounded-lg text-muted-foreground text-sm">
                      No delegates configured. The Root Manager holds all permissions.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {dtr.delegates.map((del) => (
                        <div key={del.address} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border/50 bg-muted/20">
                          <p className="font-merge-mono text-xs truncate">{del.address}</p>
                          <div className="flex flex-wrap gap-1 justify-end shrink-0">
                            {Object.entries(del.permissions).filter(([, v]) => v).slice(0, 2).map(([k]) => (
                              <Badge key={k} variant="secondary" className="text-[9px] py-0">{k}</Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Fee Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Mint Fee (configured)</p>
                      <p className="font-merge-mono font-medium">{formatPct(dtr.feeConfig.mintFeePct)}</p>
                      {dtr.onChain?.effectiveMintFeeProtocolBps != null && (
                        <p className="text-xs font-merge-mono text-muted-foreground mt-1">
                          {(dtr.onChain.effectiveMintFeeProtocolBps / 100).toFixed(2)}% Protocol + {(dtr.onChain.effectiveMintFeeManagerBps! / 100).toFixed(2)}% Manager
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Annualized TVL Fee (configured)</p>
                      <p className="font-merge-mono font-medium">{formatPct(dtr.feeConfig.tvlFeePct)}</p>
                      {dtr.onChain?.effectiveTvlFeeProtocolBps != null && (
                        <p className="text-xs font-merge-mono text-muted-foreground mt-1">
                          {(dtr.onChain.effectiveTvlFeeProtocolBps / 100).toFixed(2)}% Protocol + {(dtr.onChain.effectiveTvlFeeManagerBps! / 100).toFixed(2)}% Manager
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Buy Tax</p>
                      <p className="font-merge-mono font-medium">{formatPct(dtr.feeConfig.managerBuyTaxPct)}</p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Sell Tax</p>
                      <p className="font-merge-mono font-medium">{formatPct(dtr.feeConfig.managerSellTaxPct)}</p>
                    </div>
                  </div>
                  {dtr.onChain && (dtr.feeConfig.managerBuyTaxPct > 0 || dtr.feeConfig.managerSellTaxPct > 0) && (
                    <p className="text-xs text-muted-foreground italic -mt-2">
                      Buy Tax and Sell Tax are configuration for a future secondary market (e.g. a DEX listing) -- not enforced by minting or redeeming directly from this Reserve.
                    </p>
                  )}

                  {dtr.onChain && (
                    <div className="pt-4 border-t border-border/50">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                          <Coins className="w-4 h-4" /> Manager Fee Recipients
                        </p>
                        {canManageFeesOnChain && (
                          <Button variant="outline" size="sm" onClick={openRoutingEditor} disabled={onChainTxPending !== null || collectingRecipient !== null}>
                            {feeRecipientsData?.initialized ? "Change Routing" : "Set Up Recipients"}
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">
                        Fees accrue in-kind as pending Reserve Token shares. Only a recipient's own connected wallet can collect its balance --
                        the root Manager cannot collect on a recipient's behalf, and recipients cannot collect for each other.
                        {feeRecipientsData && (
                          <>
                            {" "}
                            {feeRecipientsData.initialized
                              ? `Routing last set ${new Date(feeRecipientsData.routingUpdatedAt * 1000).toLocaleString()}.`
                              : "This Reserve is still using its original single Primary Fee Destination -- it has never had multi-recipient routing configured."}
                          </>
                        )}
                      </p>
                      <div className="space-y-2 mb-3">
                        {(feeRecipientsData?.recipients ?? []).map((r) => {
                          const isConnectedWallet = wallet.connected && wallet.address === r.wallet;
                          const isCollectingThisRow = collectingRecipient === r.wallet;
                          const lastCollection = lastRecipientCollection[r.wallet];
                          return (
                            <div key={r.wallet} className="p-3 bg-muted/30 rounded-lg border border-border/50 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-merge-mono text-xs truncate">{r.wallet}</p>
                                <p className="text-xs text-muted-foreground">
                                  {(r.allocationBps / 100).toFixed(1)}% of Manager share &middot; total accrued / currently claimable{" "}
                                  {(Number(r.pendingFeeShares) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} {dtr.ticker}
                                  {" "}&middot; total collected {(Number(r.collectedFeeShares) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} {dtr.ticker}
                                </p>
                                {lastCollection && (
                                  <p className="text-xs text-muted-foreground">
                                    Last collection: {new Date(lastCollection.ts * 1000).toLocaleString()} &middot;{" "}
                                    <a href={explorerUrl("tx", lastCollection.signature)} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                                      {lastCollection.signature.slice(0, 8)}...
                                    </a>
                                  </p>
                                )}
                              </div>
                              {isConnectedWallet ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0 gap-1.5"
                                  disabled={collectingRecipient !== null || r.pendingFeeShares === "0"}
                                  onClick={() => void collectRecipientFee(r.wallet)}
                                >
                                  <Coins className="w-3.5 h-3.5" /> {isCollectingThisRow ? "Confirming..." : "Collect"}
                                </Button>
                              ) : (
                                <Badge variant="secondary" className="shrink-0 text-xs">Claimable by this wallet</Badge>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {routingEditorOpen && (
                        <div className="p-4 rounded-lg border border-border bg-muted/20 space-y-3 mb-3">
                          <p className="text-sm font-semibold">Configure Manager Fee Recipients</p>
                          <p className="text-xs text-muted-foreground">
                            Up to 10 recipients total. Percentages divide the Manager's fee share and must sum to exactly 100%. A recipient who
                            stays on the list keeps their accrued balance -- only removing a recipient with an uncollected balance is blocked
                            until that wallet's own connected session collects it first.
                          </p>
                          <div className="space-y-2">
                            {routingRecipients.map((r) => (
                              <div key={r.address} className="flex items-center justify-between gap-2 p-2 rounded border border-border bg-background text-sm">
                                <span className="font-merge-mono text-xs truncate">{r.address}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                  <Badge variant="secondary" className="font-merge-mono">{r.pct}%</Badge>
                                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeRoutingRecipient(r.address)}>
                                    <X className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                          {routingRecipients.length < 10 && (
                            <div className="flex gap-2">
                              <Input placeholder="Recipient wallet address" className="font-merge-mono text-sm" value={newRoutingAddress} onChange={(e) => setNewRoutingAddress(e.target.value)} />
                              <Input type="number" placeholder="%" className="w-24 font-merge-mono" value={newRoutingPct} onChange={(e) => setNewRoutingPct(e.target.value)} />
                              <Button variant="outline" onClick={addRoutingRecipient} className="shrink-0 gap-1.5">
                                <Plus className="w-4 h-4" /> Add
                              </Button>
                            </div>
                          )}
                          <p className={`text-xs font-merge-mono ${routingTotalPct !== 100 ? "text-destructive" : "text-muted-foreground"}`}>Total: {routingTotalPct.toFixed(1)}% (must be exactly 100%)</p>
                          <div className="flex gap-2">
                            <Button size="sm" disabled={onChainTxPending !== null || routingTotalPct !== 100 || routingRecipients.length === 0} onClick={() => void submitRoutingChange()}>
                              {onChainTxPending === "Update Fee Routing" ? "Confirming..." : "Submit Routing"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRoutingEditorOpen(false)}>Cancel</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                </CardContent>
              </Card>

              {dtr.onChain && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xl font-merge-display flex items-center gap-2">
                      <PowerOff className="w-5 h-5" /> Wind Down
                    </CardTitle>
                    <CardDescription>
                      One-way lifecycle: Active &rarr; Wind Down &rarr; Closed. Blocks new Reserve Token issuance immediately;
                      redemption stays available throughout. Root Manager only.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Current status:</span>
                      <Badge variant={dtr.onChain.status === "active" ? "outline" : dtr.onChain.status === "windDown" ? "secondary" : "destructive"} className="uppercase">
                        {dtr.onChain.status}
                      </Badge>
                    </div>

                    {dtr.onChain.status === "active" && (
                      <Button
                        variant="destructive"
                        disabled={!isRoot || onChainTxPending !== null}
                        title={!isRoot ? "Only the Root Manager may initiate wind-down." : undefined}
                        onClick={() => void runOnChainAction("Initiate Wind Down", () => executeInitiateWindDown(connection, walletCtx, dtr.onChain!.reserve))}
                        className="gap-2"
                      >
                        <PowerOff className="w-4 h-4" /> {onChainTxPending === "Initiate Wind Down" ? "Confirming..." : "Initiate Wind Down"}
                      </Button>
                    )}

                    {dtr.onChain.status === "windDown" && (() => {
                      const supplyRemaining = dtr.onChain!.reserveTokenSupplyRaw;
                      const allVaultsEmpty = Object.values(dtr.onChain!.vaultBalancesRaw).every((v) => v === "0");
                      // Mirrors close_reserve.rs's on-chain PendingFeesNotCollected check
                      // (2026-08-13 corrective pass): a Reserve cannot close while either
                      // fee recipient still has an uncollected share, since closing removes
                      // the Reserve account collect_fees would otherwise pay out from.
                      const feesPending =
                        (dtr.onChain!.pendingManagerFeeShares ?? "0") !== "0" || (dtr.onChain!.pendingProtocolFeeShares ?? "0") !== "0";
                      const canClose = supplyRemaining === "0" && allVaultsEmpty && !feesPending;
                      return (
                        <div className="space-y-3">
                          <p className="text-sm text-muted-foreground">
                            Reserve Token supply remaining:{" "}
                            <span className="font-merge-mono font-medium text-foreground">
                              {(Number(supplyRemaining) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} {dtr.ticker}
                            </span>.
                            Closing requires this to reach zero (every holder must redeem out first -- redemption remains open during Wind Down),
                            every asset vault balance to be zero, and every pending fee share collected.
                          </p>
                          {feesPending && (
                            <p className="text-sm text-amber-600 dark:text-amber-500">
                              This Reserve cannot close until all holder claims and outstanding fees are settled. Collect the pending fees above first.
                            </p>
                          )}
                          <Button
                            variant="destructive"
                            disabled={!isRoot || !canClose || onChainTxPending !== null}
                            title={
                              !isRoot
                                ? "Only the Root Manager may close this Reserve."
                                : feesPending
                                  ? "This Reserve cannot close until all holder claims and outstanding fees are settled."
                                  : !canClose
                                    ? "Supply and every vault balance must be zero first."
                                    : undefined
                            }
                            onClick={() => {
                              const assetMintsInOrder = [...dtr.onChain!.assets].sort((a, b) => a.orderIndex - b.orderIndex).map((a) => a.mint);
                              void runOnChainAction("Close Reserve", () => executeCloseReserve(connection, walletCtx, dtr.onChain!.reserve, dtr.onChain!.reserveTokenMint, assetMintsInOrder));
                            }}
                            className="gap-2"
                          >
                            <XCircle className="w-4 h-4" /> {onChainTxPending === "Close Reserve" ? "Confirming..." : "Close Reserve"}
                          </Button>
                        </div>
                      );
                    })()}

                    {dtr.onChain.status === "closed" && (
                      <p className="text-sm text-muted-foreground">This Reserve has been closed. Its on-chain account no longer exists.</p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {activeTab === "delegates" && dtr.onChain && (
            <div className="space-y-6">
              <div className="bg-muted/30 border border-border/50 p-4 rounded-lg flex items-center gap-3">
                <Shield className="w-5 h-5 shrink-0 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Granting, editing, or removing a delegate below asks your wallet to approve a real change on Solana {CLUSTER_LABEL}. An
                  unrestricted delegate can only be granted, edited, or removed by the Root Manager; a restricted delegate can also be
                  managed by another delegate holding the matching permission. This list may not show every delegate this Reserve
                  actually has -- an unresolved wallet still holds its real permissions even if it isn't listed here.
                </p>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Active Delegates</CardTitle>
                  <CardDescription>
                    Verified on Solana {CLUSTER_LABEL}
                    {dtr.onChain.delegateCountOnChain !== undefined && ` -- ${dtr.onChain.delegateCountOnChain} reported on-chain`}.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {(dtr.onChain.delegatesOnChain ?? []).length === 0 ? (
                    <div className="text-center p-8 border border-dashed border-border rounded-lg text-muted-foreground">
                      {dtr.onChain.delegateCountOnChain
                        ? `${dtr.onChain.delegateCountOnChain} delegate(s) reported on-chain, but none matched this discovery pass's candidate wallets.`
                        : "No delegates found on-chain for this Reserve. The Root Manager holds all permissions."}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {(dtr.onChain.delegatesOnChain ?? []).map((del) => {
                        const canEditThis = del.restricted ? canAddRestrictedDelegateOnChain : isRoot;
                        const canRemoveThis = del.restricted ? canRemoveRestrictedDelegateOnChain : isRoot;
                        const busy = onChainTxPending === `Update permissions for ${shortenAddress(del.wallet)}` || onChainTxPending === `Remove delegate ${shortenAddress(del.wallet)}`;
                        return (
                          <OnChainDelegateRow
                            key={del.wallet}
                            reserveAddress={dtr.onChain!.reserve}
                            wallet={del.wallet}
                            delegateAccount={del.delegateAccount}
                            permissions={del.permissions}
                            restricted={del.restricted}
                            canEditLabel={hasManageDelegates}
                            canEditPermissions={canEditThis}
                            canRemove={canRemoveThis}
                            busy={busy}
                            onSavePermissions={(newPerms) =>
                              void runOnChainAction(`Update permissions for ${shortenAddress(del.wallet)}`, () =>
                                executeUpdateDelegatePermissions(connection, walletCtx, dtr.onChain!.reserve, del.wallet, newPerms),
                              )
                            }
                            onRemove={() =>
                              void runOnChainAction(`Remove delegate ${shortenAddress(del.wallet)}`, async () => {
                                const sig = await executeRemoveDelegate(connection, walletCtx, dtr.onChain!.reserve, del.wallet);
                                forgetDelegateWallet(dtr.onChain!.reserve, del.wallet);
                                return sig;
                              })
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Grant a New Delegate</CardTitle>
                  <CardDescription>
                    {isRoot
                      ? "As Root Manager, you can grant either a restricted or unrestricted delegate."
                      : canAddRestrictedDelegateOnChain
                        ? "You can grant a restricted delegate (only the Root Manager can grant an unrestricted one)."
                        : "You need the Root Manager or a delegate with Add Restricted Delegate permission to grant a new delegate."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="onchain-new-delegate-wallet">Delegate wallet address</Label>
                    <Input
                      id="onchain-new-delegate-wallet"
                      placeholder="Solana wallet address"
                      className="font-merge-mono mt-1.5"
                      value={onChainNewDelegateWallet}
                      onChange={(e) => setOnChainNewDelegateWallet(e.target.value)}
                      disabled={(!isRoot && !canAddRestrictedDelegateOnChain) || onChainTxPending !== null}
                    />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {ON_CHAIN_PERMISSION_FLAGS.map((f) => (
                      <div key={f.bit} className="flex items-center space-x-2">
                        <Checkbox
                          id={`onchain-new-perm-${f.bit}`}
                          checked={(onChainNewDelegatePermBits & f.bit) !== 0}
                          onCheckedChange={() => setOnChainNewDelegatePermBits((prev) => (prev & f.bit) !== 0 ? prev & ~f.bit : prev | f.bit)}
                          disabled={(!isRoot && !canAddRestrictedDelegateOnChain) || onChainTxPending !== null}
                        />
                        <label htmlFor={`onchain-new-perm-${f.bit}`} className="text-sm font-medium leading-none">{f.label}</label>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="onchain-new-delegate-restricted"
                      checked={onChainNewDelegateRestricted}
                      onCheckedChange={(c) => setOnChainNewDelegateRestricted(c === true)}
                      disabled={!isRoot || onChainTxPending !== null}
                    />
                    <label htmlFor="onchain-new-delegate-restricted" className="text-sm font-medium leading-none">
                      Restricted delegate {!isRoot && "(required -- only the Root Manager can grant an unrestricted delegate)"}
                    </label>
                  </div>
                  <Button
                    disabled={
                      (!isRoot && !canAddRestrictedDelegateOnChain) ||
                      onChainTxPending !== null ||
                      !onChainNewDelegateWallet.trim() ||
                      (!isRoot && !onChainNewDelegateRestricted)
                    }
                    onClick={() =>
                      void runOnChainAction("Grant Delegate", async () => {
                        const grantedWallet = onChainNewDelegateWallet.trim();
                        const sig = await executeAddDelegate(
                          connection,
                          walletCtx,
                          dtr.onChain!.reserve,
                          grantedWallet,
                          onChainNewDelegatePermBits,
                          isRoot ? onChainNewDelegateRestricted : true,
                        );
                        // The app knows this exact wallet address right now
                        // (the user just typed it and the grant just
                        // confirmed) -- record it as a discovery candidate
                        // before runOnChainAction's own immediate refresh
                        // runs, so this same refresh cycle picks it up
                        // instead of leaving the Delegates tab to show "N
                        // reported on-chain, but none matched" until some
                        // future lucky poll. See delegateDiscoveryCandidates.ts.
                        rememberDelegateWallet(dtr.onChain!.reserve, grantedWallet);
                        return sig;
                      }
                      ).then(() => {
                        setOnChainNewDelegateWallet("");
                        setOnChainNewDelegatePermBits(0);
                      })
                    }
                    className="gap-2"
                  >
                    <Plus className="w-4 h-4" /> {onChainTxPending === "Grant Delegate" ? "Confirming..." : "Grant Delegate"}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "delegates" && !dtr.onChain && (
            <div className="space-y-6">
              {!hasManageDelegates && (
                <div className="bg-destructive/10 text-destructive p-4 rounded-lg flex items-center gap-3 border border-destructive/20">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="font-medium">You do not have permission to manage delegates. This view is read-only.</p>
                </div>
              )}

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-xl font-merge-display flex items-center gap-2">
                      Active Delegates <Badge variant="secondary" className="text-[9px] uppercase">Simulated Demo</Badge>
                    </CardTitle>
                    <CardDescription>Wallets granted specific management permissions.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {dtr.delegates.length === 0 ? (
                    <div className="text-center p-8 border border-dashed border-border rounded-lg text-muted-foreground">
                      No delegates configured. The Root Manager holds all permissions.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {dtr.delegates.map(del => (
                        <div key={del.address} className="border border-border rounded-lg p-4 bg-card/50">
                          {editingDelegate === del.address ? (
                            <div className="space-y-4">
                              <p className="font-merge-mono text-sm break-all mb-4">{del.address}</p>
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {Object.keys(emptyPermissions()).map(key => {
                                  const k = key as keyof ManagerPermissions;
                                  return (
                                    <div key={k} className="flex items-center space-x-2">
                                      <Checkbox 
                                        id={`edit-${k}`} 
                                        checked={editPerms[k]} 
                                        onCheckedChange={() => toggleEditPerm(k)}
                                      />
                                      <label htmlFor={`edit-${k}`} className="text-sm font-medium leading-none capitalize">
                                        {k.replace(/([A-Z])/g, ' $1').trim()}
                                      </label>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="flex justify-end gap-2 pt-2">
                                <Button variant="ghost" size="sm" onClick={() => setEditingDelegate(null)}>Cancel</Button>
                                <Button size="sm" onClick={() => handleUpdateDelegate(del.address)}>Save Changes</Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                              <div className="space-y-2">
                                <p className="font-merge-mono text-sm break-all">{del.address}</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {Object.entries(del.permissions).map(([k, v]) => v ? (
                                    <Badge key={k} variant="secondary" className="text-[10px] py-0">{k}</Badge>
                                  ) : null)}
                                </div>
                              </div>
                              {hasManageDelegates && (
                                <div className="flex gap-2 shrink-0">
                                  <Button variant="outline" size="sm" onClick={() => startEditingDelegate(del.address, del.permissions)}>
                                    <Edit2 className="w-4 h-4" />
                                  </Button>
                                  <Button variant="destructive" size="sm" onClick={() => handleRemoveDelegate(del.address)}>
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {hasManageDelegates && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg font-merge-display">Add New Delegate</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label>Wallet Address</Label>
                      <Input 
                        placeholder="Enter Solana wallet address..." 
                        value={newDelegateAddress}
                        onChange={(e) => setNewDelegateAddress(e.target.value)}
                        className="font-merge-mono"
                      />
                    </div>
                    <div className="space-y-3 pt-2">
                      <Label>Permissions</Label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 border border-border rounded-lg bg-muted/20">
                        {Object.keys(emptyPermissions()).map(key => {
                          const k = key as keyof ManagerPermissions;
                          return (
                            <div key={`new-${k}`} className="flex items-center space-x-2">
                              <Checkbox 
                                id={`new-${k}`} 
                                checked={newDelegatePerms[k]} 
                                onCheckedChange={() => toggleNewPerm(k)}
                              />
                              <label htmlFor={`new-${k}`} className="text-sm font-medium leading-none capitalize cursor-pointer">
                                {k.replace(/([A-Z])/g, ' $1').trim()}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <Button 
                      onClick={handleAddDelegate} 
                      disabled={!newDelegateAddress.trim()} 
                      className="w-full sm:w-auto"
                    >
                      <Plus className="w-4 h-4 mr-2" /> Add Delegate
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {activeTab === "rebalance" && (
            <div className="space-y-6">
              {!hasRebalance && !dtr.onChain && (
                <div className="bg-destructive/10 text-destructive p-4 rounded-lg flex items-center gap-3 border border-destructive/20">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="font-medium">You do not have permission to rebalance this reserve. This view is read-only.</p>
                </div>
              )}

              {!dtr.onChain ? (
                // Simulated/demo Reserve -- unchanged simple weight table, see AR-01's real-Reserve redesign below.
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xl font-merge-display">Portfolio Rebalance</CardTitle>
                    <CardDescription>Adjust target weights. Edits are processed atomically.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="flex items-start space-x-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
                      <Checkbox
                        id="adjust-remaining"
                        checked={adjustRemaining}
                        onCheckedChange={(c) => setAdjustRemaining(c === true)}
                        disabled={!canEditRebalance}
                        className="mt-1"
                      />
                      <div className="grid gap-1.5 leading-none">
                        <label htmlFor="adjust-remaining" className="text-sm font-bold cursor-pointer text-foreground">
                          Adjust Remaining Assets
                        </label>
                        <p className="text-sm text-muted-foreground">
                          When checked, unedited assets are scaled proportionally so the basket remains 100% invested.
                          When unchecked, the difference becomes an Unallocated USDC Reserve.
                        </p>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Asset</TableHead>
                            <TableHead className="text-right">Current Weight</TableHead>
                            <TableHead className="text-right w-40">New Target Weight</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {dtr.composition.map(asset => {
                            const isEdited = rebalanceEdits[asset.symbol] !== undefined;
                            const previewWeight = preview.comp.find(a => a.symbol === asset.symbol)?.weight || 0;
                            const willChange = adjustRemaining && !isEdited && Object.keys(rebalanceEdits).length > 0;
                            return (
                              <TableRow key={asset.symbol} className={isEdited ? "bg-muted/50" : ""}>
                                <TableCell className="font-medium">
                                  {asset.name} <span className="text-muted-foreground text-xs font-merge-mono ml-1">{asset.symbol}</span>
                                </TableCell>
                                <TableCell className="text-right font-merge-mono">{(asset.weight * 100).toFixed(1)}%</TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end">
                                    <Input
                                      type="number"
                                      className={`w-20 h-8 text-right font-merge-mono ${isEdited ? 'border-primary' : ''}`}
                                      placeholder={(asset.weight * 100).toFixed(1)}
                                      value={isEdited ? (rebalanceEdits[asset.symbol] * 100).toString() : ""}
                                      onChange={(e) => handleWeightEdit(asset.symbol, e.target.value)}
                                      disabled={!canEditRebalance}
                                      step="0.1"
                                      min="0"
                                    />
                                    <span className="text-muted-foreground ml-1 text-sm">%</span>
                                  </div>
                                  {willChange && (
                                    <p className="text-[10px] text-muted-foreground mt-1 text-right italic">Auto-scales to {(previewWeight * 100).toFixed(1)}%</p>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    <div className="p-4 border-t border-border mt-4 flex flex-col sm:flex-row justify-between items-center gap-4">
                      <div className="space-y-1 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Asset Weights:</span>
                          <span className={`font-merge-mono font-bold ${previewTotal > 1.0001 ? 'text-destructive' : 'text-primary'}`}>
                            {(preview.comp.reduce((sum, a) => sum + a.weight, 0) * 100).toFixed(1)}%
                          </span>
                        </div>
                        {preview.unallocated > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">Unallocated USDC Reserve:</span>
                            <span className="font-merge-mono font-medium">{(preview.unallocated * 100).toFixed(1)}%</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 pt-1 border-t border-border/50">
                          <span className="text-muted-foreground text-xs">Total (assets + unallocated):</span>
                          <span className="font-merge-mono text-xs font-medium">{(previewTotal * 100).toFixed(1)}%</span>
                        </div>
                      </div>
                      {hasRebalance && (
                        <Button onClick={executeRebalance} disabled={!isPreviewValid} className="w-full sm:w-auto font-bold gap-2">
                          <Save className="w-4 h-4" /> Execute Rebalance
                        </Button>
                      )}
                    </div>
                    {previewTotal > 1.0001 && (
                      <div className="bg-destructive/10 text-destructive p-3 rounded text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        Total weight exceeds 100%. Please adjust.
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : (
                // DEC-0084: slider-based local-preview editor. Search+add on
                // the left and every slider on the right are pure local
                // state -- nothing here ever prompts the wallet. Submit
                // Rebalance below is the ONLY action in this tab that does,
                // applying the whole proposed composition (new-asset
                // registration + every final weight) in one signed
                // transaction (executeSubmitRebalance). Fund and permanently
                // removing an empty asset stay separate, clearly-secondary
                // maintenance actions with their own individual approvals.
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xl font-merge-display">Reserve Composition & Rebalance</CardTitle>
                    <CardDescription>
                      Drag a slider to propose a new target weight -- this only records what you intend the Reserve to look like, it
                      doesn't move any assets yet. Adding, adjusting, or removing an asset below never asks your wallet to approve
                      anything; only Submit Rebalance does, and it applies your complete proposal in a single approval.{" "}
                      {!canUpdateTargetsOnChain && "You need the Root Manager or a delegate with Update Targets permission to submit a rebalance."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                      {/* Left: search + add a new reserve asset -- one click, purely local */}
                      <div className="space-y-4">
                        <h4 className="font-semibold text-sm">Add a Reserve Asset</h4>
                        <div className="relative">
                          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                          <Input
                            placeholder="Search assets to add..."
                            className="pl-9"
                            value={rebalanceAssetSearch}
                            onChange={(e) => setRebalanceAssetSearch(e.target.value)}
                          />
                        </div>
                        <div className="border border-border rounded-lg max-h-[280px] overflow-y-auto p-2 bg-muted/20 space-y-1">
                          {ADDABLE_ASSETS.filter((a) => !proposedAssetRows.some((r) => r.mint === a.mint))
                            .filter((a) => a.symbol.toLowerCase().includes(rebalanceAssetSearch.toLowerCase()))
                            .map((a) => (
                              <div key={a.mint} className="flex items-center justify-between p-2 hover:bg-muted rounded-md transition-colors">
                                <span className="font-semibold font-merge-mono text-sm">{a.symbol}</span>
                                <Button
                                  variant="ghost" size="sm" className="h-8 w-8 p-0"
                                  disabled={!canManageLiquidityConfigOnChain}
                                  title={!canManageLiquidityConfigOnChain ? "You need the Root Manager or a delegate with Manage Liquidity Config permission to register a new asset." : undefined}
                                  onClick={() => handleAddAssetToSession(a)}
                                >
                                  <Plus className="w-4 h-4 text-primary" />
                                </Button>
                              </div>
                            ))}
                          {ADDABLE_ASSETS.filter((a) => !proposedAssetRows.some((r) => r.mint === a.mint)).length === 0 && (
                            <div className="p-4 text-center text-sm text-muted-foreground">Every supported asset is already in your proposed composition.</div>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Adding an asset here is free and only changes your proposal below -- it's registered on-chain, at zero
                          balance, once Submit Rebalance succeeds. Fund it separately afterward.
                        </p>
                      </div>

                      {/* Right: proposed composition -- one slider per asset, yellow marker at its real current on-chain weight */}
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold text-sm">Proposed Composition</h4>
                          <span className={`font-merge-mono text-xs font-bold ${totalProposedBps === 10_000 ? "text-primary" : "text-destructive"}`}>
                            {(totalProposedBps / 100).toFixed(1)}%
                          </span>
                        </div>
                        <div className="space-y-3">
                          {(() => {
                            const lastOnChainMint = [...dtr.onChain.assets].sort((a, b) => b.orderIndex - a.orderIndex)[0]?.mint;
                            return proposedAssetRows.map((row) => {
                              const proposedBps = proposedWeightsBps[row.mint] ?? 0;
                              const proposedPct = proposedBps / 100;
                              const benchmarkPct = row.benchmarkBps / 100;
                              const vaultBalanceRaw = dtr.onChain!.vaultBalancesRaw[row.mint] ?? "0";
                              const isEmpty = vaultBalanceRaw === "0";
                              const balanceHuman = Number(vaultBalanceRaw) / 10 ** row.decimals;
                              const balanceUsd = balanceHuman * (TEST_ASSET_PRICES_USD[row.mint] ?? 0);
                              const projectedUsd = (proposedBps / 10_000) * totalReserveUsd;
                              const isDrivenToZero = proposedBps === 0 && row.benchmarkBps > 0;
                              const canRemoveOnChain = !row.isNew && isEmpty && row.mint === lastOnChainMint;

                              return (
                                <div key={row.mint} className="p-3 border border-border rounded-lg bg-card space-y-2.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <span className="font-semibold font-merge-mono text-sm">{row.symbol}</span>
                                      {row.isNew && <Badge variant="secondary" className="text-[10px]">New</Badge>}
                                      {isDrivenToZero && <Badge variant="outline" className="text-[10px] text-destructive border-destructive/40">Reducing to 0%</Badge>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-muted-foreground font-merge-mono">
                                        {formatUsdc(balanceUsd, { compact: true })} bal.
                                      </span>
                                      {row.isNew && (
                                        <Button
                                          variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                          onClick={() => handleRemoveSessionAsset(row.mint)}
                                          title="Remove from proposed composition"
                                        >
                                          <X className="w-3.5 h-3.5" />
                                        </Button>
                                      )}
                                    </div>
                                  </div>

                                  <div className="relative pt-2 pb-1">
                                    <Slider
                                      value={[proposedPct]}
                                      max={100}
                                      step={0.1}
                                      onValueChange={([v]) => handleSliderChange(row.mint, Math.round(v * 100))}
                                      disabled={!canUpdateTargetsOnChain}
                                    />
                                    {/* Yellow benchmark marker: this asset's real current on-chain target weight (0 for a not-yet-registered asset) so current vs. proposed is visible at a glance. */}
                                    <div
                                      className="pointer-events-none absolute top-0 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-amber-500 dark:bg-amber-400"
                                      style={{ left: `${Math.min(100, Math.max(0, benchmarkPct))}%` }}
                                      title={`Current on-chain target: ${benchmarkPct.toFixed(1)}%`}
                                    />
                                  </div>

                                  <div className="flex items-center justify-between gap-3">
                                    <span className="text-xs text-muted-foreground">
                                      Current <span className="font-merge-mono font-medium text-foreground">{benchmarkPct.toFixed(1)}%</span>,
                                      <span className="mx-1">&rarr;</span>
                                      <span className="font-merge-mono font-medium text-foreground">{proposedPct.toFixed(1)}%</span> proposed
                                      {" ("}<span className="font-merge-mono font-medium text-foreground">{formatUsdc(projectedUsd, { compact: true })}</span> balance projected)
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                      <Input
                                        type="number"
                                        className="w-20 h-7 text-right font-merge-mono text-xs"
                                        value={+proposedPct.toFixed(1)}
                                        onChange={(e) => handleSliderChange(row.mint, Math.round((parseFloat(e.target.value) || 0) * 100))}
                                        disabled={!canUpdateTargetsOnChain}
                                        step="0.1"
                                        min="0"
                                        max="100"
                                      />
                                      <span className="text-muted-foreground text-xs">%</span>
                                    </div>
                                  </div>

                                  {!row.isNew && (isEmpty || canRemoveOnChain) && (
                                    <div className="flex items-center gap-2 pt-1.5 border-t border-border/50">
                                      {isEmpty && (
                                        <>
                                          <Input
                                            type="number" min="0" placeholder="amount to fund"
                                            className="h-8 text-xs font-merge-mono flex-1"
                                            value={fundAmounts[row.mint] ?? ""}
                                            onChange={(e) => setFundAmounts((prev) => ({ ...prev, [row.mint]: e.target.value }))}
                                            disabled={!isRoot || onChainTxPending !== null}
                                          />
                                          <Button
                                            variant="outline" size="sm"
                                            disabled={!isRoot || onChainTxPending !== null || !fundAmounts[row.mint] || Number(fundAmounts[row.mint]) <= 0}
                                            onClick={() => {
                                              const amount = BigInt(fundAmounts[row.mint]);
                                              void runOnChainAction(`Fund ${row.symbol}`, () => executeFundReserveAsset(connection, walletCtx, dtr.onChain!.reserve, row.mint, amount));
                                            }}
                                            className="gap-1 shrink-0"
                                          >
                                            <Coins className="w-3.5 h-3.5" /> Fund
                                          </Button>
                                        </>
                                      )}
                                      {canRemoveOnChain && (
                                        <Button
                                          variant="destructive" size="sm"
                                          disabled={!canManageLiquidityConfigOnChain || onChainTxPending !== null}
                                          title={!canManageLiquidityConfigOnChain ? "You need the Root Manager or a delegate with Manage Liquidity Config permission." : undefined}
                                          onClick={() => void runOnChainAction(`Remove ${row.symbol}`, () => executeRemoveReserveAsset(connection, walletCtx, dtr.onChain!.reserve, dtr.onChain!.manager, row.mint))}
                                          className="gap-1 shrink-0"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" /> Remove
                                        </Button>
                                      )}
                                      <p className="text-[10px] text-muted-foreground ml-auto shrink-0">Separate action -- approves on its own.</p>
                                    </div>
                                  )}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    </div>

                    <div className="p-4 border-t border-border mt-2 flex flex-col sm:flex-row justify-between items-center gap-4">
                      <div className="space-y-1 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Proposed Total:</span>
                          <span className={`font-merge-mono font-bold ${totalProposedBps === 10_000 ? "text-primary" : "text-destructive"}`}>
                            {(totalProposedBps / 100).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <Button
                        onClick={() =>
                          void runOnChainAction(
                            "Submit Rebalance",
                            () => executeSubmitRebalance(connection, walletCtx, dtr.onChain!.reserve, rebalanceAssetPlan),
                            rebalanceAssetPlan.filter((a) => a.isNew).map((a) => a.mint),
                          )
                        }
                        disabled={totalProposedBps !== 10_000 || !canSubmitRebalance || !hasRebalanceChanges || onChainTxPending !== null}
                        title={
                          !canUpdateTargetsOnChain
                            ? "You need the Root Manager or a delegate with Update Targets permission to submit a rebalance."
                            : !canSubmitRebalance
                              ? "You need the Root Manager or a delegate with Manage Liquidity Config permission to register a new asset."
                              : undefined
                        }
                        className="w-full sm:w-auto font-bold gap-2"
                      >
                        <Save className="w-4 h-4" /> {onChainTxPending === "Submit Rebalance" ? "Confirming..." : "Submit Rebalance"}
                      </Button>
                    </div>
                    {totalProposedBps !== 10_000 && (
                      <div className="bg-destructive/10 text-destructive p-3 rounded text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        Proposed weights must total exactly 100% before submitting.
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {activeTab === "activity" && dtr.onChain && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display flex items-center gap-2">
                    <History className="w-5 h-5" /> Activity Log
                  </CardTitle>
                  <CardDescription>
                    Every action ever taken on this Reserve -- creation and initial funding, mints and redemptions, instant
                    Protocol fee transfers, weekly TVL fee settlements, Manager fee accrual and claims, fee-routing changes,
                    delegate grants, target-weight changes, composition edits, pause/unpause, wind-down and closure -- decoded
                    from its real on-chain transaction history and kept here so it loads instantly and reliably, without
                    depending on a live network call every time you open this tab.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {activityStatus === "loading" && (
                    <div className="text-center p-6 text-muted-foreground text-sm">Loading activity...</div>
                  )}
                  {activityStatus === "error" && (
                    <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>Couldn't load the activity log right now -- switch tabs and back to retry.</p>
                    </div>
                  )}
                  {activityStatus === "ready" && activitySyncError && (
                    <div className="flex items-start gap-2 p-3 mb-3 bg-muted/40 text-muted-foreground rounded-lg text-xs">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <p>Showing saved history -- couldn't check for the very latest activity just now. Try again shortly.</p>
                    </div>
                  )}
                  {activityStatus === "ready" && activityLog && activityLog.length === 0 && (
                    <div className="text-center p-6 border border-dashed border-border rounded-lg text-muted-foreground text-sm">
                      No governance actions recorded yet for this Reserve.
                    </div>
                  )}
                  {activityStatus === "ready" && activityLog && activityLog.length > 0 && (
                    <div className="space-y-2">
                      {activityLog.map((entry) => (
                        <div key={`${entry.signature}-${entry.kind}`} className="flex items-start justify-between gap-3 p-3 rounded-lg border border-border/50 bg-muted/20">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{entry.summary}</p>
                            <p className="text-xs text-muted-foreground font-merge-mono mt-0.5">
                              {entry.ts > 0 ? new Date(entry.ts * 1000).toLocaleString() : "unknown time"}
                              {entry.actor && <> &middot; {shortenAddress(entry.actor)}</>}
                              {" "}&middot; <span className="text-emerald-600 dark:text-emerald-500">Confirmed</span>
                              {" "}&middot; <span className="font-merge-mono">{entry.signature.slice(0, 8)}...{entry.signature.slice(-4)}</span>
                            </p>
                          </div>
                          <a
                            href={explorerUrl("tx", entry.signature)}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-primary"
                            title="View transaction on Solana Explorer"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                  {activityStatus === "ready" && !activityBackfillComplete && (
                    <p className="text-xs text-muted-foreground mt-3 text-center">
                      Still loading this Reserve's older history -- check back shortly for earlier entries.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}