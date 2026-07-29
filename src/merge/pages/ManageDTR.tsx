import { useState } from "react";
import { useParams, Link } from "wouter";
import { useAppStore, isManagerOrDelegate, canManageDelegates, canRebalance } from "@/store/useAppStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { formatPct, formatUsdc } from "@/lib/calculations";
import { type ManagerPermissions, emptyPermissions } from "@/lib/types";
import { ChevronLeft, Shield, Users, Sliders, Save, Plus, Trash2, Edit2, AlertCircle, Tag } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { displayDelegateName, getDelegateLabel, setDelegateLabel, shortenAddress } from "@/lib/delegateLabels";
import { decodeOnChainPermissions } from "@/lib/onChainPermissions";

/** Read-only, verified-on-chain delegate row -- reused by both the Overview summary and the Delegates tab for a real (onChain) Reserve. Local labels are display-only and never imply on-chain storage; see delegateLabels.ts. */
function OnChainDelegateRow({ reserveAddress, wallet, delegateAccount, permissions, restricted, canEditLabel }: {
  reserveAddress: string;
  wallet: string;
  delegateAccount: string;
  permissions: number;
  restricted: boolean;
  canEditLabel: boolean;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(getDelegateLabel(reserveAddress, wallet) ?? "");
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
        {canEditLabel && (
          <Button variant="outline" size="sm" onClick={() => { setLabelDraft(label ?? ""); setEditingLabel((v) => !v); }} className="shrink-0 gap-1.5">
            <Tag className="w-3.5 h-3.5" /> {label ? "Edit label" : "Set local label"}
          </Button>
        )}
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
      <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/30">
        Delegate account: <span className="font-merge-mono break-all">{delegateAccount}</span>. Wallet address, capabilities, scope, and
        status above are read live from Solana DevNet; the name is a local label stored only in this browser, never on-chain.
      </p>
    </div>
  );
}

