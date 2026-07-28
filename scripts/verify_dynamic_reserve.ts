import * as fs from "fs";
import * as path from "path";
import { Transaction } from "@solana/web3.js";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import handler from "../api/devnet/swap-sign";

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

async function main() {
  // The REAL Reserve the user created live through the frontend before this fix.
  const req = {
    method: "POST",
    headers: {},
    body: {
      action: "buy",
      reserve: "Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX",
      assetMints: ["2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu"],
      userPubkey: "9tBqDrug9x63YyUZAR6vkSq8TkqRwysg6oTESQSNuy5k",
      solLamports: "1000000",
    },
  };
  const res = mockRes();
  await handler(req as any, res as any);
  console.log("status:", res._state.statusCode);
  const body = res._state.body as any;
  if (body.error) {
    console.log("ERROR:", body.error);
    return;
  }
  console.log("quote:", body.quote);
  const tx = Transaction.from(Buffer.from(body.transactionBase64, "base64"));
  console.log("num instructions:", tx.instructions.length);
  console.log("signatures:", tx.signatures.map((s) => ({ pubkey: s.publicKey.toBase58(), hasSig: s.signature !== null })));

  // Also test rejecting an unsupported asset mint (a random unrelated mint).
  console.log("\n--- unsupported asset mint rejection test ---");
  const req2 = {
    method: "POST",
    headers: {},
    body: {
      action: "buy",
      reserve: "Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX",
      assetMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], // USDC devnet mint, NOT registered on this reserve and NOT allowed
      userPubkey: "9tBqDrug9x63YyUZAR6vkSq8TkqRwysg6oTESQSNuy5k",
      solLamports: "1000000",
    },
  };
  const res2 = mockRes();
  await handler(req2 as any, res2 as any);
  console.log("status:", res2._state.statusCode, "body:", res2._state.body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
