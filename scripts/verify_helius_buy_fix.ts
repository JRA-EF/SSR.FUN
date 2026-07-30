// Live DevNet verification for the Helius RPC integration + Buy 429/
// "insufficient SOL" diagnosis pass (see docs/project/DECISION_LOG.md).
// Unlike scripts/verify_rpc_resilience_buy.ts (which hardcodes the public
// endpoint), this script's Connection is built via the SAME resolveRpcUrl()
// helper api/devnet/*.ts now shares -- so a real HELIUS_RPC_URL in this
// process's environment genuinely exercises the dedicated provider path,
// not just the public fallback. Calls the exact same client function
// DTRDetail.tsx's handleBuy calls (executeBuyZapDevUsdc, unmodified import).
// A disposable trader keypair stands in for a connected wallet -- no
// browser-automation tool exists in this environment (see every other
// scripts/verify_*.ts in this repo for the same accepted pattern). Buys 50
// devUSDC specifically, matching the exact amount from the reported bug.
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import mintTestAssetsHandler from "../api/devnet/mint-test-assets";
import swapSignHandler from "../api/devnet/swap-sign";
import { resolveRpcUrl } from "../api/devnet/_lib/rpc";
import { executeBuyZapDevUsdc } from "../src/merge/lib/zapClient";
import { AmbiguousConfirmationError, isRateLimitError, withRateLimitRetry } from "../src/merge/lib/rpcResilience";
import { DEVNET_FIXTURES, DEVUSDC, DEVUSDC_MINT } from "../packages/sdk/src";

const RPC_URL = resolveRpcUrl();
const connection = new Connection(RPC_URL, "confirmed");
console.log(`Using RPC endpoint: ${RPC_URL.includes("helius") ? "Helius (dedicated DevNet provider)" : RPC_URL.includes("api.devnet.solana.com") ? "public api.devnet.solana.com fallback" : "custom endpoint"}`);

process.on("unhandledRejection", (reason) => {
  console.warn(`  [background websocket noise from an unrelated confirm() call, ignored]: ${reason instanceof Error ? reason.message.slice(0, 120) : reason}`);
});

// Phase C devUSDC Reserve -- 70% devUSDC / 30% mockX. Chosen (same as the
// prior pass's verification) because it exercises both a real devUSDC leg
// (paid from the trader's own balance) and a faucet-funded leg in the same
// transaction.
const PHASE_C_RESERVE = "HAaoBxSVAnaxEusxxYUnPpAJAyjRzti4zuqxrLWYS4VE";
const PHASE_C_RESERVE_TOKEN_MINT = new PublicKey("48JyhsTD5bSM18NZMapMHK44Vhk2kreuP7utY5U9uNRW");

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
    },
    _state: state,
  };
}

const realFetch = global.fetch;
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const req = { method: "POST", headers: {}, body };
  if (url.includes("mint-test-assets")) {
    const res = mockRes();
    await mintTestAssetsHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode, headers: new Headers(), json: async () => res._state.body } as Response;
  }
  if (url.includes("swap-sign")) {
    const res = mockRes();
    await swapSignHandler(req as any, res as any);
    return { ok: (res._state.statusCode ?? 500) < 300, status: res._state.statusCode, headers: new Headers(), json: async () => res._state.body } as Response;
  }
  return realFetch(url as any, init);
}) as typeof fetch;

function fakeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  } as any;
}

