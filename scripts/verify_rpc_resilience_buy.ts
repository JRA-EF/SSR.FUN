// Live DevNet verification for the Buy/confirmation RPC-resilience pass (see
// docs/project/PROJECT_STATUS.md). Calls the EXACT same client function
// DTRDetail.tsx's handleBuy calls (executeBuyZapDevUsdc from
// src/merge/lib/zapClient.ts, unmodified import) -- the closest available
// production-equivalent path, since no browser-automation tool exists in
// this environment (confirmed repeatedly across this project's prior
// verification passes). A disposable trader keypair stands in for a
// connected wallet, exactly like every other scripts/verify_*.ts in this
// repo. Records: the real signature, its Explorer link, real devUSDC/Reserve
// Token balances before and after, the onProgress phase transitions the new
// UI states are driven by, and the final confirmation outcome -- never
// fabricated.
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
import { executeBuyZapDevUsdc } from "../src/merge/lib/zapClient";
import { AmbiguousConfirmationError, isRateLimitError, withRateLimitRetry } from "../src/merge/lib/rpcResilience";
import { DEVNET_FIXTURES, DEVUSDC, DEVUSDC_MINT } from "../packages/sdk/src";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// The devUSDC faucet call (api/devnet/mint-test-assets.ts, unrelated
// test-scaffolding infrastructure, out of this pass's scope) still confirms
// via @solana/web3.js's websocket-subscription strategy internally --
// observed, repeatedly, to leave a background reconnect attempt that
// rejects OUTSIDE any promise this script awaits once the public DevNet RPC
// is this congested, crashing the process via an unhandled rejection even
// though the actual awaited call it came from already resolved
// successfully. This guard only stops that background noise from crashing
// the verification script; it changes nothing about the Buy/confirmation
// code path actually being verified below (which no longer uses
// confirmTransaction's websocket strategy at all -- see rpcResilience.ts's
// confirmSignatureBounded).
process.on("unhandledRejection", (reason) => {
  console.warn(`  [background websocket noise from an unrelated confirm() call, ignored]: ${reason instanceof Error ? reason.message.slice(0, 120) : reason}`);
});

// Phase C devUSDC Reserve -- 70% devUSDC / 30% mockX, one of the 5 documented
// genuine Reserves. Chosen because it exercises BOTH a real devUSDC leg
// (paid from the trader's own balance) and a faucet-funded leg in the same
// transaction, the exact mixed-mode design this pass's Buy path relies on.
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

/** Read-only balance check, generously retried under the confirmed sustained public-RPC congestion -- never used around the actual Buy submission itself. */
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

  console.log("=== Fund a fresh disposable trader wallet (real SOL + real devUSDC) ===");
  const trader = Keypair.generate();
  console.log(`Trader wallet: ${trader.publicKey.toBase58()}`);
  // This is throwaway test scaffolding (a fresh disposable keypair's initial
  // SOL funding from the deployer), not the Buy path under test -- safe to
  // retry as a whole under sustained 429s, unlike a real user's Buy
  // submission (see rpcResilience.ts's docs on why THAT is never retried).
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

  // Same reasoning as the SOL funding above -- this is a one-time
  // test-scaffolding faucet claim for a fresh wallet, not the Buy path
  // itself; a failure here (e.g. "failed to get recent blockhash: 429")
  // means nothing was submitted, so retrying the whole call is safe.
  const faucetBody = { userPubkey: trader.publicKey.toBase58(), mints: [{ mint: DEVUSDC.mint, rawAmount: (20 * 10 ** DEVUSDC.decimals).toString() }] };
  const faucetRes = await withRateLimitRetry(
    async () => {
      const res = mockRes();
      await mintTestAssetsHandler({ method: "POST", headers: {}, body: faucetBody } as any, res as any);
      if ((res._state.statusCode ?? 500) >= 300) throw new Error(JSON.stringify(res._state.body)); // re-thrown verbatim so isRateLimitError only matches a genuine 429 in the underlying message, not a real validation failure
      return res;
    },
    6,
    2000,
  );
  console.log(`  devUSDC faucet signature: ${(faucetRes._state.body as any).signature}`);

  const traderDevUsdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, trader.publicKey);
  const traderRtAta = getAssociatedTokenAddressSync(PHASE_C_RESERVE_TOKEN_MINT, trader.publicKey);
  const devUsdcBefore = (await withPatience("getAccount devUsdc before", () => getAccount(connection, traderDevUsdcAta))).amount;
  const rtBefore = await withPatience("getAccount RT before", () => getAccount(connection, traderRtAta).then((a) => a.amount).catch(() => 0n));
  console.log(`Real devUSDC balance before Buy: ${devUsdcBefore}`);
  console.log(`Real Reserve Token balance before Buy: ${rtBefore}`);
  if (devUsdcBefore <= 0n) throw new Error("FAIL: trader has no real devUSDC balance after faucet claim.");

  console.log("\n=== Real devUSDC-settlement Buy via executeBuyZapDevUsdc (the exact function DTRDetail.tsx calls) ===");
  const devUsdcAmountRaw = BigInt(5 * 10 ** DEVUSDC.decimals);
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
      console.log("  This is the honest 'unknown' outcome the pass is designed to surface, not a fabricated failure. Reconciling via a real balance re-check...");
    } else {
      throw e;
    }
  }

  const signature = result?.signature ?? ambiguous?.signature;
  if (!signature) throw new Error("FAIL: no signature was ever produced -- submission itself must have failed before sendRawTransaction.");

  const devUsdcAfter = (await withPatience("getAccount devUsdc after", () => getAccount(connection, traderDevUsdcAta))).amount;
  const rtAfter = await withPatience("getAccount RT after", () => getAccount(connection, traderRtAta).then((a) => a.amount));
  console.log(`\nReal devUSDC balance after: ${devUsdcAfter} (spent ${devUsdcBefore - devUsdcAfter})`);
  console.log(`Real Reserve Token balance after: ${rtAfter} (received ${rtAfter - rtBefore})`);

  const genuinelyMoved = devUsdcAfter < devUsdcBefore && rtAfter > rtBefore;
  const finalStatus = result ? "confirmed" : genuinelyMoved ? "confirmed (reconciled by observed real balance change after an ambiguous RPC response)" : "unresolved";

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
    console.log(`\nFinal status: ${finalStatus.toUpperCase()}`);
  }

  console.log("\n=========================================================");
  console.log("BUY/CONFIRMATION RPC-RESILIENCE LIVE VERIFICATION COMPLETE.");
  console.log("=========================================================");
  console.log(`Trader wallet: ${trader.publicKey.toBase58()}`);
  console.log(`Signature: ${signature}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  console.log(`devUSDC before -> after: ${devUsdcBefore} -> ${devUsdcAfter}`);
  console.log(`Reserve Token before -> after: ${rtBefore} -> ${rtAfter}`);
  console.log(`onProgress phases observed: ${JSON.stringify(phases)}`);
  console.log(`Final status: ${finalStatus}`);
}

main().catch((e) => {
  if (isRateLimitError(e)) console.error("Aborted under sustained RPC congestion (429) before a definitive result:");
  console.error(e);
  process.exit(1);
});
