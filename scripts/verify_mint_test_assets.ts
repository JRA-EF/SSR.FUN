import * as fs from "fs";
import { Keypair, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";

process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = fs.readFileSync(
  "C:\\Users\\JRA DEVNET\\Projects\\SSR.FUN\\devnet-fixtures\\manager-keypair.json",
  "utf-8",
);

import handler from "../api/devnet/mint-test-assets";
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
  console.log("Test user:", user.publicKey.toBase58());

  const req = {
    method: "POST",
    headers: {},
    body: {
      userPubkey: user.publicKey.toBase58(),
      mints: [
        { mint: DEVNET_FIXTURES.mints.mintX.address, rawAmount: String(5 * 10 ** DEVNET_FIXTURES.mints.mintX.decimals) },
        { mint: DEVNET_FIXTURES.mints.mintZ.address, rawAmount: String(3 * 10 ** DEVNET_FIXTURES.mints.mintZ.decimals) },
      ],
    },
  };
  const res = mockRes();
  await handler(req as any, res as any);
  console.log("status:", res._state.statusCode);
  console.log("body:", res._state.body);

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const { PublicKey } = await import("@solana/web3.js");
  const ataX = getAssociatedTokenAddressSync(new PublicKey(DEVNET_FIXTURES.mints.mintX.address), user.publicKey);
  const ataZ = getAssociatedTokenAddressSync(new PublicKey(DEVNET_FIXTURES.mints.mintZ.address), user.publicKey);
  const accX = await getAccount(connection, ataX);
  const accZ = await getAccount(connection, ataZ);
  console.log("user mintX balance:", accX.amount.toString());
  console.log("user mintZ balance:", accZ.amount.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
