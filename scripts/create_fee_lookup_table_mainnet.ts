// DEC-0238, one-off: creates the protocol-wide lookup table every USDC-fee mint
// and seed transaction compiles against, holding the fixed fee accounts, then
// FREEZES it so nobody (including the deployer) can ever change or close it.
//
//   HELIUS_URL=<mainnet rpc> npx ts-node -P scripts/tsconfig.json scripts/create_fee_lookup_table_mainnet.ts
import * as fs from "fs";
import * as os from "os";
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { USDC_FEE_LOOKUP_TABLE_ADDRESSES } from "../lib/mainnet/feeLookupTable";

async function send(connection: Connection, payer: Keypair, ixs: TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 5 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  const connection = new Connection(process.env.HELIUS_URL!, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/mainnet-deployer.json`, "utf8"))));
  const addresses = USDC_FEE_LOOKUP_TABLE_ADDRESSES;
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot });
  const extendIx = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses });
  console.log("table", table.toBase58(), "create+extend", await send(connection, payer, [createIx, extendIx]));
  const freezeIx = AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: payer.publicKey });
  console.log("freeze", await send(connection, payer, [freezeIx]));
  const state = (await connection.getAddressLookupTable(table)).value!;
  console.log("frozen:", state.state.authority === undefined, "addresses:", state.state.addresses.map((a) => a.toBase58()));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
