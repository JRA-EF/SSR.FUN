// DEC-0249: Create Reserve keeps the creator's work. Everything typed into
// the four steps is saved per wallet as it changes, so a launch that stops on
// a bad asset, a reload, or a closed tab never means starting over. Cleared
// when the Reserve launches. Pictures are not saved (too large for
// localStorage); everything else is.
//
// The launch session rides along: when the first launch attempt started (the
// 20-minute price lock, LAUNCH_PRICE_LOCK_MS) and the per-asset funding
// record, so a relaunch after removing an asset reuses the swaps that already
// landed instead of swapping for them again.
import type { FeeRecipient, CreateDTRAssetInput } from "@/lib/types";
import type { PersistedAssetFunding } from "@/lib/launchFunding";
import type { RemovedLaunchAsset } from "@/lib/launchPreflight";

const DRAFT_KEY = "ssr_create_draft_v1";

export interface LaunchSession {
  startedAt: number;
  funding: Record<string, PersistedAssetFunding>;
}

export interface CreateDraft {
  wallet: string;
  savedAt: number;
  step: number;
  name: string;
  ticker: string;
  description: string;
  category: string;
  youtubeChannel: string;
  youtubeFeatured: string;
  /** Optional; absent in drafts saved before the X / Telegram fields existed. */
  xLink?: string;
  telegramLink?: string;
  assets: CreateDTRAssetInput[];
  removedAssets: RemovedLaunchAsset[];
  initialSeedUsdc: string;
  mintFeePct: number;
  tvlFeePct: number;
  feeDestination: string;
  feeRecipients: FeeRecipient[];
  additionalManagers: string[];
  launchSession: LaunchSession | null;
}

/** Pure: a draft worth restoring -- something was actually entered. */
export function isMeaningfulDraft(d: Pick<CreateDraft, "name" | "ticker" | "description" | "assets">): boolean {
  return d.name.trim() !== "" || d.ticker.trim() !== "" || d.description.trim() !== "" || d.assets.length > 0;
}

export function saveCreateDraft(draft: CreateDraft): void {
  try {
    if (!isMeaningfulDraft(draft)) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort, like every other localStorage write in the Create flow.
  }
}

export function readCreateDraft(wallet: string): CreateDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as CreateDraft;
    if (d.wallet !== wallet || !Array.isArray(d.assets)) return null;
    return d;
  } catch {
    return null;
  }
}

export function clearCreateDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Best-effort.
  }
}
