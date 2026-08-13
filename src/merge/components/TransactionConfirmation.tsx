// Shared building blocks for every "a transaction just succeeded" notice
// across the site (toasts and the few inline confirmation banners) -- see
// docs/project/DECISION_LOG.md for the pass that introduced this. The full,
// untruncated signature is always threaded through as a prop and used
// directly to build the Solscan link and the copy payload; only the
// user-facing headline text is ever shortened.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { solscanUrl } from "@/lib/solana-config";

function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for browsers/contexts without the async Clipboard API.
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
}

/** Icon button that copies the full transaction signature. Always stops propagation so it never also triggers a surrounding "open on Solscan" click. */
export function CopySignatureButton({ signature, size = "sm" }: { signature: string; size?: "sm" | "xs" }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyToClipboard(signature);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      onKeyDown={(e) => {
        // Enter/Space on this button fires a native click (handled above),
        // but the keydown itself still bubbles to the card's own
        // onKeyDown -- stop it so it doesn't also open Solscan.
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      title={copied ? "Copied to clipboard" : "Copy full transaction signature"}
      aria-label={copied ? "Full transaction signature copied to clipboard" : "Copy full transaction signature to clipboard"}
      className={cn(
        "shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        size === "xs" && "p-1",
      )}
    >
      {copied ? <Check className={size === "xs" ? "h-3 w-3" : "h-4 w-4"} /> : <Copy className={size === "xs" ? "h-3 w-3" : "h-4 w-4"} />}
    </button>
  );
}

/**
 * The clickable body of a transaction-success notice: clicking or
 * pressing Enter/Space anywhere in it (other than the copy button) opens
 * the transaction on the correct Solscan cluster in a new tab. Used both
 * as a toast description and inline (e.g. DevnetOnboarding's claim cards).
 */
export function TransactionConfirmedCard({
  headline = "Transaction confirmed",
  signature,
  size = "sm",
  className,
}: {
  headline?: string;
  signature: string;
  size?: "sm" | "xs";
  className?: string;
}) {
  const url = solscanUrl("tx", signature);
  const open = () => window.open(url, "_blank", "noopener,noreferrer");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        // Ignore keydowns that bubbled up from a nested focusable element
        // (e.g. the copy button) -- only the card itself being focused
        // should open Solscan.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      aria-label={`${headline}. Opens the transaction on Solscan in a new tab. Use the copy button to copy the full signature instead.`}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className={cn("font-medium", size === "xs" ? "text-xs" : "text-sm")}>
        {headline} &mdash; View on Solscan
      </span>
      <CopySignatureButton signature={signature} size={size} />
    </div>
  );
}

/** Standard payload for toast({...}) on any successful transaction -- never pass a truncated/displayed copy of the signature here, always the real one. */
export function transactionConfirmedToast(signature: string, headline = "Transaction confirmed") {
  return { description: <TransactionConfirmedCard headline={headline} signature={signature} /> };
}
