// Pure helpers shared by api/mainnet/warm-cache-cron.ts and its tests: which
// request URLs may trigger a snapshot refresh WITHOUT the scheduler's
// CRON_SECRET. Two cases, both deliberately unauthenticated because the
// refresh only ever re-derives public on-chain state (nothing is written that
// a caller controls):
//
//   ?dryRun=true                 -- manual inspection; runs the identical real work.
//   ?trigger=reserve-created     -- the Launch flow, right after a Reserve is
//                                   deployed, so the new Reserve reaches every
//                                   visitor's first paint within seconds
//                                   instead of at the next 10-minute tick
//                                   (DEC-0217).
export type ManualRefreshTrigger = "dry-run" | "reserve-created" | null;

export function manualRefreshTrigger(url: string | undefined): ManualRefreshTrigger {
  if (typeof url !== "string") return null;
  if (/[?&]dryRun=(?:true|1)(?:&|$)/.test(url)) return "dry-run";
  if (/[?&]trigger=reserve-created(?:&|$)/.test(url)) return "reserve-created";
  return null;
}
