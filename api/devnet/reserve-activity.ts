// GET /api/devnet/reserve-activity?reserve=<address> -- Reserve Activity
// Log for DevNet Reserves, served from Postgres (lib/reserve-activity/
// schema.sql) instead of walking live RPC on every request. The handler
// itself is shared with api/mainnet/reserve-activity.ts (DEC-0206) -- see
// lib/reserve-activity/activityRoute.ts for the full behaviour; this file
// only binds the DevNet cluster tag and RPC.
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { checkRateWindow } from "./_lib/rateLimit";
import { handleReserveActivityRequest, type ActivityRouteRequest, type ActivityRouteResponse } from "../../lib/reserve-activity/activityRoute";

const RPC_URL = resolveRpcUrl();

export default async function handler(req: ActivityRouteRequest, res: ActivityRouteResponse) {
  await handleReserveActivityRequest(req, res, {
    cluster: "devnet",
    rpcUrl: RPC_URL,
    redact: redactRpcSecrets,
    allowRequest: (ip) => checkRateWindow(`devnet-reserve-activity:${ip}`, 1_000, 5),
  });
}
