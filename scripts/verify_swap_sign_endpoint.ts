import * as fs from "fs";
import * as path from "path";
import { Keypair, Transaction } from "@solana/web3.js";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  path.resolve(__dirname, "..", "devnet-fixtures", "manager-keypair.json"),
  "utf-8",
);

import handler from "../api/devnet/swap-sign";
import { DEVNET_FIXTURES } from "../packages/sdk/src";

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
  const user = Keypair.generate();

  const req = {
    method: "POST",
    headers: {},
    body: {
      action: "buy",
      reserve: DEVNET_FIXTURES.reserveOne.reserve,
      userPubkey: user.publicKey.toBase58(),
      solLamports: "1000000", // 0.001 SOL
    },
  };
  const res = mockRes();
  await handler(req as any, res as any);
  console.log("status:", res._state.statusCode);
  console.log("body keys:", Object.keys(res._state.body as object));
  const body = res._state.body as { transactionBase64?: string; quote?: unknown; error?: string };
  if (body.error) {
    console.log("ERROR:", body.error);
    return;
  }
  console.log("quote:", body.quote);

  const txBytes = Buffer.from(body.transactionBase64!, "base64");
  const tx = Transaction.from(txBytes);
  console.log("num instructions:", tx.instructions.length);
  console.log("signatures present:", tx.signatures.map((s) => ({ pubkey: s.publicKey.toBase58(), hasSig: s.signature !== null })));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
