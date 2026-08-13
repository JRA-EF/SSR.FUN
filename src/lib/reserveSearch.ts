// Pure, framework-free matching/ranking logic for the global Reserve search
// bar (src/components/ReserveSearch.tsx). Kept decoupled from the full DTR
// shape (src/merge/lib/types.ts) so it stays trivially offline-testable --
// callers adapt whatever authoritative Reserve list they have (useAppStore's
// `dtrs`) into SearchableReserve.

export interface SearchableReserve {
  id: string;
  name: string;
  ticker: string;
  /** The Reserve account address (dtr.dtrAddress). */
  dtrAddress?: string;
  /** The Reserve Token's SPL mint address (dtr.onChain?.reserveTokenMint) -- the literal "contract address" for the Reserve Token. */
  reserveTokenMint?: string;
  /** Used only to break ties between equally-ranked matches, and to order the empty-query "Popular Reserves" list. */
  aum?: number;
}

export interface ReserveSearchResult {
  reserve: SearchableReserve;
  /** 0 = exact match, 1 = prefix match, 2 = partial (substring) match -- the best of any matched field. */
  score: 0 | 1 | 2;
  nameMatched: boolean;
  tickerMatched: boolean;
  /** True when the query matched dtrAddress and/or reserveTokenMint. */
  addressMatched: boolean;
}

/** Shortens a base58 address for display: "F3n1…9kXa". */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

function fieldScore(field: string | undefined, query: string): 0 | 1 | 2 | null {
  if (!field) return null;
  const f = field.toLowerCase();
  if (f === query) return 0;
  if (f.startsWith(query)) return 1;
  if (f.includes(query)) return 2;
  return null;
}

function betterScore(a: 0 | 1 | 2 | null, b: 0 | 1 | 2 | null): 0 | 1 | 2 | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function isValid(reserve: SearchableReserve | null | undefined): reserve is SearchableReserve {
  return !!reserve && !!reserve.id && !!reserve.name && !!reserve.ticker;
}

/** Dedupes by id (defensive -- the authoritative dtrs list is already deduped by the store, but callers shouldn't have to rely on that). */
function dedupeById(reserves: SearchableReserve[]): SearchableReserve[] {
  const seen = new Set<string>();
  const out: SearchableReserve[] = [];
  for (const r of reserves) {
    if (!isValid(r) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * Live, case-insensitive Reserve search by name, ticker, or Reserve Token
 * contract address (full or partial), ranked exact > prefix > partial.
 * Returns [] for an empty/whitespace-only query -- callers should show
 * either nothing or getPopularReserves() in that state, never the full list.
 */
export function searchReserves(reserves: SearchableReserve[], rawQuery: string, limit = 8): ReserveSearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const results: ReserveSearchResult[] = [];
  for (const reserve of dedupeById(reserves)) {
    const nameScore = fieldScore(reserve.name, query);
    const tickerScore = fieldScore(reserve.ticker, query);
    const addressScore = betterScore(fieldScore(reserve.dtrAddress, query), fieldScore(reserve.reserveTokenMint, query));
    const best = betterScore(betterScore(nameScore, tickerScore), addressScore);
    if (best === null) continue;
    results.push({
      reserve,
      score: best,
      nameMatched: nameScore !== null,
      tickerMatched: tickerScore !== null,
      addressMatched: addressScore !== null,
    });
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const aumDiff = (b.reserve.aum ?? 0) - (a.reserve.aum ?? 0);
    if (aumDiff !== 0) return aumDiff;
    return a.reserve.name.localeCompare(b.reserve.name);
  });

  return results.slice(0, limit);
}

/** Reserves to show for an empty query -- highest-AUM first, never the raw/unranked full list. */
export function getPopularReserves(reserves: SearchableReserve[], limit = 5): SearchableReserve[] {
  return dedupeById(reserves)
    .sort((a, b) => (b.aum ?? 0) - (a.aum ?? 0))
    .slice(0, limit);
}

export interface HighlightSplit {
  before: string;
  match: string;
  after: string;
}

/** Splits `text` around the first case-insensitive occurrence of `query`, for highlighting. Null if the query doesn't occur in this particular field. */
export function splitForHighlight(text: string, rawQuery: string): HighlightSplit | null {
  const query = rawQuery.trim();
  if (!query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  return { before: text.slice(0, idx), match: text.slice(idx, idx + query.length), after: text.slice(idx + query.length) };
}

/**
 * Computes the next highlighted suggestion index for ArrowDown
 * (direction=1) / ArrowUp (direction=-1), wrapping around both ends.
 * `current=-1` means "nothing highlighted yet" -- ArrowDown from there
 * lands on the first item, ArrowUp lands on the last one (both away from
 * the edge itemCount would otherwise wrap into), which is what
 * ReserveSearch's onKeyDown uses so it's independently testable here.
 */
export function nextActiveIndex(current: number, itemCount: number, direction: 1 | -1): number {
  if (itemCount <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : itemCount - 1;
  return (current + direction + itemCount) % itemCount;
}

/** What Enter should select: the highlighted item if one is in range, otherwise the top-ranked (first) item. Null when there's nothing to select. */
export function resolveEnterSelection<T>(items: T[], activeIndex: number): T | null {
  if (items.length === 0) return null;
  if (activeIndex >= 0 && activeIndex < items.length) return items[activeIndex];
  return items[0];
}

/** The Reserve detail page path for a given Reserve id, matching App.tsx's "/dtr/:dtrId" route. */
export function reservePath(id: string): string {
  return `/dtr/${id}`;
}
