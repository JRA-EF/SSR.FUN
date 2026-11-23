import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { IncompleteTransactionsBanner } from "@/components/IncompleteTransactionsBanner";
import "./merge.css";

/** Wraps every ported MERGE page in the .merge-scope theme boundary (see
 *  merge.css), a shared Radix TooltipProvider, and mounts the toast viewport once. */
export function MergeLayout({ children }: { children: ReactNode }) {
  return (
    // overflow-x-clip: full-bleed hero art uses w-screen (100vw), which on
    // desktops with a classic scrollbar is wider than the page and produced a
    // horizontal scrollbar on Discover and the other merge pages. clip (not
    // hidden) keeps position: sticky working.
    <div className="merge-scope min-h-[100dvh] overflow-x-clip">
      <TooltipProvider>
        <IncompleteTransactionsBanner />
        {children}
      </TooltipProvider>
      <Toaster />
    </div>
  );
}
