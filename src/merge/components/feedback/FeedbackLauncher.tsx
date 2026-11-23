// The corner Feedback button (dismissable for a week) and the "How did we do?"
// card that appears in a corner (non-blocking) after a confirmed core action. Picking a star
// in the prompt opens the #/feedback page with that rating filled in.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquareHeart, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { navigate, usePath } from "../../../lib/router";
import { StarRating } from "./StarRating";
import {
  FEEDBACK_ACTION_LABELS,
  feedbackHref,
  hideLauncher,
  isLauncherHidden,
  FEEDBACK_ENABLED,
  markPrompted,
  onActionFeedbackRequest,
  type FeedbackAction,
} from "@/lib/feedback";

const PROMPT_DELAY_MS = 1500;

export function FeedbackLauncher() {
  return FEEDBACK_ENABLED ? <FeedbackLauncherInner /> : null;
}

function FeedbackLauncherInner() {
  const path = usePath();
  const onFeedbackPage = path.split("?")[0] === "/feedback";
  const [launcherHidden, setLauncherHidden] = useState(isLauncherHidden);
  const [promptAction, setPromptAction] = useState<FeedbackAction | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const off = onActionFeedbackRequest((action) => {
      window.clearTimeout(timer);
      // Let the confirmation toast land first.
      timer = window.setTimeout(() => {
        markPrompted();
        setPromptAction(action);
      }, PROMPT_DELAY_MS);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!promptAction) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPromptAction(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promptAction]);

  const from = onFeedbackPage ? "/" : path;

  return createPortal(
    <>
      {!launcherHidden && !onFeedbackPage && (
        // .merge-scope brings the color tokens but also (unlayered) a relative
        // position and opaque background; the inline style undoes both.
        <div className="merge-scope fixed right-4 bottom-20 lg:bottom-6 z-40" style={{ position: "fixed", background: "none" }}>
          <div className="group relative">
            <button
              type="button"
              onClick={() => navigate(feedbackHref({ trigger: "button", from }))}
              className="flex items-center gap-2 h-10 pl-3.5 pr-4 rounded-full border border-card-border bg-card text-card-foreground text-sm font-medium shadow-lg hover:border-primary/40 hover:shadow-glow transition-all"
            >
              <MessageSquareHeart className="w-4 h-4 text-action" />
              Feedback
            </button>
            <button
              type="button"
              aria-label="Hide the Feedback button for a week"
              title="Hide for a week"
              onClick={() => {
                hideLauncher();
                setLauncherHidden(true);
              }}
              className="absolute -top-2 -right-2 flex items-center justify-center w-5 h-5 rounded-full border border-border bg-background text-muted-foreground hover:text-foreground shadow-sm"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {promptAction && !onFeedbackPage && (
        // Non-blocking (beta report 2026-11): a small card in the corner, no
        // backdrop, so the page -- including the confirmation toast and its
        // Solscan link -- stays usable. Escape, the X or "Not now" dismiss it.
        <div
          className="merge-scope fixed left-4 right-4 bottom-20 sm:right-auto sm:bottom-6 sm:w-[320px] z-[90]"
          style={{ position: "fixed", background: "none" }}
        >
          <div
            role="dialog"
            aria-modal="false"
            aria-labelledby="feedback-prompt-title"
            className="relative w-full rounded-2xl border border-card-border bg-card text-card-foreground shadow-lg px-4 pt-4 pb-3"
          >
            <button
              type="button"
              aria-label="Close"
              onClick={() => setPromptAction(null)}
              className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <X className="w-4 h-4" />
            </button>
            <p className="text-xs text-muted-foreground pr-6">{FEEDBACK_ACTION_LABELS[promptAction]}</p>
            <h2 id="feedback-prompt-title" className="mt-0.5 text-base font-merge-display font-semibold tracking-tight">
              How did we do?
            </h2>
            <div className="mt-2 flex items-center justify-between gap-2">
              <StarRating
                value={0}
                onChange={(rating) => {
                  const action = promptAction;
                  setPromptAction(null);
                  navigate(feedbackHref({ rating, action, trigger: "prompt", from }));
                }}
              />
              <Button variant="outline" size="sm" onClick={() => setPromptAction(null)}>
                Not now
              </Button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
