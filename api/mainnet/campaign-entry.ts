// /api/mainnet/campaign-entry -- Beta Campaign creator entry (DEC-0279).
// Behind the BETA gate (only signed-in creators use it, from the Reserve page).
//
//   GET  ?reserve=<address>  -> { open, phase, entry: { handle, wallet, enteredAt } | null }
//   POST { reserve, wallet, handle, issuedAt, signature (base64) } -> { ok, entry }
//
// One sign-up per wallet (owner, 2026-11-04) covers trades AND every Reserve the wallet creates:
//   GET  ?wallet=<address>   -> { open, phase, entry }
//   POST { kind: "trader", wallet, handle, issuedAt, signature } -> { ok, entry }
//
// The creator's wallet signs lib/campaign/rules.ts's entryMessage. We accept it
// only when the signature is valid ed25519 over that exact text, the wallet is
// the Reserve's on-chain manager (warm-cache snapshot), the message is fresh,
// and the wallet is not a team wallet. That links X handle <-> creator wallet
// with proof anyone can re-check (message + signature are stored).
import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { readReserveSnapshot } from "../../lib/reserve-warm-cache/db";
import { campaignConfig, campaignPhase, entriesOpen, entryMessage, ENTRY_MAX_AGE_MS, normalizeHandle, signupMessage } from "../../lib/campaign/rules";
import { createdTsOf, findEntry, findTrader, upsertEntry, upsertTrader } from "../../lib/campaign/db";

function parseBody(req: ApiRequest): Record<string, unknown> {
  const b = (req as { body?: unknown }).body;
  if (b && typeof b === "object") return b as Record<string, unknown>;
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return {};
}

function validAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

/** ed25519 verify of `message` by a Solana wallet, via Node's crypto (no extra dependency). */
export function verifyWalletSignature(wallet: string, message: string, signatureB64: string): boolean {
  try {
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(new PublicKey(wallet).toBytes()).toString("base64url") }, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

async function managerOf(reserve: string): Promise<string | null> {
  const row = await readReserveSnapshot("mainnet-beta");
  const reserves = (row?.snapshot as { reserves?: { reserve: string; manager: string }[] } | undefined)?.reserves ?? [];
  return reserves.find((r) => r.reserve === reserve)?.manager ?? null;
}

export default async function handler(req: ApiRequest, res: ApiResponse & { setHeader(name: string, value: string): void }) {
  res.setHeader("Cache-Control", "no-store");
  const cfg = campaignConfig();
  const now = Date.now();
  const phase = campaignPhase(cfg, Math.floor(now / 1000));
  const open = entriesOpen(cfg, Math.floor(now / 1000));

  try {
    if (req.method === "GET") {
      const traderWallet = req.query?.wallet;
      if (traderWallet !== undefined) {
        if (!validAddress(traderWallet)) { res.status(400).json({ error: "Missing or invalid wallet." }); return; }
        const t = await findTrader(traderWallet);
        res.status(200).json({ open, phase, endTs: cfg.endTs, entry: t ? { handle: t.handle, wallet: t.wallet, enteredAt: t.enteredAt } : null });
        return;
      }
      const reserve = req.query?.reserve;
      if (!validAddress(reserve)) { res.status(400).json({ error: "Missing or invalid reserve." }); return; }
      const entry = await findEntry(reserve);
      res.status(200).json({ open, phase, endTs: cfg.endTs, entry: entry ? { handle: entry.handle, wallet: entry.wallet, enteredAt: entry.enteredAt } : null });
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    if (!open) { res.status(409).json({ error: "The campaign has closed; entries are no longer accepted." }); return; }

    const body = parseBody(req);
    const { reserve, wallet, issuedAt, signature } = body;
    const handle = normalizeHandle(body.handle);

    if (body.kind === "trader") {
      if (!validAddress(wallet)) { res.status(400).json({ error: "Missing or invalid wallet." }); return; }
      if (!handle) { res.status(400).json({ error: "Enter a valid X handle (letters, numbers and _ only, up to 15)." }); return; }
      if (typeof issuedAt !== "string" || typeof signature !== "string") { res.status(400).json({ error: "Missing signature." }); return; }
      const ms = Date.parse(issuedAt);
      if (!Number.isFinite(ms) || Math.abs(now - ms) > ENTRY_MAX_AGE_MS) { res.status(400).json({ error: "That signature has expired. Please sign again." }); return; }
      if (cfg.excludedWallets.has(wallet)) { res.status(403).json({ error: "Team wallets can't enter the campaign." }); return; }
      const message = signupMessage({ wallet, handle, issuedAt });
      if (!verifyWalletSignature(wallet, message, signature)) { res.status(401).json({ error: "The wallet signature didn't match. Please sign again." }); return; }
      const t = await upsertTrader({ wallet, handle, message, signature });
      res.status(200).json({ ok: true, phase, entry: { handle: t.handle, wallet: t.wallet, enteredAt: t.enteredAt } });
      return;
    }
    if (!validAddress(reserve) || !validAddress(wallet)) { res.status(400).json({ error: "Missing or invalid reserve or wallet." }); return; }
    if (!handle) { res.status(400).json({ error: "Enter a valid X handle (letters, numbers and _ only, up to 15)." }); return; }
    if (typeof issuedAt !== "string" || typeof signature !== "string") { res.status(400).json({ error: "Missing signature." }); return; }
    const issuedMs = Date.parse(issuedAt);
    if (!Number.isFinite(issuedMs) || Math.abs(now - issuedMs) > ENTRY_MAX_AGE_MS) { res.status(400).json({ error: "That signature has expired. Please sign again." }); return; }
    if (cfg.excludedWallets.has(wallet)) { res.status(403).json({ error: "Team wallets can't enter the campaign." }); return; }

    const manager = await managerOf(reserve);
    if (!manager) { res.status(404).json({ error: "This Reserve isn't indexed yet. Please try again in about 10 minutes." }); return; }
    if (manager !== wallet) { res.status(403).json({ error: "Only the wallet that created this Reserve can enter it." }); return; }
    // Only NEW Reserves (created at/after the start). Not indexed yet = brand new, accepted; the leaderboard re-checks.
    if (cfg.startTs !== null) {
      const created = await createdTsOf(reserve);
      if (created !== null && created < cfg.startTs) { res.status(403).json({ error: "Only Reserves created during the campaign can enter. Create a new Reserve to take part." }); return; }
    }

    const message = entryMessage({ reserve, wallet, handle, issuedAt });
    if (!verifyWalletSignature(wallet, message, signature)) { res.status(401).json({ error: "The wallet signature didn't match. Please sign again." }); return; }

    const entry = await upsertEntry({ reserve, wallet, handle, message, signature });
    res.status(200).json({ ok: true, phase, entry: { handle: entry.handle, wallet: entry.wallet, enteredAt: entry.enteredAt } });
  } catch (e) {
    console.error("[campaign-entry] failed:", e instanceof Error ? e.message : e);
    res.status(503).json({ error: "Campaign entry is temporarily unavailable. Please try again shortly." });
  }
}
