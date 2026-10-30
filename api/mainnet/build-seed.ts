// POST /api/mainnet/build-seed (DEC-0238): builds and co-signs the initial
// seed of a new Mainnet Reserve with the mint fee paid in USDC to the
// Protocol Treasury and the Manager inside the seed transaction. See
// lib/mainnet/buildSeed.ts. The creator's wallet signs and submits it.
//
// `preflight: true` runs the seed's checks before the Reserve exists (prices,
// the USDC fee, the 64-account limit) and builds nothing; the Create flow
// calls it between the swaps and create-and-register.
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { fetchJupiterPrices } from "./asset-prices";
import { BASE58_RE, U64_MAX } from "../../lib/mainnet/jupiter";
import { BuildError, serializeBuildResult } from "../../lib/mainnet/buildCommon";
import { buildSeedTransaction, preflightSeed, type BuildSeedDeps } from "../../lib/mainnet/buildSeed";
import { loadFeeQuoteSigner } from "../../lib/mainnet/usdcMintFee";
import { lookupReserveAlt } from "./build-buy";

interface ApiResponseWithHeaders extends ApiResponse {
  setHeader?(name: string, value: string): void;
}

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

function parseU64(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = BigInt(v);
  return n > 0n && n <= U64_MAX ? n : null;
}

export default async function handler(req: ApiRequest, res: ApiResponseWithHeaders) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // A launch needs one or two builds (a second only after making a lookup table).
  if (!checkRateWindow(`mainnet-build-seed:${clientIp(req)}`, 60_000, 12)) {
    res.setHeader?.("Retry-After", "10");
    res.status(429).json({ error: "Too many seed builds from this client -- wait a moment and try again." });
    return;
  }

  const body = parseJsonBody(req);
  if (body.preflight === true) {
    await handlePreflight(body, res);
    return;
  }
  const reserve = typeof body.reserve === "string" ? body.reserve : "";
  const manager = typeof body.manager === "string" ? body.manager : "";
  const lookupTable = typeof body.lookupTable === "string" && body.lookupTable ? body.lookupTable : null;
  const assetMintsRaw = Array.isArray(body.assetMints) ? (body.assetMints as unknown[]) : [];
  const seedAmountsRaw = Array.isArray(body.seedAmountsRaw) ? (body.seedAmountsRaw as unknown[]) : [];
  const initialReserveTokens = parseU64(body.initialReserveTokens);

  if (!BASE58_RE.test(reserve) || !BASE58_RE.test(manager) || (lookupTable !== null && !BASE58_RE.test(lookupTable))) {
    res.status(400).json({ error: "reserve, manager and lookupTable must be valid base58 addresses." });
    return;
  }
  if (assetMintsRaw.length < 1 || assetMintsRaw.length > 12 || assetMintsRaw.some((m) => typeof m !== "string" || !BASE58_RE.test(m))) {
    res.status(400).json({ error: "assetMints must be 1 to 12 valid base58 mint addresses." });
    return;
  }
  const seedAmounts = seedAmountsRaw.map(parseU64);
  if (seedAmounts.length !== assetMintsRaw.length || seedAmounts.some((a) => a === null) || initialReserveTokens === null) {
    res.status(400).json({ error: "seedAmountsRaw (one positive integer string per asset) and initialReserveTokens are required." });
    return;
  }

  const deps = seedDeps();
  try {
    const result = await buildSeedTransaction(
      deps,
      {
        reserve: new PublicKey(reserve),
        manager: new PublicKey(manager),
        assetMints: (assetMintsRaw as string[]).map((m) => new PublicKey(m)),
        seedAmountsRaw: seedAmounts as bigint[],
        initialReserveTokens,
        lookupTable: lookupTable ? new PublicKey(lookupTable) : null,
      },
    );
    res.status(200).json(serializeBuildResult(result));
  } catch (e) {
    sendError(res, e, "Could not build the seed transaction");
  }
}

function seedDeps(): BuildSeedDeps {
  const connection = new Connection(resolveRpcUrl(), "confirmed");
  return {
    connection,
    program: buildReadOnlyProgram(connection) as any,
    ssrProgramId: PROGRAM_ID,
    lookupReserveAlt,
    fetchPrices: (mints) => fetchJupiterPrices(mints, { throwOnFailure: true }),
    feeQuoteSigner: process.env.SSR_FEE_SETTLEMENT_KEEPER_SECRET ? loadFeeQuoteSigner() : null,
    simulate: async (tx) => {
      const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      return { err: sim.value.err, logs: sim.value.logs ?? null };
    },
  };
}

function sendError(res: ApiResponseWithHeaders, e: unknown, prefix: string): void {
  if (e instanceof BuildError) {
    if (e.retryAfterSeconds) res.setHeader?.("Retry-After", String(e.retryAfterSeconds));
    res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
    return;
  }
  res.status(502).json({ error: redactRpcSecrets(`${prefix}: ${e instanceof Error ? e.message : String(e)}`) });
}

async function handlePreflight(body: Record<string, unknown>, res: ApiResponseWithHeaders): Promise<void> {
  const manager = typeof body.manager === "string" ? body.manager : "";
  const feeDestination = typeof body.feeDestination === "string" ? body.feeDestination : "";
  const assetMintsRaw = Array.isArray(body.assetMints) ? (body.assetMints as unknown[]) : [];
  const recipientsRaw = Array.isArray(body.feeRecipients) ? (body.feeRecipients as unknown[]) : [];
  const seedAmounts = (Array.isArray(body.seedAmountsRaw) ? (body.seedAmountsRaw as unknown[]) : []).map(parseU64);
  const mintFeeBps = typeof body.mintFeeBps === "number" && Number.isInteger(body.mintFeeBps) && body.mintFeeBps >= 0 && body.mintFeeBps <= 10_000 ? body.mintFeeBps : null;
  if (!BASE58_RE.test(manager) || !BASE58_RE.test(feeDestination) || mintFeeBps === null) {
    res.status(400).json({ error: "manager, feeDestination (base58) and mintFeeBps (integer bps) are required." });
    return;
  }
  if (assetMintsRaw.length < 1 || assetMintsRaw.length > 12 || assetMintsRaw.some((m) => typeof m !== "string" || !BASE58_RE.test(m))) {
    res.status(400).json({ error: "assetMints must be 1 to 12 valid base58 mint addresses." });
    return;
  }
  if (recipientsRaw.length > 10 || recipientsRaw.some((r) => typeof r !== "string" || !BASE58_RE.test(r))) {
    res.status(400).json({ error: "feeRecipients must be at most 10 valid base58 wallet addresses." });
    return;
  }
  if (seedAmounts.length !== assetMintsRaw.length || seedAmounts.some((a) => a === null)) {
    res.status(400).json({ error: "seedAmountsRaw needs one positive integer string per asset." });
    return;
  }
  try {
    const result = await preflightSeed(seedDeps(), {
      manager: new PublicKey(manager),
      assetMints: (assetMintsRaw as string[]).map((m) => new PublicKey(m)),
      seedAmountsRaw: seedAmounts as bigint[],
      mintFeeBps,
      feeRecipients: (recipientsRaw as string[]).map((r) => new PublicKey(r)),
      feeDestination: new PublicKey(feeDestination),
    });
    res.status(200).json(result);
  } catch (e) {
    sendError(res, e, "Could not check the seed");
  }
}
