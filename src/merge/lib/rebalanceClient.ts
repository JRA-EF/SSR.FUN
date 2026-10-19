// DEC-0250: the browser side of a REAL Mainnet rebalance. Asks the server to
// build every transaction (api/mainnet/build-rebalance.ts), has the wallet
// sign them all in ONE approval, then submits them in order:
//   targets (if they change) -> each swap -> removal of emptied assets.
// A swap that fails does not stop the others (each is its own atomic
// transaction, and a failed one moves nothing); the removal only runs if
// every sale it depends on landed.
import { VersionedTransaction, type Connection } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { describeOnChainError } from "@ssr/sdk";
import { sendAndConfirmWithRebroadcast } from "./rpcResilience";
import { assertAllSignedBy, assertSignerReady } from "./assertSigner";

export interface RebalanceBuiltTx {
  kind: "targets" | "swap" | "cleanup";
  base64: string;
  bytes: number;
  lastValidBlockHeight: number;
  sellMint?: string;
  buyMint?: string;
  amountInRaw?: string;
  minOutRaw?: string;
  expectedOutRaw?: string;
  usd?: number;
  route?: string[];
  removes?: string[];
  /** Index of the swap this one relies on (first half of a route via a hub). */
  dependsOn?: number;
  via?: string;
}

export interface RebalanceBuild {
  transactions: RebalanceBuiltTx[];
  totalUsd: number;
  rows: { mint: string; valueUsd: number; targetUsd: number; targetBps: number }[];
  skipped: { sellMint: string; buyMint: string; reason: string }[];
}

export type RebalanceStepStatus = "confirmed" | "failed" | "not-sent";

export interface RebalanceRunResult {
  build: RebalanceBuild;
  steps: { tx: RebalanceBuiltTx; status: RebalanceStepStatus; signature?: string; error?: string }[];
}

export type RebalanceProgress =
  | { phase: "building" }
  | { phase: "awaiting-wallet"; count: number }
  | { phase: "submitting"; index: number; count: number; tx: RebalanceBuiltTx };

export async function requestRebalanceBuild(origin: string, body: { reserve: string; signer: string; targets: { mint: string; targetBps: number }[] }): Promise<RebalanceBuild> {
  const res = await fetch(`${origin}/api/mainnet/build-rebalance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as (RebalanceBuild & { error?: string }) | null;
  if (!res.ok || !json || !Array.isArray(json.transactions)) throw new Error(json?.error || `The rebalance could not be prepared (HTTP ${res.status}). Nothing was submitted.`);
  return json;
}

/** Pure: the removal may only be sent when every swap selling one of the assets it removes confirmed. */
export function cleanupAllowed(cleanup: RebalanceBuiltTx, steps: RebalanceRunResult["steps"]): boolean {
  const removes = new Set(cleanup.removes ?? []);
  return steps.filter((s) => s.tx.kind === "swap" && s.tx.sellMint && removes.has(s.tx.sellMint)).every((s) => s.status === "confirmed");
}

export async function executeRealRebalance(params: {
  connection: Connection;
  wallet: WalletContextState;
  reserve: string;
  targets: { mint: string; targetBps: number }[];
  origin: string;
  onProgress?: (p: RebalanceProgress) => void;
}): Promise<RebalanceRunResult> {
  const owner = params.wallet.publicKey;
  if (!owner) throw new Error("Connect a wallet first.");
  params.onProgress?.({ phase: "building" });
  const build = await requestRebalanceBuild(params.origin, { reserve: params.reserve, signer: owner.toBase58(), targets: params.targets });
  if (build.transactions.length === 0) return { build, steps: [] };

  const txs = build.transactions.map((t) => VersionedTransaction.deserialize(Buffer.from(t.base64, "base64")));
  assertSignerReady({ wallet: params.wallet, expectedOwner: owner, action: "rebalance" });
  params.onProgress?.({ phase: "awaiting-wallet", count: txs.length });
  let signed: VersionedTransaction[];
  if (typeof params.wallet.signAllTransactions === "function") {
    signed = await params.wallet.signAllTransactions(txs);
  } else {
    if (!params.wallet.signTransaction) throw new Error("This wallet cannot sign transactions.");
    signed = [];
    for (const tx of txs) signed.push(await params.wallet.signTransaction(tx));
  }
  assertAllSignedBy(signed, owner, params.wallet, (i) => `transaction ${i + 1} of this rebalance`);

  const steps: RebalanceRunResult["steps"] = build.transactions.map((tx) => ({ tx, status: "not-sent" as RebalanceStepStatus }));
  for (let i = 0; i < signed.length; i++) {
    const step = steps[i];
    if (step.tx.kind === "cleanup" && !cleanupAllowed(step.tx, steps)) continue;
    if (step.tx.dependsOn !== undefined && steps[step.tx.dependsOn]?.status !== "confirmed") continue;
    params.onProgress?.({ phase: "submitting", index: i, count: signed.length, tx: step.tx });
    const { signature, outcome } = await sendAndConfirmWithRebroadcast(params.connection, signed[i].serialize(), step.tx.lastValidBlockHeight);
    step.signature = signature;
    if (outcome.status === "confirmed") {
      step.status = "confirmed";
    } else {
      step.status = "failed";
      step.error =
        outcome.status === "failed"
          ? describeOnChainError(new Error(`Transaction failed on-chain (${outcome.error}).`))
          : outcome.status === "expired"
            ? "Expired before it was confirmed; nothing moved."
            : "Could not confirm in time; check the signature on Solscan.";
      // Without the new targets the swaps would aim at the old composition.
      if (step.tx.kind === "targets") break;
    }
  }
  return { build, steps };
}
