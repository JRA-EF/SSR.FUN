// Ported from SSR.FUN-MERGE's Home.tsx "All Reserves" (#directory) section --
// MERGE has no standalone Discover route of its own (that grid lives inline on
// its homepage), so this file gives it one, backed by useAppStore. The card
// grid itself renders FABLE's standard ReserveCard (see ../../components/ReserveCard)
// so Discover and the native homepage's Featured Reserves share one card design.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Activity, SearchX } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { RESERVE_CATEGORIES, normalizeReserveCategory, type DTR } from "@/lib/types";
import { isDesignDemoEnabled } from "@/lib/designDemo";
import { buildReserveCardProps } from "@/lib/reserveCardProps";
import { useLandingStats } from "@/hooks/useLandingStats";
import { IS_MAINNET } from "@/lib/solana-config";
import { Input } from "@/components/ui/input";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { ReserveCard } from "../../components/ReserveCard";
import { avatarStyle } from "../../lib/avatarStyle";

type SortKey = "aumDesc" | "changeDesc" | "changeAsc" | "priceDesc" | "priceAsc" | "nameAsc";

const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "DevNet";

// AUM (market cap) descending is the default order -- the same ranking the
// Home page's Featured Reserves use (selectFeaturedReserves = the top 3 here,
// minus any Reserve that is winding down).
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "aumDesc", label: "AUM: High to Low" },
  { value: "changeDesc", label: "24h Change: High to Low" },
  { value: "changeAsc", label: "24h Change: Low to High" },
  { value: "priceDesc", label: "Price: High to Low" },
  { value: "priceAsc", label: "Price: Low to High" },
  { value: "nameAsc", label: "Name: A to Z" },
];

function sortDtrs(list: DTR[], sortBy: SortKey): DTR[] {
  const sorted = [...list];
  switch (sortBy) {
    case "changeDesc":
      return sorted.sort((a, b) => b.change24h - a.change24h);
    case "changeAsc":
      return sorted.sort((a, b) => a.change24h - b.change24h);
    case "priceDesc":
      return sorted.sort((a, b) => b.tokenPrice - a.tokenPrice);
    case "priceAsc":
      return sorted.sort((a, b) => a.tokenPrice - b.tokenPrice);
    case "nameAsc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "aumDesc":
    default:
      return sorted.sort((a, b) => b.aum - a.aum);
  }
}

const selectClass =
  "h-9 rounded-full bg-secondary/50 border border-transparent px-4 text-sm focus-visible:outline-none focus-visible:bg-background focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30 transition-all duration-200";

export function Discover() {
  const dtrs = useAppStore((s) => s.dtrs);
  const chainDiscoveryStatus = useAppStore((s) => s.chainDiscoveryStatus);
  const chainDiscoveryError = useAppStore((s) => s.chainDiscoveryError);
  const [searchFilter, setSearchFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  // Per-Reserve all-time volume for the cards' stats row -- the same fetch/
  // cache the Home page and DTRDetail read (see hooks/useLandingStats.ts).
  const landingStats = useLandingStats();
  const [sortBy, setSortBy] = useState<SortKey>("aumDesc");

  // Filter options: the full canonical list (so every structured category is
  // always choosable, even with zero matching Reserves yet) plus any
  // legacy/non-canonical category actually present in the data (e.g. "DevNet
  // Fixture") so nothing already on-chain becomes unfilterable.
  const categories = useMemo(() => {
    const present = dtrs.map((d) => normalizeReserveCategory(d.category));
    return Array.from(new Set([...RESERVE_CATEGORIES, ...present])).sort((a, b) => a.localeCompare(b));
  }, [dtrs]);

  const filteredDtrs = dtrs.filter((dtr) => {
    const cat = normalizeReserveCategory(dtr.category);
    return (
      (categoryFilter === "all" || cat === categoryFilter) &&
      (dtr.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
        dtr.ticker.toLowerCase().includes(searchFilter.toLowerCase()) ||
        cat.toLowerCase().includes(searchFilter.toLowerCase()))
    );
  });

  const visibleDtrs = sortDtrs(filteredDtrs, sortBy);

  const isFiltered = searchFilter.trim() !== "" || categoryFilter !== "all";

  return (
    <div className="container mx-auto px-4 md:px-8 py-10 space-y-8 relative">
      {/* Full-bleed hero art behind the page top (public/discover-hero.jpg) —
          the shared mascot-hero treatment: left scrim for the title, bottom
          fade into the ground, hides itself if the file is absent. */}
      <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[220px] sm:h-[340px] overflow-hidden pointer-events-none -z-10">
        <img
          src="/discover-hero.jpg"
          alt=""
          className="w-full h-full object-cover"
          style={{ objectPosition: "center 20%" }}
          onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
        />
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, hsl(var(--background) / 0.78) 0%, hsl(var(--background) / 0.25) 45%, hsl(var(--background) / 0.05) 100%)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0.05) 0%, hsl(var(--background) / 0.25) 55%, hsl(var(--background)) 98%)" }} />
      </div>

      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-4 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-merge-display font-bold">Discover Reserves</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-64">
            <Input
              placeholder="Search reserves..."
              className="bg-secondary/50 border-transparent rounded-full pl-4 focus-visible:bg-background"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
            />
          </div>
          <select
            className={selectClass}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            className={selectClass}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            aria-label="Sort reserves"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Design preview hides transient RPC-health banners -- demo videos and
          screenshots should show the design, not environment noise. */}
      {chainDiscoveryStatus === "error" && !isDesignDemoEnabled() && (
        <div className="rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>
          Could not refresh live Solana {CLUSTER_LABEL} Reserves ({chainDiscoveryError ?? "unknown error"}). Showing the last known state --
          on-chain figures below may be stale until the connection recovers.
        </div>
      )}
      {chainDiscoveryStatus === "loading" && !dtrs.some((d) => d.onChain) && (
        <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Checking Solana {CLUSTER_LABEL} for live Reserves…
        </div>
      )}

      <div className="fcards">
        {visibleDtrs.map((dtr) => {
          const cardProps = buildReserveCardProps(dtr, IS_MAINNET, {
            status: landingStats.status,
            volumeAllTimeUsd: dtr.onChain ? landingStats.data?.perReserve[dtr.onChain.reserve]?.volumeAllTimeUsd : undefined,
          });
          return (
            <ReserveCard
              key={dtr.id}
              {...cardProps}
              avatarStyle={avatarStyle(dtr.ticker)}
              renderCta={({ className, children }) => (
                <Link href={`/dtr/${dtr.id}`} className={className}>{children}</Link>
              )}
            />
          );
        })}

        {visibleDtrs.length === 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Empty className="border border-dashed border-border rounded-2xl bg-secondary/20 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX />
                </EmptyMedia>
                <EmptyTitle>No reserves match your filter</EmptyTitle>
                <EmptyDescription>
                  {isFiltered ? "Try a different search term or category." : "No reserves are available yet."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
