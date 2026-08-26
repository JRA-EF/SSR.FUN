// GET/POST /api/mainnet/reserve-alt -- the registry of each Reserve's
// TRADING ADDRESS LOOKUP TABLE (DEC-0161). One small on-chain lookup table
// per Reserve (created once, by anyone -- in practice the manager, via
// Manage's "Enable one-approval trading") holds the Reserve's fixed
// protocol accounts (reserve, vaults, mints, PDAs, programs), letting the
// composed one-transaction Buy/Sell reference them as 1-byte indexes
// instead of 32-byte static keys -- the difference between fitting
// Solana's 1232-byte transaction limit (ONE wallet approval) and falling
// back to the multi-approval sequential flow (live 2026-08-26: a CHARLI
// sell composed to ~26 static keys + a 47-account SSR route and overran,
// costing 3 signatures).
//
// SECURITY MODEL -- why an unauthenticated POST is safe: a lookup table
// CANNOT substitute accounts. The client always composes instructions with
// its own explicit pubkeys; v0 compilation only compresses a pubkey that
// APPEARS in the table (by content match) into an index -- a wrong or
// malicious table simply fails to compress (the transaction stays large
// and falls back), it can never redirect an instruction to a different
// account. The POST additionally verifies on-chain, before storing, that
// the submitted address IS a real lookup table containing this exact
// Reserve's pubkey. Public, read-only GET; no secrets.
import { Connection, PublicKey } from "@solana/web3.js";
import { getSql } from "../../lib/reserve-metadata/db";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { resolveRpcUrl } from "./_lib/rpc";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const cache = new Map<string, { alt: string | null; at: number }>();
const CACHE_TTL_MS = 60_000;

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

async function ensureTable(): Promise<void> {
  const sql = getSql();
  await sql`create table if not exists reserve_alts (
    reserve text primary key,
    alt text not null,
    updated_at timestamptz not null default now()
  )`;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");

  if (req.method === "GET") {
    const url = new URL(req.url ?? "", "http://internal");
    const reserve = url.searchParams.get("reserve") ?? "";
    if (!BASE58_RE.test(reserve)) {
      res.status(400).json({ error: "Invalid 'reserve' query param." });
      return;
    }
    const cached = cache.get(reserve);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      res.status(200).json({ alt: cached.alt });
      return;
    }
    try {
      await ensureTable();
      const sql = getSql();
      const rows = (await sql`select alt from reserve_alts where reserve = ${reserve}`) as { alt: string }[];
      const alt = rows[0]?.alt ?? null;
      cache.set(reserve, { alt, at: Date.now() });
      res.status(200).json({ alt });
    } catch (e) {
      console.error("api/mainnet/reserve-alt GET failed:", e);
      res.status(503).json({ error: "The lookup-table registry is temporarily unavailable." });
    }
    return;
  }

  if (req.method === "POST") {
    if (!checkRateWindow(`mainnet-reserve-alt:${clientIp(req)}`, 60_000, 5)) {
      res.status(429).json({ error: "Too many registration requests -- wait a moment and try again." });
      return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const reserve = typeof body.reserve === "string" ? body.reserve : "";
    const alt = typeof body.alt === "string" ? body.alt : "";
    if (!BASE58_RE.test(reserve) || !BASE58_RE.test(alt)) {
      res.status(400).json({ error: "reserve and alt must be valid base58 addresses." });
      return;
    }
    try {
      // On-chain verification before storing: the address must be a REAL
      // lookup table whose content includes this Reserve's own pubkey --
      // junk can never enter the registry.
      const connection = new Connection(resolveRpcUrl(), "confirmed");
      const table = await connection.getAddressLookupTable(new PublicKey(alt));
      if (!table.value) {
        res.status(422).json({ error: "That address is not an existing address lookup table on Mainnet." });
        return;
      }
      const containsReserve = table.value.state.addresses.some((a) => a.toBase58() === reserve);
      if (!containsReserve) {
        res.status(422).json({ error: "That lookup table does not contain this Reserve's address -- it is not this Reserve's trading table." });
        return;
      }
      await ensureTable();
      const sql = getSql();
      await sql`insert into reserve_alts (reserve, alt, updated_at) values (${reserve}, ${alt}, now())
                on conflict (reserve) do update set alt = ${alt}, updated_at = now()`;
      cache.set(reserve, { alt, at: Date.now() });
      res.status(200).json({ ok: true, alt });
    } catch (e) {
      console.error("api/mainnet/reserve-alt POST failed:", e);
      res.status(503).json({ error: "Could not verify or store the lookup table right now -- try again." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
