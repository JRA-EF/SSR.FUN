// GET /api/mainnet/reserve-activity?reserve=<address> -- Reserve Activity
// Log for Mainnet Reserves (DEC-0206). Same shared handler as
// api/devnet/reserve-activity.ts (lib/reserve-activity/activityRoute.ts),
// bound to the 'mainnet-beta' cluster tag and HELIUS_MAINNET_RPC_URL, so a
// Mainnet Reserve's Manage page reads and tops up the SAME rows the KPI
// sweep (api/kpis/kpis-backfill-cron.ts) indexes -- never the DevNet
// chain. Also carries the per-recipient USDC fee-payout totals the Fee
// Configuration panel shows (`?scope=fees` for just those).
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { handleReserveActivityRequest, type ActivityRouteRequest, type ActivityRouteResponse } from "../../lib/reserve-activity/activityRoute";

const RPC_URL = resolveRpcUrl();

export default async function handler(req: ActivityRouteRequest, res: ActivityRouteResponse) {
  await handleReserveActivityRequest(req, res, {
    cluster: "mainnet-beta",
    rpcUrl: RPC_URL,
    redact: redactRpcSecrets,
    allowRequest: (ip) => checkRateWindow(`mainnet-reserve-activity:${ip}`, 1_000, 5),
  });
}
