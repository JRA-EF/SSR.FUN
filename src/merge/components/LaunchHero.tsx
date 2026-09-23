// The Launch page's shell: the mascot hero washed behind the page top, with
// the heading, stepper and wizard card sitting ON it. Lifted verbatim from
// CreateDTR's own wizard so the Robinhood branch is the same page, not a
// lookalike -- an earlier version made the art a separate full-width banner
// with the content below it, which read as a different site.
import type { ReactNode } from "react";
import { LaunchHeader, LaunchStepper } from "./LaunchStepper";

export function LaunchShell({ subtitle, step, children }: { subtitle: string; step: number; children: ReactNode }) {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 relative">
      {/* Full-bleed hero art behind the page top (public/create-hero.jpg) —
          the shared mascot-hero treatment: left scrim for the title, bottom
          fade into the ground, hides itself if the file is absent. */}
      <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[260px] sm:h-[460px] overflow-hidden pointer-events-none -z-10">
        <img
          src="/create-hero.jpg"
          alt=""
          className="w-full h-full object-cover"
          style={{ objectPosition: "center 9%" }}
          onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
        />
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, hsl(var(--background) / 0.78) 0%, hsl(var(--background) / 0.25) 45%, hsl(var(--background) / 0.05) 100%)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 0%, hsl(var(--background) / 0.15) 68%, hsl(var(--background)) 100%)" }} />
      </div>

      <LaunchHeader subtitle={subtitle} />
      <LaunchStepper step={step} />
      {children}
    </div>
  );
}
