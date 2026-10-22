// DEC-0255 read-only check: simulates the keeper's Raydium half of the pool
// leg (swap about half the USDC into Reserve Tokens, then deposit both sides)
// against a LIVE SSR pool on Mainnet, from a wallet that holds USDC. The SSR
// begin/end instructions are not included (they exist only after the
// upgrade); everything here is what lib/mainnet/poolFeed.ts plans and builds.
// Nothing is signed or sent: simulateTransaction with sigVerify off.
// Usage: HELIUS_RPC_URL=<mainnet rpc> npx ts-node -P tests/tsconfig.json scripts/verify_pool_feed_raydium.ts <reserve> <usdc-holder> [usdcRaw]
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { readLiquidityState } from "../lib/mainnet/liquidityLifecycle";
import { buildPoolFeedInstructions, planPoolLeg, poolNavDeviationPct } from "../lib/mainnet/poolFeed";
import { LIQUIDITY_USDC } from "../src/merge/lib/liquidity/raydiumCpmm";

async function main() {
  const [reserveArg, holderArg, amountArg] = process.argv.slice(2);
  const connection = new Connection(process.env.HELIUS_RPC_URL || process.env.HELIUS_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const programId = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
  const reserve = new PublicKey(reserveArg), owner = new PublicKey(holderArg);
  const s = await readLiquidityState({ connection, program: buildReadOnlyProgram(connection) as any, programId }, reserve);
  if (!s.registered) throw new Error("No pool");
  const amount = BigInt(amountArg ?? (s.usdc / 50n).toString());
  console.log(`pool ${s.pool.toBase58()}: ${Number(s.usdc) / 1e6} USDC + ${Number(s.tokens) / 1e6} tokens, LP supply ${s.lpSupply}, price ${(Number(s.usdc) / Number(s.tokens)).toFixed(4)}; NAV deviation at NAV 1.0: ${poolNavDeviationPct(s.usdc, s.tokens, 1)?.toFixed(1)}%`);
  const plan = planPoolLeg(amount, s);
  if (!plan) throw new Error("Leg too small");
  console.log("plan", Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.toString()])));
  // Only the Raydium part: drop begin (index 3) and end (last).
  const all = buildPoolFeedInstructions({ programId, reserve, reserveMint: s.mint, keeper: owner, accounts: { pool: s.pool, ...s.registered }, plan });
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...all.slice(0, 3), ...all.slice(4, 6)];
  const watch = [getAssociatedTokenAddressSync(LIQUIDITY_USDC, owner, true), getAssociatedTokenAddressSync(s.mint, owner, true, TOKEN_2022_PROGRAM_ID), getAssociatedTokenAddressSync(s.lp, owner, true)];
  const before = await connection.getMultipleAccountsInfo(watch, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: watch.map((w) => w.toBase58()) } });
  console.log("err", JSON.stringify(sim.value.err), "units", sim.value.unitsConsumed);
  if (sim.value.err) { console.log((sim.value.logs ?? []).slice(-15).join("\n")); process.exit(1); }
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID];
  sim.value.accounts!.forEach((a, i) => {
    const pre = before[i] ? unpackAccount(watch[i], before[i]!, programs[i]).amount : 0n;
    const post = a ? unpackAccount(watch[i], { ...a, data: Buffer.from(a.data[0], "base64"), owner: new PublicKey(a.owner) } as any, programs[i]).amount : 0n;
    console.log(["USDC", "Reserve Token", "LP"][i], `${pre} -> ${post} (${post - pre >= 0n ? "+" : ""}${post - pre})`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