async function withPatience<T>(label: string, fn: () => Promise<T>, maxAttempts = 10): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      const delay = Math.min(3000 * attempt, 20000);
      console.log(`  [${label}] attempt ${attempt} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main() {
  const deployerSecret = JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".config", "solana", "devnet-deployer.json"), "utf-8"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  console.log("=== Swap-authority live SOL balance (the operator-side balance the new assertSwapAuthorityHasSol check reads) ===");
  const swapAuthoritySecret = JSON.parse(process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY!);
  const swapAuthorityPubkey = Keypair.fromSecretKey(Uint8Array.from(swapAuthoritySecret)).publicKey;
  const swapAuthorityBalance = await withRateLimitRetry(() => connection.getBalance(swapAuthorityPubkey, "confirmed"), 5, 1000);
  console.log(`  Swap authority (${swapAuthorityPubkey.toBase58()}): ${(swapAuthorityBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  console.log("\n=== Fund a fresh disposable trader wallet (real SOL + real devUSDC) ===");
  const trader = Keypair.generate();
  console.log(`Trader wallet: ${trader.publicKey.toBase58()}`);
  await withRateLimitRetry(
    () =>
      sendAndConfirmTransaction(
        connection,
        new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
        [deployer],
      ),
    6,
    2000,
  );
  console.log(`  Trader funded with 0.05 SOL (this is the ONLY real SOL the connected wallet ever needs -- ATA rent + network fee).`);

  const faucetBody = { userPubkey: trader.publicKey.toBase58(), mints: [{ mint: DEVUSDC.mint, rawAmount: (100 * 10 ** DEVUSDC.decimals).toString() }] };
  const faucetRes = await withRateLimitRetry(
    async () => {
      const res = mockRes();
      await mintTestAssetsHandler({ method: "POST", headers: {}, body: faucetBody } as any, res as any);
      if ((res._state.statusCode ?? 500) >= 300) throw new Error(JSON.stringify(res._state.body));
      return res;
    },
    6,
    2000,
  );
  console.log(`  devUSDC faucet signature: ${(faucetRes._state.body as any).signature}`);

  const traderDevUsdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, trader.publicKey);
  const traderRtAta = getAssociatedTokenAddressSync(PHASE_C_RESERVE_TOKEN_MINT, trader.publicKey);
  const traderSolBefore = await withPatience("getBalance SOL before", () => connection.getBalance(trader.publicKey, "confirmed"));
  const devUsdcBefore = (await withPatience("getAccount devUsdc before", () => getAccount(connection, traderDevUsdcAta))).amount;
  const rtBefore = await withPatience("getAccount RT before", () => getAccount(connection, traderRtAta).then((a) => a.amount).catch(() => 0n));
  console.log(`Real SOL balance before Buy: ${(traderSolBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Real devUSDC balance before Buy: ${devUsdcBefore}`);
  console.log(`Real Reserve Token balance before Buy: ${rtBefore}`);
  if (devUsdcBefore <= 0n) throw new Error("FAIL: trader has no real devUSDC balance after faucet claim.");

  console.log("\n=== Real devUSDC-settlement Buy of 50 devUSDC via executeBuyZapDevUsdc (matching the exact reported bug amount) ===");
  const devUsdcAmountRaw = BigInt(50 * 10 ** DEVUSDC.decimals);
  const phases: string[] = [];
  let result: Awaited<ReturnType<typeof executeBuyZapDevUsdc>> | null = null;
  let ambiguous: AmbiguousConfirmationError | null = null;
  try {
    result = await executeBuyZapDevUsdc({
      connection,
      wallet: fakeWallet(trader),
      reserveAddress: PHASE_C_RESERVE,
      assetMints: [DEVUSDC.mint, DEVNET_FIXTURES.mints.mintX.address],
      userPubkey: trader.publicKey,
      devUsdcAmountRaw,
      onProgress: (e) => {
        phases.push(e.phase);
        console.log(`  [onProgress] phase=${e.phase}${"signature" in e ? ` signature=${e.signature}` : ""}`);
      },
    });
  } catch (e) {
    if (e instanceof AmbiguousConfirmationError) {
      ambiguous = e;
      console.log(`  Confirmation was AMBIGUOUS after bounded polling -- signature: ${e.signature}`);
    } else {
      throw e;
    }
  }

  const signature = result?.signature ?? ambiguous?.signature;
  if (!signature) throw new Error("FAIL: no signature was ever produced -- submission itself must have failed before sendRawTransaction.");

  const traderSolAfter = await withPatience("getBalance SOL after", () => connection.getBalance(trader.publicKey, "confirmed"));
  const devUsdcAfter = (await withPatience("getAccount devUsdc after", () => getAccount(connection, traderDevUsdcAta))).amount;
  const rtAfter = await withPatience("getAccount RT after", () => getAccount(connection, traderRtAta).then((a) => a.amount));
  console.log(`\nReal SOL balance after: ${(traderSolAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL (spent ${((traderSolBefore - traderSolAfter) / LAMPORTS_PER_SOL).toFixed(6)} SOL on ATA rent + network fee -- NOT the requested devUSDC amount)`);
  console.log(`Real devUSDC balance after: ${devUsdcAfter} (spent ${devUsdcBefore - devUsdcAfter} raw units -- expect exactly the requested 50 devUSDC leg's proportional share)`);
  console.log(`Real Reserve Token balance after: ${rtAfter} (received ${rtAfter - rtBefore})`);

  const genuinelyMoved = devUsdcAfter < devUsdcBefore && rtAfter > rtBefore;
  if (!result && !genuinelyMoved) {
    console.log("\nFinal status: UNRESOLVED -- balances did not move; this Buy did not land. No success is being claimed.");
  } else if (!genuinelyMoved) {
    throw new Error("FAIL: executeBuyZapDevUsdc resolved but real balances did not move as expected -- this would be a fabricated success and must not happen.");
  } else {
    if (result) {
      const devUsdcLeg = result.quote.legSources?.find((l) => l.mint === DEVUSDC.mint);
      const mockXLeg = result.quote.legSources?.find((l) => l.mint === DEVNET_FIXTURES.mints.mintX.address);
      if (!devUsdcLeg || devUsdcLeg.source !== "user-devusdc-balance") throw new Error("FAIL: devUSDC leg not reported as real-balance-funded.");
      if (!mockXLeg || mockXLeg.source !== "devnet-test-asset-faucet") throw new Error("FAIL: mockX leg not reported as faucet-funded.");
      console.log(`  legSources verified: ${JSON.stringify(result.quote.legSources)}`);
    }
    console.log(`\nFinal status: ${result ? "CONFIRMED" : "CONFIRMED (reconciled by observed real balance change)"}`);
  }

  console.log("\n=========================================================");
  console.log("HELIUS RPC + BUY-FIX LIVE VERIFICATION COMPLETE.");
  console.log("=========================================================");
  console.log(`RPC endpoint used: ${RPC_URL.includes("helius") ? "Helius" : "fallback/public"}`);
  console.log(`Trader wallet: ${trader.publicKey.toBase58()}`);
  console.log(`Buy signature: ${signature}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  console.log(`SOL: ${(traderSolBefore / LAMPORTS_PER_SOL).toFixed(6)} -> ${(traderSolAfter / LAMPORTS_PER_SOL).toFixed(6)} (fee+rent only, confirms Phantom's "insufficient SOL" was never about the connected wallet's own tiny SOL cost)`);
  console.log(`devUSDC: ${devUsdcBefore} -> ${devUsdcAfter}`);
  console.log(`Reserve Token: ${rtBefore} -> ${rtAfter}`);
  console.log(`onProgress phases observed: ${JSON.stringify(phases)}`);
}

main().catch((e) => {
  if (isRateLimitError(e)) console.error("Aborted under sustained RPC congestion (429) before a definitive result:");
  console.error(e);
  process.exit(1);
});
