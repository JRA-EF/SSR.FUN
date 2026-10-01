import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Copy, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  PNL_CARD_BACKGROUNDS,
  PNL_CARD_WIDTH,
  PNL_CARD_HEIGHT,
  buildShareText,
  buildXShareUrl,
  canvasToPngBlob,
  copyPngToClipboard,
  renderPnlCard,
  type PnlCardBackgroundId,
  type PnlCardData,
} from "@/lib/pnlCard";

/**
 * The small share glyph that sits in the top-right corner of the Reserve
 * display. Clicking it opens the performance card overlay below.
 */
export function ReservePnlCardTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label="Open this Reserve's shareable performance card"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <Share2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Share this Reserve's performance card</TooltipContent>
    </Tooltip>
  );
}

interface ReservePnlCardModalProps {
  open: boolean;
  onClose: () => void;
  data: PnlCardData;
  /** Public page link included in the X post. */
  shareUrl: string;
}

/**
 * Overlay that previews the rendered card, lets the user pick one of the
 * three mascot backgrounds, and offers Share on X / copy / download.
 *
 * Hand-rolled (no Radix Dialog in this repo): portaled to <body> inside its
 * own .merge-scope wrapper so the merge tokens apply outside MergeLayout,
 * closes on Escape and on scrim click, and locks page scroll while open.
 */
export function ReservePnlCardModal({ open, onClose, data, shareUrl }: ReservePnlCardModalProps) {
  const { toast } = useToast();
  const [backgroundId, setBackgroundId] = useState<PnlCardBackgroundId>("rain");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busy, setBusy] = useState<"share" | "copy" | "download" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const background = PNL_CARD_BACKGROUNDS.find((b) => b.id === backgroundId) ?? PNL_CARD_BACKGROUNDS[0];

  // Re-render whenever the overlay opens or the background/data changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRendering(true);
    renderPnlCard(data, background)
      .then((canvas) => {
        if (cancelled) return;
        canvasRef.current = canvas;
        setPreviewUrl(canvas.toDataURL("image/png"));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast({
          title: "Couldn't build the card",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
    };
    // `data` is rebuilt by the parent per render; the fields that matter are listed explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, background, data.name, data.ticker, data.logoUrl, data.allTimeChangePct, data.tokenPriceUsdc, data.managerLabel, data.siteHost, JSON.stringify(data.topAssets)]);

  // Escape closes; page scroll is held while the overlay is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const getBlob = useCallback(async () => {
    const canvas = canvasRef.current ?? (await renderPnlCard(data, background));
    return canvasToPngBlob(canvas);
  }, [data, background]);

  const fileName = `${data.ticker.toLowerCase()}-performance-card.png`;

  const handleDownload = useCallback(async () => {
    setBusy("download");
    try {
      const blob = await getBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({ title: "Card saved", description: `${fileName} is in your downloads.` });
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }, [getBlob, fileName, toast]);

  const handleCopy = useCallback(async () => {
    setBusy("copy");
    try {
      const blob = await getBlob();
      const ok = await copyPngToClipboard(blob);
      if (ok) {
        toast({ title: "Card copied", description: "Paste it anywhere that accepts images." });
      } else {
        toast({
          title: "Clipboard not available",
          description: "This browser doesn't allow copying images. Use Download instead.",
          variant: "destructive",
        });
      }
    } finally {
      setBusy(null);
    }
  }, [getBlob, toast]);

  const handleShareX = useCallback(async () => {
    setBusy("share");
    // Open the X composer synchronously on the click so pop-up blockers
    // don't swallow it, then copy the image while the tab is opening.
    const intent = buildXShareUrl(buildShareText(data), shareUrl);
    const popup = window.open(intent, "_blank", "noopener,noreferrer");
    try {
      const blob = await getBlob();
      const copied = await copyPngToClipboard(blob);
      if (copied) {
        toast({
          title: "Card copied — paste it into your post",
          description: "The post text is pre-filled on X. Press Ctrl+V (Cmd+V on Mac) in the composer to attach the card image.",
        });
      } else {
        toast({
          title: "Attach the card manually",
          description: "The post text is pre-filled on X. Download the card and add it to the post as an image.",
        });
      }
      if (!popup) {
        toast({
          title: "Pop-up blocked",
          description: "Allow pop-ups for this site, or open X and paste the copied card.",
          variant: "destructive",
        });
      }
    } finally {
      setBusy(null);
    }
  }, [data, shareUrl, getBlob, toast]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    // .merge-scope brings the color tokens but also (unlayered, so it beats
    // Tailwind utilities) `position: relative` and an opaque page background;
    // the inline styles put the fixed, transparent overlay back on top.
    <div className="merge-scope fixed inset-0 z-[100]" style={{ position: "fixed", background: "none" }}>
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-0 flex items-center justify-center p-4 overflow-y-auto pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pnl-card-title"
          className="pointer-events-auto w-full min-w-0 max-w-3xl rounded-2xl border border-card-border bg-card text-card-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
            <div>
              <h2 id="pnl-card-title" className="text-lg font-merge-display font-semibold tracking-tight">
                Share this Reserve's performance
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                A card with this Reserve's all-time gain since launch and its top-performing reserve assets. Post it to X, or copy or download the image.
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="px-6">
            <div
              className="relative w-full overflow-hidden rounded-xl border border-border bg-background/60"
              style={{ aspectRatio: `${PNL_CARD_WIDTH} / ${PNL_CARD_HEIGHT}` }}
            >
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt={`${data.name} performance card`}
                  className="block h-full w-full max-w-full object-cover"
                  draggable={false}
                />
              )}
              {rendering && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/40 text-sm text-muted-foreground">
                  Building the card…
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4 px-6 pt-4 pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2" role="group" aria-label="Card background">
              <span className="text-xs text-muted-foreground mr-1">Background</span>
              {PNL_CARD_BACKGROUNDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBackgroundId(b.id)}
                  aria-pressed={backgroundId === b.id}
                  aria-label={`Use the ${b.label} background`}
                  title={b.label}
                  className={`h-10 w-14 overflow-hidden rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    backgroundId === b.id ? "border-primary ring-2 ring-primary/50" : "border-border opacity-70 hover:opacity-100"
                  }`}
                >
                  <img src={b.src} alt="" className="h-full w-full object-cover" draggable={false} />
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDownload} disabled={rendering || busy !== null}>
                <Download className="h-4 w-4 mr-1.5" aria-hidden="true" /> Download
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopy} disabled={rendering || busy !== null}>
                <Copy className="h-4 w-4 mr-1.5" aria-hidden="true" /> Copy image
              </Button>
              <Button size="sm" onClick={handleShareX} disabled={rendering || busy !== null}>
                <XLogo className="h-3.5 w-3.5 mr-1.5" /> Share on X
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
