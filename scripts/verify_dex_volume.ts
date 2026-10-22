// Read-only live check for the DEX volume index (DEC-0254): discovers SSR pools
// on Mainnet and classifies each pool's recent USDC-vault transactions through
// the indexer's own fetch + classify path, without touching the database.
// Usage: HELIUS_URL=<mainnet rpc> npx ts-node -P tests/tsconfig.json scripts/verify_dex_volume.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { discoverSsrPools, fetchVaultViews } from "../lib/dex-volume/indexer";
import { classifyPoolSwap, poolReserves, vaultBalances } from "../lib/dex-volume/classify";

async function main() {
  const connection = new Connection(process.env.HELIUS_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const pools = await discoverSsrPools(connection);
  console.log(`SSR pools found: ${pools.length}`);
  for (const p of pools) {
    console.log(`\npool ${p.pool} reserve ${p.reserve} mint ${p.reserveMint}`);
    const [state, uv, tv] = await connection.getMultipleAccountsInfo([p.pool, p.usdcVault, p.tokenVault].map((k) => new PublicKey(k)));
    const amt = (d: Buffer) => d.readBigUInt64LE(64);
    const [r0, r1] = poolReserves(state!.data, p.usdcIs0 ? amt(uv!.data) : amt(tv!.data), p.usdcIs0 ? amt(tv!.data) : amt(uv!.data));
    const usdc = p.usdcIs0 ? r0 : r1, tokens = p.usdcIs0 ? r1 : r0;
    console.log(`  vault USDC ${Number(amt(uv!.data)) / 1e6}, pool reserves ${Number(usdc) / 1e6} USDC + ${Number(tokens) / 1e6} tokens, price ${(Number(usdc) / Number(tokens)).toFixed(4)}`);
    const sigs = (await connection.getSignaturesForAddress(new PublicKey(p.usdcVault), { limit: 25 })).filter((s) => !s.err).map((s) => s.signature);
    const views = await fetchVaultViews(connection.rpcEndpoint, sigs);
    let volume = 0n;
    for (const signature of sigs) {
      const tx = views.get(signature);
      if (!tx) { console.log(`  ${signature.slice(0, 8)} (failed/missing)`); continue; }
      const u = vaultBalances(tx, p.usdcVault), t = vaultBalances(tx, p.tokenVault), swap = u && t ? classifyPoolSwap(u[0], u[1], t[0], t[1]) : null;
      const when = new Date(tx.blockTime * 1000).toISOString().slice(0, 19);
      console.log(`  ${when} ${signature.slice(0, 8)} ${swap ? `SWAP ${swap.side} ${Number(swap.usdcRaw) / 1e6} USDC` : `skip (usdc ${u ? u[1] - u[0] : "-"}, token ${t ? t[1] - t[0] : "-"})`}`);
      if (swap) volume += swap.usdcRaw;
    }
    console.log(`  swap volume in these ${sigs.length}: ${Number(volume) / 1e6} USDC`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
