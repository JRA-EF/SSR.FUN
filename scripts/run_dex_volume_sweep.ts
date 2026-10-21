// Runs the daily DEX volume sweep once from a workstation (same code as
// api/kpis/dex-volume-cron.ts). Usage: DATABASE_URL=... HELIUS_URL=... npx ts-node -P tests/tsconfig.json scripts/run_dex_volume_sweep.ts
import { Connection } from "@solana/web3.js";
import { sweepDexVolume } from "../lib/dex-volume/indexer";
import { fetchDexVolumeUsd, fetchDexVolumeUsdByReserve } from "../lib/dex-volume/read";

(async () => {
  const result = await sweepDexVolume(new Connection(process.env.HELIUS_URL!, "confirmed"), 240_000);
  console.log(JSON.stringify(result, null, 1));
  console.log("total DEX volume USD:", await fetchDexVolumeUsd(), await fetchDexVolumeUsdByReserve());
})().catch((e) => { console.error(e); process.exit(1); });
