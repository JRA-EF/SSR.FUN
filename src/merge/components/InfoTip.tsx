import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The one information-tooltip trigger used across every merge-scoped page.
 *
 * Exists because Radix's `TooltipTrigger` renders a plain, CLASS-LESS
 * `<button>`. That was invisible for as long as src/index.css's global
 * native-control reset applied document-wide, but the moment that reset was
 * scoped away from `.merge-scope` (see index.css's own comment) all 16 of
 * these triggers fell back to raw user-agent button chrome -- gray fills,
 * `outset` bevels, square corners. Centralizing them here means the styling
 * lives in exactly one place instead of being re-specified (or re-broken) at
 * every call site.
 *
 * Renders a real `<button>` via `asChild` so it stays keyboard-focusable and
 * screen-reader labelled; `aria-label` is required rather than optional
 * because an icon-only control has no accessible name otherwise.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <Info className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
