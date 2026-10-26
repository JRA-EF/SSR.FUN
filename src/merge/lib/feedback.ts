// In-app user feedback: the "How did we do?" prompt that follows a core
// action, the corner Feedback button, and the #/feedback page. Submissions go
// to api/feedback/experience.ts, which writes them to the team's Google Sheet.
//
// Off unless VITE_ENABLE_FEEDBACK=true at BUILD time (set on the production
// project only, so the Sheet receives feedback from ssr.fun and never from
// staging). Off means no corner button, no prompt and no #/feedback route.
export const FEEDBACK_ENABLED = (import.meta.env.VITE_ENABLE_FEEDBACK as string | undefined) === "true";

export type FeedbackAction = "mint" | "redeem" | "rebalance" | "create-reserve" | "liquidity";
export type FeedbackTrigger = "button" | "prompt";

export const FEEDBACK_SUBJECT_MAX = 150;
export const FEEDBACK_DETAILS_MAX = 1000;
const SNAPSHOT_MAX_INPUT_BYTES = 15 * 1024 * 1024;
const SNAPSHOT_MAX_SIDE = 1600;

export const FEEDBACK_ACTION_LABELS: Record<FeedbackAction, string> = {
  mint: "Your mint went through.",
  redeem: "Your redemption went through.",
  rebalance: "Your rebalance went through.",
  "create-reserve": "Your Reserve is live.",
  liquidity: "Your liquidity action went through.",
};

const PROMPT_EVENT = "ssr:feedback-prompt";
const PROMPTED_AT_KEY = "ssr.feedback.promptedAt";
const LAUNCHER_HIDDEN_UNTIL_KEY = "ssr.feedback.launcherHiddenUntil";
const PROMPT_COOLDOWN_MS = 24 * 60 * 60_000;
const LAUNCHER_HIDE_MS = 7 * 24 * 60 * 60_000;

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}
function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private windows can refuse storage; the prompt then just shows again later.
  }
}

/** Ask the user how a confirmed core action went. At most one prompt per day. */
export function requestActionFeedback(action: FeedbackAction): void {
  if (!FEEDBACK_ENABLED) return;
  if (Date.now() - readNumber(PROMPTED_AT_KEY) < PROMPT_COOLDOWN_MS) return;
  window.dispatchEvent(new CustomEvent<FeedbackAction>(PROMPT_EVENT, { detail: action }));
}

export function onActionFeedbackRequest(handler: (action: FeedbackAction) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<FeedbackAction>).detail);
  window.addEventListener(PROMPT_EVENT, listener);
  return () => window.removeEventListener(PROMPT_EVENT, listener);
}

export function markPrompted(): void {
  writeNumber(PROMPTED_AT_KEY, Date.now());
}

export function isLauncherHidden(): boolean {
  return readNumber(LAUNCHER_HIDDEN_UNTIL_KEY) > Date.now();
}
export function hideLauncher(): void {
  writeNumber(LAUNCHER_HIDDEN_UNTIL_KEY, Date.now() + LAUNCHER_HIDE_MS);
}

export function feedbackHref(params: { rating?: number; action?: FeedbackAction; trigger: FeedbackTrigger; from: string }): string {
  const q = new URLSearchParams();
  if (params.rating) q.set("rating", String(params.rating));
  if (params.action) q.set("action", params.action);
  q.set("trigger", params.trigger);
  q.set("from", params.from);
  return `/feedback?${q.toString()}`;
}

export interface Snapshot {
  mimeType: "image/jpeg";
  data: string; // base64, no data: prefix
  previewUrl: string;
}

/** Downscale a picked image to at most 1600px a side and re-encode it as JPEG. */
export async function prepareSnapshot(file: File): Promise<Snapshot> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPEG or WebP).");
  if (file.size > SNAPSHOT_MAX_INPUT_BYTES) throw new Error("That image is over 15 MB. Choose a smaller one.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("That image could not be opened."));
      el.src = url;
    });
    const scale = Math.min(1, SNAPSHOT_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("That image could not be opened.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), previewUrl: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function submitFeedback(body: {
  rating: number;
  subject: string;
  details: string;
  trigger: FeedbackTrigger;
  action: FeedbackAction | null;
  pageUrl: string;
  wallet: string | null;
  snapshot: Snapshot | null;
}): Promise<void> {
  const r = await fetch("/api/feedback/experience", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      rating: body.rating,
      subject: body.subject,
      details: body.details,
      trigger: body.trigger,
      action: body.action,
      pageUrl: body.pageUrl,
      wallet: body.wallet,
      screenshot: body.snapshot ? { mimeType: body.snapshot.mimeType, data: body.snapshot.data } : null,
    }),
  });
  if (r.ok) return;
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  throw new Error(j?.error || "We could not send your feedback. Please try again.");
}
