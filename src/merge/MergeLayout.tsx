import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import "./merge.css";

/** Wraps every ported MERGE page in the .merge-scope theme boundary (see
 *  merge.css), a shared Radix TooltipProvider, and mounts the toast viewport once. */
export function MergeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="merge-scope min-h-[100dvh]">
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster />
    </div>
  );
}
