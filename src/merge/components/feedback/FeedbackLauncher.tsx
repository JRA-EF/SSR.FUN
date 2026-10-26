// The corner Feedback button (dismissable for a week) and the "How did we do?"
// prompt that appears mid-screen after a confirmed core action. Picking a star
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
  markPrompted,
  onActionFeedbackRequest,
  type FeedbackAction,
} from "@/lib/feedback";

const PROMPT_DELAY_MS = 1500;

export function FeedbackLauncher() {
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
        <div className="merge-scope fixed inset-0 z-[90]" style={{ position: "fixed", background: "none" }}>
          <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={() => setPromptAction(null)} aria-hidden="true" />
          <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="feedback-prompt-title"
              className="pointer-events-auto relative w-full max-w-sm rounded-2xl border border-card-border bg-card text-card-foreground shadow-lg px-6 pt-6 pb-5 text-center"
            >
              <button
                type="button"
                aria-label="Close"
                onClick={() => setPromptAction(null)}
                className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                <X className="w-4 h-4" />
              </button>
              <p className="text-xs text-muted-foreground">{FEEDBACK_ACTION_LABELS[promptAction]}</p>
              <h2 id="feedback-prompt-title" className="mt-1 text-xl font-merge-display font-semibold tracking-tight">
                How did we do?
              </h2>
              <div className="mt-4">
                <StarRating
                  size="lg"
                  value={0}
                  onChange={(rating) => {
                    const action = promptAction;
                    setPromptAction(null);
                    navigate(feedbackHref({ rating, action, trigger: "prompt", from }));
                  }}
                />
              </div>
              <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={() => setPromptAction(null)}>
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
