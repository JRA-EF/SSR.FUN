// POST /api/devnet/sponsor-sol -- Phase B's tightly-limited DevNet SOL
// onboarding grant, so an internal tester isn't solely dependent on the
// public DevNet airdrop faucet (documented elsewhere as unreliable/rate-
// limited) to pay network fees and account rent. See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model" for the full design.
//
// This is intentionally a SMALL onboarding grant, not a Reserve-funding
// mechanism -- enough for a handful of transaction fees / a small ATA rent,
// not enough to seed a Reserve. Same eligibility shape as the devUSDC
// faucet: a durable, live-checked on-chain SOL-balance ceiling, plus a
// best-effort in-memory cooldown. No user wallet signature is required
// (this only ever adds SOL to the requesting wallet).
//
// The authority's own SOL balance is real and finite (shared with its
// Buy/Sell-zap and other faucet duties -- see the plan doc's "Operational
// constraints") -- if it runs dry, this endpoint fails with an honest
// insufficient-funds error, never a fabricated success.
import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadDevnetAuthority } from "./_lib/authority";
import { assertDevnetCluster, NotDevnetError } from "./_lib/network";
import { cooldownRemainingMs, recordAction } from "./_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "./_lib/apiTypes";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GRANT_LAMPORTS = 10_000_000; // 0.01 SOL -- see the plan doc's decision table
const BALANCE_CEILING_LAMPORTS = 30_000_000; // 0.03 SOL
const COOLDOWN_MS = 60_000;
// The authority must keep enough of its own balance for its OTHER DevNet
// duties (Buy/Sell zap co-signing, the devUSDC/test-asset faucets) -- this
// endpoint refuses to drain it below a floor rather than spending the last
// lamport on a sponsorship grant.
const AUTHORITY_MIN_RESERVE_LAMPORTS = 50_000_000; // 0.05 SOL

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

  const cooldownKey = `sol:${userPubkey.toBase58()}`;
  const remainingMs = cooldownRemainingMs(cooldownKey, COOLDOWN_MS);
  if (remainingMs > 0) {
    res.status(429).json({ error: `Please wait ${Math.ceil(remainingMs / 1000)}s before requesting a DevNet SOL grant again.`, retryAfterSeconds: Math.ceil(remainingMs / 1000) });
    return;
  }

  let authority;
  try {
    authority = loadDevnetAuthority();
  } catch {
    res.status(500).json({ error: "DevNet SOL sponsorship is not configured on this deployment." });
    return;
  }

  let recipientBalance: number;
  try {
    recipientBalance = await connection.getBalance(userPubkey);
  } catch (e) {
    res.status(502).json({ error: `Could not read this wallet's DevNet SOL balance: ${e instanceof Error ? e.message : "RPC error"}.` });
    return;
  }
  if (recipientBalance >= BALANCE_CEILING_LAMPORTS) {
    res.status(400).json({
      error: `This wallet already holds ${(recipientBalance / 1e9).toFixed(5)} SOL, at or above the ${(BALANCE_CEILING_LAMPORTS / 1e9).toFixed(2)} SOL onboarding ceiling. Use the public DevNet faucet (https://faucet.solana.com) if you need more.`,
      currentBalanceLamports: recipientBalance,
    });
    return;
  }

  let authorityBalance: number;
  try {
    authorityBalance = await connection.getBalance(authority.publicKey);
  } catch (e) {
    res.status(502).json({ error: `Could not read the sponsorship wallet's balance: ${e instanceof Error ? e.message : "RPC error"}.` });
    return;
  }
  if (authorityBalance - GRANT_LAMPORTS < AUTHORITY_MIN_RESERVE_LAMPORTS) {
    // Honest, not fabricated: the sponsor really is low. No silent
    // fallback, no fake success -- the client is expected to show the
    // guided public-faucet fallback in this case.
    res.status(503).json({
      error: "The SSR-sponsored DevNet SOL grant is temporarily exhausted. Please use the public DevNet faucet (https://faucet.solana.com) instead.",
      sponsorExhausted: true,
    });
    return;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: userPubkey, lamports: GRANT_LAMPORTS }),
  );
  tx.feePayer = authority.publicKey;

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [authority]);
    recordAction(cooldownKey);
    res.status(200).json({ signature, grantedLamports: GRANT_LAMPORTS });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to send the DevNet SOL grant." });
  }
}
