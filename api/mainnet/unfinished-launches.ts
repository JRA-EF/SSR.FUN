// /api/mainnet/unfinished-launches -- a wallet's unfinished Reserve launches
// (DEC-0296), read from the chain, plus the ones it chose to hide.
//
//   GET  ?wallet=<address>  -> { launches: UnfinishedLaunch[], cancelled: { reserve, cancelledAt }[], cancelledUnavailable?: true }
//   POST { action: "cancel" | "undo", reserve, wallet, issuedAt, signature (base64) } -> { ok, cancelled }
//
// Discovery is one getProgramAccounts memcmp on Reserve.manager (packages/sdk's
// discoverUnfinishedLaunchesByScan) -- done here because the browser's
// rpc-proxy does not allow getProgramAccounts. The browser re-reads every
// Reserve it is about to finish (fetchReserveOnChain), so this list only
// decides what to show, never what gets signed.
//
// Cancel is app-level only (lib/launch-cancel/rules.ts explains why): the
// manager signs a message, we verify ed25519 over that exact text, re-read
// the Reserve on-chain (manager == signer; cancel also needs status
// created/assetsInitializing) and store the row in launch_cancellations.
// Public, read-only on chain, no secrets returned.
import { PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram, decodedStatusName, discoverUnfinishedLaunchesByScan, type UnfinishedLaunch } from "@ssr/sdk";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { mainnetConnection, redactRpcSecrets } from "./_lib/rpc";
import { verifyWalletSignature } from "./campaign-entry";
import { checkLaunchCancelOnChain, checkLaunchCancelShape, launchCancelMessage } from "../../lib/launch-cancel/rules";
import { deleteCancellation, listCancellations, upsertCancellation } from "../../lib/launch-cancel/db";

interface ApiResponseWithHeaders extends ApiResponse {
  setHeader?(name: string, value: string): void;
}

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

function validAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// A few seconds of per-wallet caching: Manage and Launch both ask on load.
const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; launches: UnfinishedLaunch[] }>();

async function launchesFor(wallet: string): Promise<UnfinishedLaunch[]> {
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.launches;
  const launches = await discoverUnfinishedLaunchesByScan(mainnetConnection(), new PublicKey(wallet));
  cache.set(wallet, { at: Date.now(), launches });
  if (cache.size > 500) cache.clear();
  return launches;
}

export default async function handler(req: ApiRequest, res: ApiResponseWithHeaders) {
  res.setHeader?.("Cache-Control", "no-store");
  if (!checkRateWindow(`mainnet-unfinished-launches:${clientIp(req)}`, 60_000, 20)) {
    res.setHeader?.("Retry-After", "10");
    res.status(429).json({ error: "Too many requests from this client -- wait a moment and try again." });
    return;
  }

  if (req.method === "GET") {
    const wallet = req.query?.wallet;
    if (!validAddress(wallet)) {
      res.status(400).json({ error: "Missing or invalid wallet." });
      return;
    }
    let launches: UnfinishedLaunch[];
    try {
      launches = await launchesFor(wallet);
    } catch (e) {
      console.error("[unfinished-launches] scan failed:", redactRpcSecrets(e instanceof Error ? e.message : String(e)));
      res.status(503).json({ error: "Could not check for unfinished launches right now. Please try again shortly." });
      return;
    }
    // The hide list is a convenience: a database outage shows every launch rather than failing.
    try {
      const cancelled = await listCancellations(wallet);
      res.status(200).json({ launches, cancelled });
    } catch (e) {
      console.error("[unfinished-launches] cancellations read failed:", e instanceof Error ? e.message : e);
      res.status(200).json({ launches, cancelled: [], cancelledUnavailable: true });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const shape = checkLaunchCancelShape(parseJsonBody(req) as never, Date.now());
  if (!shape.ok) {
    res.status(shape.status).json({ error: shape.error });
    return;
  }
  const message = launchCancelMessage(shape);
  if (!verifyWalletSignature(shape.wallet, message, shape.signature)) {
    res.status(401).json({ error: "The wallet signature didn't match. Please sign again." });
    return;
  }

  let onChain: { manager: string; status: string } | null;
  try {
    const program = buildReadOnlyProgram(mainnetConnection()) as unknown as {
      account: { reserve: { fetchNullable(a: PublicKey): Promise<{ manager: PublicKey; status: object } | null> } };
    };
    const account = await program.account.reserve.fetchNullable(new PublicKey(shape.reserve));
    onChain = account ? { manager: account.manager.toBase58(), status: decodedStatusName(account.status) } : null;
  } catch (e) {
    console.error("[unfinished-launches] reserve read failed:", redactRpcSecrets(e instanceof Error ? e.message : String(e)));
    res.status(503).json({ error: "Could not read this Reserve on-chain right now. Please try again shortly." });
    return;
  }
  const chainCheck = checkLaunchCancelOnChain(shape.action, shape.wallet, onChain);
  if (!chainCheck.ok) {
    res.status(chainCheck.status).json({ error: chainCheck.error });
    return;
  }

  try {
    if (shape.action === "cancel") {
      await upsertCancellation({ reserve: shape.reserve, wallet: shape.wallet, signature: shape.signature, message });
    } else {
      await deleteCancellation(shape.reserve, shape.wallet);
    }
    res.status(200).json({ ok: true, cancelled: await listCancellations(shape.wallet) });
  } catch (e) {
    console.error("[unfinished-launches] cancellation write failed:", e instanceof Error ? e.message : e);
    res.status(503).json({ error: "Could not save that right now. Please try again shortly." });
  }
}
