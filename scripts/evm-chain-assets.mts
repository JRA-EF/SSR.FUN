// Step 1b of onboarding a chain: turn a list of CANDIDATE assets into a
// verified starter list, without building a catalogue.
//
//   npx tsx scripts/evm-chain-assets.mts scripts/evm-chains/bnb.json
//
// For each candidate it reads, live from the chain: code, symbol(), decimals(),
// and the token's DEEPEST pool against either quote asset, valued in dollars
// by the quote asset actually sitting in that pool (the same depth measure the
// Robinhood catalogue uses). Anything with no code, a symbol that disagrees
// with its label, or depth under `minDepthUsd` is REFUSED and listed. What
// survives is printed as AssetRef entries ready to paste.
//
// This is how a chain with no code-hash anchor for legitimacy (BNB, Base)
// gets a basket list on day one: a human proposes, the chain verifies, and
// nothing unverified can ever be offered. Discovery comes later.
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, fallback, http, parseAbi, zeroAddress, type Address } from "viem";

const file = process.argv[2];
if (!file) throw new Error("Usage: npx tsx scripts/evm-chain-assets.mts <candidates.json>");
const cfg = JSON.parse(readFileSync(file, "utf8"));
// RPCS=a,b,c rotates across endpoints on error (viem fallback) -- a single
// public endpoint throttles a few hundred eth_calls into failures.
const RPCS: string[] = (process.env.RPCS ?? process.env.RPC ?? cfg.rpc).split(",");
const RPC = RPCS[0];
const minDepth: number = Number(process.env.MIN_DEPTH_USD ?? cfg.minDepthUsd ?? 100_000);
const dexName: string = process.env.DEX ?? Object.keys(cfg.candidates.dex)[0];
const dex = cfg.candidates.dex[dexName] as { factory: Address; fees: number[] };
const [usdKey, nativeKey] = cfg.candidates.quotePair as [string, string];

