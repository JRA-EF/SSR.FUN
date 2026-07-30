// POST /api/devnet/mint-test-assets -- a DevNet-only faucet for the Gate-9
// fixture test asset mints (mockX/Y/Z) plus (Phase C) devUSDC. Fully
// server-signed (the swap authority is also all of these mints' SPL mint
// authority); no user signature is needed since this only ever ADDS tokens
// to the requesting wallet, never moves anything out of it. Used for: (a)
// seeding a newly created Reserve (the new manager needs to hold the seed
// amounts before calling seed_reserve themselves), and (b) letting a
// connected wallet get test assets to experiment with Sell without having
// Bought first. Capped per request to keep this a testing convenience, not
// an open mint.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEVNET_FIXTURES, DEVUSDC } from "../../packages/sdk/src";
import { loadDevnetAuthority } from "./_lib/authority";
import { resolveRpcUrl } from "./_lib/rpc";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

const RPC_URL = resolveRpcUrl();
type MintMeta = { address: string; decimals: number; symbol: string };
const ALLOWED_MINTS: Record<string, MintMeta> = Object.fromEntries(
  [...Object.values(DEVNET_FIXTURES.mints), { address: DEVUSDC.mint, decimals: DEVUSDC.decimals, symbol: DEVUSDC.symbol }].map((m: MintMeta) => [
    m.address,
    m,
  ]),
);

// Per-request cap, in whole tokens (pre-decimals) -- generous for testing,
// small enough that this can never function as a real-value faucet.
const MAX_AMOUNT_PER_MINT = 1000;

function parseBody(req: ApiRequest): Record<string, unknown> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let swapAuthority: Keypair;
  try {
    swapAuthority = loadDevnetAuthority();
  } catch {
    res.status(500).json({ error: "DevNet swap adapter is not configured on this deployment." });
    return;
  }

  const body = parseBody(req);
  const userPubkeyStr = typeof body.userPubkey === "string" ? body.userPubkey : "";
  const requests = Array.isArray(body.mints) ? (body.mints as { mint: string; rawAmount: string }[]) : [];

  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(userPubkeyStr);
  } catch {
    res.status(400).json({ error: "Invalid userPubkey." });
    return;
  }
  if (requests.length === 0) {
    res.status(400).json({ error: "mints must be a non-empty array of { mint, rawAmount }." });
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const tx = new Transaction();

  for (const r of requests) {
    const meta = ALLOWED_MINTS[r.mint];
    if (!meta) {
      res.status(400).json({ error: `Mint ${r.mint} is not one of the DevNet test assets.` });
      return;
    }
    let rawAmount: bigint;
    try {
      rawAmount = BigInt(r.rawAmount);
    } catch {
      res.status(400).json({ error: "rawAmount must be an integer string." });
      return;
    }
    const cap = BigInt(MAX_AMOUNT_PER_MINT) * BigInt(10 ** meta.decimals);
    if (rawAmount <= 0n || rawAmount > cap) {
      res.status(400).json({ error: `rawAmount for ${meta.symbol} must be between 1 and ${cap.toString()} (${MAX_AMOUNT_PER_MINT} tokens).` });
      return;
    }
    const mint = new PublicKey(r.mint);
    const ata = getAssociatedTokenAddressSync(mint, userPubkey);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(swapAuthority.publicKey, ata, userPubkey, mint));
    tx.add(createMintToInstruction(mint, ata, swapAuthority.publicKey, rawAmount));
  }

  try {
    tx.feePayer = swapAuthority.publicKey;
    const signature = await sendAndConfirmTransaction(connection, tx, [swapAuthority]);
    res.status(200).json({ signature });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to mint DevNet test assets." });
  }
}
