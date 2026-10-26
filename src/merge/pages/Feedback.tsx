// #/feedback -- rating, a short explanation and an optional snapshot, then a
// thank-you. Reached from the corner Feedback button or the "How did we do?"
// prompt (which passes the picked rating and the action in the query string).
import { useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AlertCircle, CheckCircle2, ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StarRating } from "@/components/feedback/StarRating";
import {
  FEEDBACK_ACTION_LABELS,
  FEEDBACK_DETAILS_MAX,
  FEEDBACK_SUBJECT_MAX,
  prepareSnapshot,
  submitFeedback,
  type FeedbackAction,
  type FeedbackTrigger,
  type Snapshot,
} from "@/lib/feedback";
import { navigate, usePath } from "../../lib/router";

const ACTIONS: FeedbackAction[] = ["mint", "redeem", "rebalance", "create-reserve", "liquidity"];

function readQuery(path: string) {
  const q = new URLSearchParams(path.split("?")[1] ?? "");
  const rating = Number(q.get("rating"));
  const action = q.get("action") as FeedbackAction | null;
  const from = q.get("from") ?? "/";
  return {
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
    action: action && ACTIONS.includes(action) ? action : null,
    trigger: (q.get("trigger") === "prompt" ? "prompt" : "button") as FeedbackTrigger,
    // Only ever return to a path inside the app.
    from: from.startsWith("/") && !from.startsWith("//") ? from : "/",
  };
}

export function Feedback() {
  const path = usePath();
  const [initial] = useState(() => readQuery(path));
  const { publicKey } = useWallet();
  const [rating, setRating] = useState(initial.rating);
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setSnapshotBusy(true);
    try {
      setSnapshot(await prepareSnapshot(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That image could not be opened.");
    } finally {
      setSnapshotBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const send = async () => {
    if (!rating) {
      setError("Pick a rating from 1 to 5 stars.");
      return;
    }
    if (!subject.trim()) {
      setError("Add a short summary of your feedback.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      await submitFeedback({
        rating,
        subject: subject.trim(),
        details: details.trim(),
        trigger: initial.trigger,
        action: initial.action,
        pageUrl: `${location.origin}/#${initial.from}`,
        wallet: publicKey?.toBase58() ?? null,
        snapshot,
      });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not send your feedback. Please try again.");
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-5">
          <CheckCircle2 className="w-12 h-12 mx-auto text-action" strokeWidth={1.5} />
          <h1 className="text-3xl font-merge-display font-bold">Thank you</h1>
          <p className="text-muted-foreground">
            Your feedback reached the SSR.fun team. We read every response, and it shapes what we fix and build next.
          </p>
          <Button className="rounded-full h-12 px-10 text-base" onClick={() => navigate(initial.from)}>
            {initial.from === "/" ? "Back to SSR.fun" : "Back to where you were"}
          </Button>
        </div>
      </div>
    );
  }

  const subjectLeft = FEEDBACK_SUBJECT_MAX - subject.length;
  const detailsLeft = FEEDBACK_DETAILS_MAX - details.length;

  return (
    <div className="container mx-auto px-4 py-10 max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-merge-display font-bold">Share your feedback</h1>
        <p className="text-muted-foreground">
          {initial.action ? `${FEEDBACK_ACTION_LABELS[initial.action]} ` : ""}
          Tell us how SSR.fun is working for you. It takes less than a minute.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-6">
          <div className="space-y-2 text-center">
            <Label className="block">How did we do?</Label>
            <StarRating value={rating} onChange={(r) => { setRating(r); setError(null); }} size="lg" />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="feedback-subject">What stood out?</Label>
              <span className={`text-xs tabular-nums ${subjectLeft < 20 ? "text-foreground" : "text-muted-foreground"}`}>
                {subjectLeft} left
              </span>
            </div>
            <Input
              id="feedback-subject"
              value={subject}
              maxLength={FEEDBACK_SUBJECT_MAX}
              required
              onChange={(e) => {
                setSubject(e.target.value.slice(0, FEEDBACK_SUBJECT_MAX));
                setError(null);
              }}
              placeholder="One line, e.g. Minting was quick but the fee was unclear"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="feedback-details">Tell us more (optional)</Label>
              <span className={`text-xs tabular-nums ${detailsLeft < 100 ? "text-foreground" : "text-muted-foreground"}`}>
                {detailsLeft} left
              </span>
            </div>
            <Textarea
              id="feedback-details"
              value={details}
              maxLength={FEEDBACK_DETAILS_MAX}
              onChange={(e) => setDetails(e.target.value.slice(0, FEEDBACK_DETAILS_MAX))}
              placeholder="Go in depth: what you were trying to do, what happened, and what you expected instead."
              className="min-h-[130px] resize-y"
            />
          </div>

          <div className="space-y-2">
            <Label>Snapshot (optional)</Label>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
            {snapshot ? (
              <div className="relative inline-block">
                <img src={snapshot.previewUrl} alt="Your snapshot" className="max-h-48 rounded-lg border border-border" />
                <button
                  type="button"
                  aria-label="Remove snapshot"
                  onClick={() => setSnapshot(null)}
                  className="absolute -top-2 -right-2 flex items-center justify-center w-6 h-6 rounded-full border border-border bg-background text-muted-foreground hover:text-foreground shadow-sm"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={snapshotBusy}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void pickFile(e.dataTransfer.files?.[0]);
                }}
                className="w-full flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
              >
                {snapshotBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
                <span>Add a screenshot of what you saw</span>
                <span className="text-xs">PNG, JPEG or WebP. Drop it here or click to choose.</span>
              </button>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate(initial.from)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={() => void send()} disabled={sending || snapshotBusy || !rating || !subject.trim()}>
              {sending && <Loader2 className="w-4 h-4 animate-spin" />}
              {sending ? "Sending…" : "Send feedback"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            We include the page you came from and, if one is connected, your wallet address, so we can look into what you saw.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
