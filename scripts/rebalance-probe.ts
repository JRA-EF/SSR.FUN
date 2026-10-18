// DEC-0250: READ-ONLY. Prints whether the deployed Mainnet program has the
// rebalance swap instruction yet (see isRebalanceSwapLive), plus a control
// probe of an instruction that certainly exists. Usage:
//   ENV_FILE=../SSR.FUN/.env.local npx tsx scripts/rebalance-probe.ts
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Connection, PublicKey, TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { isRebalanceSwapLive } from "../lib/mainnet/buildRebalance";
import { compileV0, MAINNET_TREASURY_VAULT } from "../lib/mainnet/buildCommon";

const env = Object.fromEntries(
  fs
    .readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);
const PROGRAM = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const PAYER = new PublicKey(MAINNET_TREASURY_VAULT);
const connection = new Connection(env.HELIUS_MAINNET_RPC_URL, "confirmed");
const sim = async (tx: VersionedTransaction) => ({ err: (await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })).value.err });

(async () => {
  console.log("rebalance_swap live on Mainnet:", await isRebalanceSwapLive(sim, PAYER, PROGRAM));
  const data = createHash("sha256").update("global:update_targets").digest().subarray(0, 8);
  const tx = compileV0(PAYER, "11111111111111111111111111111111", [new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from(data) })], []);
  console.log("control, update_targets (exists):", JSON.stringify((await sim(tx)).err));
  const bogus = compileV0(PAYER, "11111111111111111111111111111111", [new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.alloc(8, 7) })], []);
  console.log("control, made-up instruction:", JSON.stringify((await sim(bogus)).err));
})();
