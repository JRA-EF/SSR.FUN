// DEC-0238 pre-upgrade check, READ-ONLY: builds the USDC-fee mint transaction
// (mintOnly) for every active Mainnet Reserve with the real server builder and
// reports whether it fits Solana's limits. Signs nothing that is ever sent
// (a throwaway key stands in for the fee quote signer).
//
//   HELIUS_URL=<mainnet rpc> npx ts-node -P scripts/tsconfig.json scripts/check_usdc_fee_mint_fit_mainnet.ts
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildReadOnlyProgram, discoverAllReserves, enumerateReserveAssetMintsOnChain } from "../packages/sdk/src";
import { buildBuyTransactions } from "../lib/mainnet/buildBuy";
import { lookupReserveAlt } from "../api/mainnet/build-buy";

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const WALLET = new PublicKey("EME96L9JK7VQvMg76txApB8Kb9npdyUfFcpQKDqYupmq");

async function main() {
  const connection = new Connection(process.env.HELIUS_URL!, "confirmed");
  const program = buildReadOnlyProgram(connection) as any;
  const mints = (await enumerateReserveAssetMintsOnChain(connection)).map((m) => new PublicKey(m));
  const { reserves } = await discoverAllReserves(connection, PROGRAM_ID, mints);
  const signer = Keypair.generate();
  let ok = 0;
  let bad = 0;
  for (const r of reserves.filter((x) => x.status === "active" && BigInt(x.reserveTokenSupplyRaw) > 0n)) {
    const supply = BigInt(r.reserveTokenSupplyRaw);
    try {
      const out = await buildBuyTransactions(
        {
          connection, program, ssrProgramId: PROGRAM_ID, jupiterApiKey: "", fetchPrices: async (ms: string[]) => new Map(ms.map((m) => [m, { usdPrice: 1 }])), // size check only: prices change the fee amount, never the transaction size
          jupiterQuote: async () => { throw new Error("no quotes in mintOnly"); },
          jupiterBuildTransaction: async () => { throw new Error("no builds in mintOnly"); },
          jupiterBuildInstructions: async () => { throw new Error("no builds in mintOnly"); },
          lookupReserveAlt: (x) => lookupReserveAlt(x).catch(() => null), feeQuoteSigner: signer,
        },
        { reserve: new PublicKey(r.reserve), wallet: WALLET, reserveTokensRequested: supply / 1000n > 0n ? supply / 1000n : 1n, slippageBps: 200, assetMints: r.assets.map((a) => new PublicKey(a.assetMint)), acquiredRawByMint: {}, legsOnly: null, mintOnly: true },
      );
      const mint = out.transactions[out.transactions.length - 1];
      const tx = VersionedTransaction.deserialize(Buffer.from(mint.base64, "base64"));
      const keys = tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((s, l) => s + l.writableIndexes.length + l.readonlyIndexes.length, 0);
      console.log(`ok   #${r.reserveId} ${r.assets.length} assets: ${mint.kind} ${mint.bytes} B, ${keys} accounts, table ${out.reserveAlt ? "registered" : out.altToRegister ? "would be created" : "none"}, fee ${(Number(out.plan.usdcMintFeeRaw) / 1e6).toFixed(6)} USDC on $${(Number(out.plan.depositValueUsdcRaw) / 1e6).toFixed(4)}`);
      ok++;
    } catch (e) {
      console.log(`FAIL #${r.reserveId} ${r.assets.length} assets: ${e instanceof Error ? e.message : String(e)}`);
      bad++;
    }
  }
  console.log(`${ok} fit, ${bad} failed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