export function ManageDTR() {
  const { dtrId } = useParams();
  const { wallet, dtrs, addDelegate, updateDelegatePermissions, removeDelegate, rebalanceDTR } = useAppStore();
  const dtr = dtrs.find((d) => d.id === (dtrId || ""));
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<"overview" | "delegates" | "rebalance">("overview");

  // Delegate State
  const [newDelegateAddress, setNewDelegateAddress] = useState("");
  const [newDelegatePerms, setNewDelegatePerms] = useState<ManagerPermissions>(emptyPermissions());
  const [editingDelegate, setEditingDelegate] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<ManagerPermissions>(emptyPermissions());

  // Rebalance State
  const [rebalanceEdits, setRebalanceEdits] = useState<Record<string, number>>({});
  const [adjustRemaining, setAdjustRemaining] = useState(true);

  if (!dtr) {
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
            {!hasManageDelegates && <span className="ml-auto text-[10px] uppercase tracking-wider opacity-60">Locked</span>}
          </button>
          
          <button
            onClick={() => setActiveTab("rebalance")}
            className={`w-full text-left px-4 py-3 rounded-lg font-medium transition-colors flex items-center gap-3 ${activeTab === "rebalance" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            <Sliders className="w-4 h-4" /> Rebalance
            {!hasRebalance && <span className="ml-auto text-[10px] uppercase tracking-wider opacity-60">Locked</span>}
          </button>
        </div>

        <div className="md:col-span-3">
          {activeTab === "overview" && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Reserve Identity</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
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
                      <p className="font-merge-mono font-bold text-lg">{formatUsdc(dtr.aum, { compact: true })}</p>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">NAV per Token</p>
                      <p className="font-merge-mono font-bold text-lg">{formatUsdc(dtr.nav)}</p>
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
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Mint Fee</p>
                      <p className="font-merge-mono font-medium">{formatPct(dtr.feeConfig.mintFeePct)}</p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground mb-1">Annualized TVL Fee</p>
                      <p className="font-merge-mono font-medium">{formatPct(dtr.feeConfig.tvlFeePct)}</p>
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
                  <div className="pt-4 border-t border-border/50">
                    <p className="text-sm font-semibold text-muted-foreground mb-1">Primary Fee Destination</p>
                    <p className="font-merge-mono text-sm break-all">{dtr.feeConfig.creatorFeeDestination}</p>
                  </div>
                  {dtr.feeConfig.feeRecipients.length > 0 && (
                    <div className="pt-4 border-t border-border/50">
                      <p className="text-sm font-semibold text-muted-foreground mb-2">Additional Fee Recipients</p>
                      <div className="space-y-2">
                        {dtr.feeConfig.feeRecipients.map((r) => (
                          <div key={r.address} className="flex justify-between items-center p-2 rounded bg-muted/30 border border-border/50 text-sm">
                            <span className="font-merge-mono text-xs break-all">{r.address}</span>
                            <span className="font-merge-mono font-bold shrink-0 ml-3">{r.pct}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "delegates" && dtr.onChain && (
            <div className="space-y-6">
              <div className="bg-muted/30 border border-border/50 p-4 rounded-lg flex items-center gap-3">
                <Shield className="w-5 h-5 shrink-0 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Delegate management for live Solana DevNet Reserves (add, remove, or change capabilities) requires a signed on-chain
                  transaction, which is not yet implemented -- see the DevNet implementation plan's Phase F. The list below is read-only
                  and verified live on-chain; you can still set a local display label for each delegate.
                </p>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl font-merge-display">Active Delegates</CardTitle>
                  <CardDescription>
                    Verified on Solana DevNet
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
                      {(dtr.onChain.delegatesOnChain ?? []).map((del) => (
                        <OnChainDelegateRow
                          key={del.wallet}
                          reserveAddress={dtr.onChain!.reserve}
                          wallet={del.wallet}
                          delegateAccount={del.delegateAccount}
                          permissions={del.permissions}
                          restricted={del.restricted}
                          canEditLabel={hasManageDelegates}
                        />
                      ))}
                    </div>
                  )}
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
              {!hasRebalance && (
                <div className="bg-destructive/10 text-destructive p-4 rounded-lg flex items-center gap-3 border border-destructive/20">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="font-medium">You do not have permission to rebalance this reserve. This view is read-only.</p>
                </div>
              )}

              {dtr.onChain && (
                <div className="bg-muted/30 border border-border/50 p-4 rounded-lg flex items-center gap-3">
                  <Sliders className="w-5 h-5 shrink-0 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Composition management and rebalance execution for live Solana DevNet Reserves require new signed on-chain
                    instructions that don't exist yet -- see the DevNet implementation plan's items 4/5 and Phase F. You can still
                    preview target-weight changes below, but <strong>submitting is disabled</strong> until that on-chain support ships;
                    this preview never changes on-chain state.
                  </p>
                </div>
              )}

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
                      disabled={!hasRebalance}
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
                              <TableCell className="text-right font-merge-mono">
                                {(asset.weight * 100).toFixed(1)}%
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end">
                                  <Input 
                                    type="number"
                                    className={`w-20 h-8 text-right font-merge-mono ${isEdited ? 'border-primary' : ''}`}
                                    placeholder={(asset.weight * 100).toFixed(1)}
                                    value={isEdited ? (rebalanceEdits[asset.symbol] * 100).toString() : ""}
                                    onChange={(e) => handleWeightEdit(asset.symbol, e.target.value)}
                                    disabled={!hasRebalance}
                                    step="0.1"
                                    min="0"
                                  />
                                  <span className="text-muted-foreground ml-1 text-sm">%</span>
                                </div>
                                {willChange && (
                                  <p className="text-[10px] text-muted-foreground mt-1 text-right italic">
                                    Auto-scales to {(previewWeight * 100).toFixed(1)}%
                                  </p>
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
                      <Button
                        onClick={executeRebalance}
                        disabled={!isPreviewValid || !!dtr.onChain}
                        title={dtr.onChain ? "Not yet available for live Solana DevNet Reserves -- see the DevNet implementation plan's Phase F." : undefined}
                        className="w-full sm:w-auto font-bold gap-2"
                      >
                        <Save className="w-4 h-4" /> {dtr.onChain ? "Execute Rebalance (coming soon)" : "Execute Rebalance"}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}