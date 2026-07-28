// POST /api/devnet/swap-sign -- the DevNet-only swap-adapter co-signer for
// SSR.fun's Buy/Sell "zap" (see docs/protocol/FRONTEND_INTEGRATION.md "Buy/Sell
// zap architecture"). The deployed protocol has no oracle/AMM of its own; Buy
// and Sell are single atomic, two-signer transactions combining a SOL leg
// with the real mint_reserve_tokens_in_kind/redeem_reserve_tokens_in_kind
// call. This endpoint holds the DevNet-only swap-authority keypair
// server-side (DEVNET_SWAP_AUTHORITY_SECRET_KEY, never sent to the browser)
// and:
//   1) independently re-fetches live on-chain Reserve state (never trusts
//      client-supplied balances/supply/fees for the actual math),
//   2) builds the exact instruction list via packages/sdk/src/zapInstructions.ts
//      (the same builders used by scripts/verify_zap.ts against live DevNet),
//   3) partially signs the assembled transaction with the swap-authority key,
//   4) returns it (base64, requireAllSignatures=false) for the client to
//      complete with the user's own wallet signature and submit.
//
// Blast-radius notes: the swap authority only ever mints the pre-approved
// DevNet test asset mints (ALLOWED_ASSET_MINTS below) and only ever spends
// its own SOL balance by an amount it computes itself from live on-chain
// state -- a malicious client cannot get more out than the SOL/tokens they
// actually put in, since the underlying protocol instruction still enforces
// its own accounting atomically in the same transaction.

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildReadOnlyProgram,
  fetchReserveOnChain,
  buildBuyZapInstructions,
  buildSellZapInstructions,
  DEVNET_FIXTURES,
} from "../../packages/sdk/src";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(DEVNET_FIXTURES.programId);

type MintMeta = { address: string; decimals: number; symbol: string };
const ALLOWED_ASSET_MINTS = new Set(Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => m.address));
const ASSET_TEST_PRICES_USD: Record<string, number> = Object.fromEntries(
  Object.values(DEVNET_FIXTURES.mints).map((m: MintMeta) => [m.address, 1]),
);

const KNOWN_RESERVES: Record<string, { protocolConfig: PublicKey }> = {
  [DEVNET_FIXTURES.reserveOne.reserve]: { protocolConfig: derivedProtocolConfig() },
  [DEVNET_FIXTURES.reserveTwo.reserve]: { protocolConfig: derivedProtocolConfig() },
};

function derivedProtocolConfig(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], PROGRAM_ID);
  return pda;
}