const pc = createPublicClient({
  chain: defineChain({ id: 0, name: cfg.name, nativeCurrency: { name: cfg.native, symbol: cfg.native, decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }),
  transport: RPCS.length > 1 ? fallback(RPCS.map((u) => http(u, { retryCount: 1 }))) : http(RPC),
});
const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const FACTORY = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Patient on purpose: free endpoints throttle in bursts, and an unfinished read
// is UNKNOWN -- it can only be resolved by trying again, never by guessing.
const RETRIES = Number(process.env.RETRIES ?? 7);
async function retry<T>(fn: () => Promise<T>): Promise<T | undefined> {
  for (let i = 0; i < RETRIES; i++) { try { return await fn(); } catch { await sleep(Math.min(8000, 400 * 2 ** i)); } }
  return undefined;
}

const usd = { address: cfg.candidates.tokens[usdKey] as Address, decimals: 0 };
const native = { address: cfg.candidates.tokens[nativeKey] as Address, decimals: 0 };
usd.decimals = Number(await retry(() => pc.readContract({ address: usd.address, abi: ERC20, functionName: "decimals" })));
native.decimals = Number(await retry(() => pc.readContract({ address: native.address, abi: ERC20, functionName: "decimals" })));

/** USD per whole native, from the deepest dollar/native pool's spot. */
async function nativeUsd(): Promise<number> {
  let best = { bal: 0n, px: 0 };
  for (const fee of dex.fees) {
    const pool = await retry(() => pc.readContract({ address: dex.factory, abi: FACTORY, functionName: "getPool", args: [usd.address, native.address, fee] }));
    if (!pool || pool === zeroAddress) continue;
    const bal = (await retry(() => pc.readContract({ address: usd.address, abi: ERC20, functionName: "balanceOf", args: [pool] }))) ?? 0n;
    const s0 = await retry(() => pc.readContract({ address: pool, abi: POOL, functionName: "slot0" }));
    if (!s0 || bal <= best.bal) continue;
    const r = Number(s0[0]) / 2 ** 96;
    const usdIs0 = usd.address.toLowerCase() < native.address.toLowerCase();
    const [d0, d1] = usdIs0 ? [usd.decimals, native.decimals] : [native.decimals, usd.decimals];
    const p1per0 = r * r * 10 ** (d0 - d1);
    best = { bal, px: usdIs0 ? 1 / p1per0 : p1per0 };
  }
  return best.px;
}
const nativePx = await nativeUsd();
console.log(`${cfg.name} via ${dexName}: ${usdKey} + ${nativeKey} @ $${nativePx.toFixed(2)}   floor $${minDepth.toLocaleString()}\n`);

interface Row { label: string; address: Address; symbol?: string; decimals?: number; depthUsd: number; pool?: { address: Address; fee: number; quote: string }; refused?: string; unreadablePools?: number }
const rows: Row[] = [];
for (const [label, address] of Object.entries(cfg.assetCandidates ?? {}) as [string, Address][]) {
  const row: Row = { label, address, depthUsd: 0 };
  const code = await retry(() => pc.getBytecode({ address }));
  if (code === undefined) { row.refused = "unreadable (RPC) -- UNKNOWN, re-run"; rows.push(row); continue; }
  if (!code || code === "0x") { row.refused = "no code at this address on this chain"; rows.push(row); continue; }
  const [symbol, dec] = await Promise.all([
    retry(() => pc.readContract({ address, abi: ERC20, functionName: "symbol" })),
    retry(() => pc.readContract({ address, abi: ERC20, functionName: "decimals" })),
  ]);
  if (symbol === undefined || dec === undefined) { row.refused = "UNREADABLE (RPC failed) -- UNKNOWN, re-run; not a verdict"; rows.push(row); continue; }
  row.symbol = symbol; row.decimals = Number(dec);
  if (symbol.toUpperCase() !== label.toUpperCase()) { row.refused = `symbol() says ${symbol}, not ${label}`; rows.push(row); continue; }

  for (const [qKey, q, qPx] of [[usdKey, usd, 1], [nativeKey, native, nativePx]] as const) {
    if (address.toLowerCase() === q.address.toLowerCase()) continue;
    for (const fee of dex.fees) {
      await sleep(Number(process.env.PACE_MS ?? 150));
      const pool = await retry(() => pc.readContract({ address: dex.factory, abi: FACTORY, functionName: "getPool", args: [address, q.address, fee] }));
      if (pool === undefined) { row.unreadablePools = (row.unreadablePools ?? 0) + 1; continue; }
      if (pool === zeroAddress) continue;
      const bal = await retry(() => pc.readContract({ address: q.address, abi: ERC20, functionName: "balanceOf", args: [pool] }));
      if (bal === undefined) { row.unreadablePools = (row.unreadablePools ?? 0) + 1; continue; }
      const depth = (Number(bal) / 10 ** q.decimals) * qPx;
      if (depth > row.depthUsd) { row.depthUsd = depth; row.pool = { address: pool, fee, quote: qKey }; }
    }
  }
  // Below the floor only counts as a verdict if every pool was actually read.
  if (row.depthUsd < minDepth) row.refused = row.unreadablePools
    ? `UNREADABLE: ${row.unreadablePools} pool read(s) failed, best seen $${Math.round(row.depthUsd).toLocaleString()} -- UNKNOWN, re-run`
    : `depth $${Math.round(row.depthUsd).toLocaleString()} < floor`;
  rows.push(row);
}

rows.sort((a, b) => b.depthUsd - a.depthUsd);
const ok = rows.filter((r) => !r.refused);
console.log("ACCEPTED");
for (const r of ok) console.log(`  ${r.label.padEnd(6)} dec=${String(r.decimals).padStart(2)}  depth $${Math.round(r.depthUsd).toLocaleString().padStart(12)}  via ${r.pool!.quote} fee ${r.pool!.fee}`);
console.log("\nREFUSED");
for (const r of rows.filter((x) => x.refused)) console.log(`  ${r.label.padEnd(6)} ${r.refused}`);

console.log(`\n// ${cfg.name} starter assets -- verified live ${new Date().toISOString().slice(0, 10)} by scripts/evm-chain-assets.mts,`);
console.log(`// each with >= $${minDepth.toLocaleString()} of quote asset in its deepest ${dexName} pool.`);
// The pool each asset is BOUGHT through at launch, by role: "usd" when its
// deepest pool is against the dollar, "native" when against the wrapped native
// (the launch then routes dollar -> native -> token).
console.log("starterAssets: [");
for (const r of ok) {
  const role = r.pool!.quote === usdKey ? "usd" : "native";
  console.log(`  { address: "${r.address}", symbol: "${r.symbol}", decimals: ${r.decimals}, pool: { address: "${r.pool!.address}", fee: ${r.pool!.fee}, quote: "${role}" } },`);
}
console.log("],");
