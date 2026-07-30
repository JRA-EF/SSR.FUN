// POST /api/devnet/faucet-devusdc -- Phase B's real devUSDC ("SSR Test USD")
// faucet. See docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md
// "Phase B -- security model" for the full design this implements exactly.
//
// Fully server-signed (the DevNet authority is devUSDC's mint authority);
// no user wallet signature is required since this only ever ADDS tokens to
// the requesting wallet, never moves anything out of it -- the same
// precedent already shipped in this repo for mint-test-assets.ts. Every
// value that matters (which mint, how much, whether this wallet is
// eligible) is decided server-side from live on-chain state or hardcoded
// config; the client only ever supplies its own public key.
//
// Eligibility has two layers:
//   1. DURABLE: the wallet's current on-chain devUSDC balance must be below
//      a hard ceiling, re-checked live on every request -- unspoofable by a
//      client, needs no persistent store.
//   2. BEST-EFFORT: an in-memory per-wallet cooldown (see api/devnet/_lib/rateLimit.ts)
//      that blunts rapid double-submission but resets on cold start -- not
//      a substitute for (1).
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { DEVUSDC, DEVUSDC_MINT, DEVUSDC_DECIMALS } from "../../packages/sdk/src";
import { loadDevnetAuthority } from "./_lib/authority";
import { assertDevnetCluster, NotDevnetError } from "./_lib/network";
import { cooldownRemainingMs, recordAction } from "./_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "./_lib/apiTypes";
import { resolveRpcUrl } from "./_lib/rpc";

const RPC_URL = resolveRpcUrl();

// Per-claim amount and durable per-wallet ceiling -- see the plan doc's
// "Phase B -- security model" decision table for the reasoning.
const CLAIM_AMOUNT_TOKENS = 500;
const BALANCE_CEILING_TOKENS = 2000;
const CLAIM_AMOUNT_RAW = BigInt(CLAIM_AMOUNT_TOKENS) * BigInt(10 ** DEVUSDC_DECIMALS);
const BALANCE_CEILING_RAW = BigInt(BALANCE_CEILING_TOKENS) * BigInt(10 ** DEVUSDC_DECIMALS);
const COOLDOWN_MS = 60_000;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = parseJsonBody(req);
  const userPubkeyStr = typeof body.userPubkey === "string" ? body.userPubkey : "";
  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(userPubkeyStr);
  } catch {
    res.status(400).json({ error: "Invalid userPubkey." });
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  try {
    await assertDevnetCluster(connection);
  } catch (e) {
    res.status(e instanceof NotDevnetError ? 403 : 502).json({ error: e instanceof Error ? e.message : "Could not verify the Solana DevNet cluster." });
    return;
  }

  // Best-effort cooldown check (see module header) -- checked before any
  // chain reads so a rapid double-click fails fast without extra RPC load.
  const cooldownKey = `devusdc:${userPubkey.toBase58()}`;
  const remainingMs = cooldownRemainingMs(cooldownKey, COOLDOWN_MS);
  if (remainingMs > 0) {
    res.status(429).json({ error: `Please wait ${Math.ceil(remainingMs / 1000)}s before requesting devUSDC again.`, retryAfterSeconds: Math.ceil(remainingMs / 1000) });
    return;
  }

  let authority;
  try {
    authority = loadDevnetAuthority();
  } catch {
    res.status(500).json({ error: "The devUSDC faucet is not configured on this deployment." });
    return;
  }

  const ata = getAssociatedTokenAddressSync(DEVUSDC_MINT, userPubkey);
  let currentBalanceRaw = 0n;
  try {
    const acct = await getAccount(connection, ata);
    currentBalanceRaw = acct.amount;
  } catch {
    // No ATA yet -- a brand-new wallet genuinely has a balance of 0, not an error.
  }
  if (currentBalanceRaw >= BALANCE_CEILING_RAW) {
    res.status(400).json({
      error: `This wallet already holds ${(Number(currentBalanceRaw) / 10 ** DEVUSDC_DECIMALS).toLocaleString()} devUSDC, at or above the ${BALANCE_CEILING_TOKENS.toLocaleString()} testing ceiling. No further claims are available.`,
      currentBalanceRaw: currentBalanceRaw.toString(),
    });
    return;
  }

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, userPubkey, DEVUSDC_MINT));
  tx.add(createMintToInstruction(DEVUSDC_MINT, ata, authority.publicKey, CLAIM_AMOUNT_RAW));
  tx.feePayer = authority.publicKey;

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [authority]);
    // Only record the cooldown AFTER a real confirmed transaction -- a
    // failed attempt must not consume the caller's next eligible window.
    recordAction(cooldownKey);
    res.status(200).json({
      signature,
      mint: DEVUSDC_MINT.toBase58(),
      symbol: DEVUSDC.symbol,
      name: DEVUSDC.name,
      claimedRaw: CLAIM_AMOUNT_RAW.toString(),
      decimals: DEVUSDC_DECIMALS,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to claim devUSDC on DevNet." });
  }
}