function loadSwapAuthority(): Keypair {
  const raw = process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY;
  if (!raw) throw new Error("DEVNET_SWAP_AUTHORITY_SECRET_KEY is not configured");
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

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
    swapAuthority = loadSwapAuthority();
  } catch {
    res.status(500).json({ error: "DevNet swap adapter is not configured on this deployment." });
    return;
  }

  const body = parseBody(req);
  const action = body.action;
  const reserveAddress = typeof body.reserve === "string" ? body.reserve : "";
  const userPubkeyStr = typeof body.userPubkey === "string" ? body.userPubkey : "";

  if (action !== "buy" && action !== "sell") {
    res.status(400).json({ error: "action must be 'buy' or 'sell'" });
    return;
  }
  if (!KNOWN_RESERVES[reserveAddress]) {
    res.status(400).json({ error: "Unknown or unsupported Reserve for the DevNet swap adapter." });
    return;
  }
  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(userPubkeyStr);
  } catch {
    res.status(400).json({ error: "Invalid userPubkey." });
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const reserve = new PublicKey(reserveAddress);
  const fixture = [DEVNET_FIXTURES.reserveOne, DEVNET_FIXTURES.reserveTwo].find((r) => r.reserve === reserveAddress)!;
  const assetMints = fixture.assets.map((a) => new PublicKey(a.mint));

  if (fixture.assets.some((a) => !ALLOWED_ASSET_MINTS.has(a.mint))) {
    res.status(400).json({ error: "Reserve contains an asset mint the DevNet swap adapter is not authorized to mint." });
    return;
  }

  const onChain = await fetchReserveOnChain(connection, PROGRAM_ID, reserve, assetMints);
  if (!onChain) {
    res.status(404).json({ error: "Reserve not found on-chain." });
    return;
  }
  if (onChain.status !== "active") {
    res.status(409).json({ error: `Reserve is not Active (status: ${onChain.status}) -- Buy/Sell unavailable.` });
    return;
  }

  const zapAssets = onChain.assets.map((a) => ({
    mint: a.assetMint,
    decimals: a.decimals,
    reserveAsset: a.reserveAsset,
    vault: a.vault,
    vaultBalanceRaw: a.vaultBalanceRaw,
  }));

  const program = buildReadOnlyProgram(connection) as unknown as import("@anchor-lang/core").Program<import("@anchor-lang/core").Idl>;

  try {
    if (action === "buy") {
      const solLamportsRaw = typeof body.solLamports === "string" ? body.solLamports : "";
      const solLamports = BigInt(solLamportsRaw);
      if (solLamports <= 0n) {
        res.status(400).json({ error: "solLamports must be a positive integer string." });
        return;
      }

      const result = await buildBuyZapInstructions({
        program,
        protocolConfig: KNOWN_RESERVES[reserveAddress].protocolConfig,
        reserve,
        reserveTokenMint: new PublicKey(fixture.reserveTokenMint),
        mintAuthority: new PublicKey(fixture.mintAuthority),
        user: userPubkey,
        swapAuthority: swapAuthority.publicKey,
        assets: zapAssets,
        reserveTokenSupplyRaw: onChain.reserveTokenSupplyRaw,
        solLamports,
        assetTestPricesUsd: ASSET_TEST_PRICES_USD,
      });

      const tx = new Transaction();
      tx.add(...result.instructions);
      tx.feePayer = userPubkey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.partialSign(swapAuthority);

      res.status(200).json({
        transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
        lastValidBlockHeight,
        quote: {
          reserveTokensRequested: result.reserveTokensRequested?.toString(),
          assetAmountsRaw: result.assetAmountsRaw.map((a) => a.toString()),
        },
      });
      return;
    }

    // sell
    const reserveTokensToRedeemRaw = typeof body.reserveTokensToRedeem === "string" ? body.reserveTokensToRedeem : "";
    const reserveTokensToRedeem = BigInt(reserveTokensToRedeemRaw);
    if (reserveTokensToRedeem <= 0n) {
      res.status(400).json({ error: "reserveTokensToRedeem must be a positive integer string." });
      return;
    }

    const reserveAccount = await (program.account as any).reserve.fetch(reserve);
    const redemptionFeeBps = BigInt(reserveAccount.feeConfig.redemptionFeeBps);

    const result = await buildSellZapInstructions({
      program,
      reserve,
      reserveTokenMint: new PublicKey(fixture.reserveTokenMint),
      vaultAuthority: new PublicKey(fixture.vaultAuthority),
      user: userPubkey,
      swapAuthority: swapAuthority.publicKey,
      assets: zapAssets,
      reserveTokenSupplyRaw: onChain.reserveTokenSupplyRaw,
      redemptionFeeBps,
      reserveTokensToRedeem,
      assetTestPricesUsd: ASSET_TEST_PRICES_USD,
    });

    const tx = new Transaction();
    tx.add(...result.instructions);
    tx.feePayer = userPubkey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.partialSign(swapAuthority);

    res.status(200).json({
      transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      lastValidBlockHeight,
      quote: {
        assetAmountsRaw: result.assetAmountsRaw.map((a) => a.toString()),
        solLamportsOut: result.solLamportsOut.toString(),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to build the DevNet swap transaction." });
  }
}
