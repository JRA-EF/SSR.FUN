// Step 1 of onboarding an EVM chain: turn a list of CANDIDATE addresses into
// verified facts, and print a ChainConfig block ready to paste into
// src/merge/lib/evmChain.ts.
//
//   npx tsx scripts/evm-chain-probe.mts scripts/evm-chains/base.json
//
// Nothing here is trusted from memory or copied between chains. Two addresses
// that "looked right" for Uniswap on BNB turned out to hold zero bytes of
// code; a dollar that is 6 decimals everywhere else is 18 there. Both were
// caught by running exactly this, and both would have been live defects.
//
// It reads only. No key, no deployment, no funds, and it runs against the
// real chain rather than a fork.
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, http, parseAbi, zeroAddress, type Address } from "viem";

interface DexCandidate { factory: Address; quoter: Address; router: Address; fees: number[] }
interface ChainCandidates {
  name: string;
  rpc: string;
  native: string;
  candidates: {
    dex: Record<string, DexCandidate>;
    tokens: Record<string, Address>;
    /** [dollar, wrapped-native] -- the pair every price routes through. */
    quotePair: [string, string];
  };
}

const file = process.argv[2];
if (!file) throw new Error("Usage: npx tsx scripts/evm-chain-probe.mts <candidates.json>");
const cfg = JSON.parse(readFileSync(file, "utf8")) as ChainCandidates;

const pc = createPublicClient({
  chain: defineChain({
    id: 0, name: cfg.name,
    nativeCurrency: { name: cfg.native, symbol: cfg.native, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  }),
  transport: http(cfg.rpc),
});

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const FACTORY = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL = parseAbi(["function liquidity() view returns (uint128)"]);

const problems: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Public RPCs rate-limit and occasionally just fail. A read that errors is
 * UNKNOWN, never "absent": reporting a contract as missing because an endpoint
 * was busy is exactly how a correct address gets wrongly discarded.
 */
async function retry<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  for (let i = 0; i < 4; i++) {
    try { return await fn(); } catch { await sleep(400 * (i + 1)); }
  }
  problems.push(`could not read ${what} -- the RPC failed, so this is UNKNOWN, not absent. Re-run, ideally against a keyed endpoint.`);
  return undefined;
}

const codeSize = async (a: Address): Promise<number | undefined> => {
  const code = await retry(`code at ${a}`, () => pc.getBytecode({ address: a }));
  return code === undefined ? undefined : (code ?? "0x").length / 2 - 1;
};

const chainId = await pc.getChainId();
console.log(`${cfg.name}: chain ${chainId}, block ${await pc.getBlockNumber()}\n`);

// --- tokens: symbol and, above all, DECIMALS -------------------------------
console.log("TOKENS");
const tokenFacts: Record<string, { address: Address; symbol: string; decimals: number }> = {};
for (const [label, address] of Object.entries(cfg.candidates.tokens)) {
  const size = await codeSize(address);
  if (size === undefined) { console.log(`  ${label.padEnd(6)} UNREADABLE at ${address}`); continue; }
  if (size === 0) { console.log(`  ${label.padEnd(6)} NO CODE at ${address}`); problems.push(`${label} has no code`); continue; }
  try {
    const [symbol, decimals] = await Promise.all([
      pc.readContract({ address, abi: ERC20, functionName: "symbol" }),
      pc.readContract({ address, abi: ERC20, functionName: "decimals" }),
    ]);
    tokenFacts[label] = { address, symbol, decimals: Number(decimals) };
    const flag = label !== symbol ? `  (LABEL SAYS ${label})` : "";
    const dec = Number(decimals) !== 6 && /^(USD|DAI)/i.test(symbol) ? `  <-- NOT 6 decimals; size everything from this` : "";
    console.log(`  ${label.padEnd(6)} ${symbol.padEnd(6)} decimals=${String(decimals).padStart(2)}  ${size} bytes${flag}${dec}`);
    if (label !== symbol) problems.push(`${label} actually reports symbol ${symbol}`);
  } catch {
    console.log(`  ${label.padEnd(6)} did not answer symbol()/decimals()`);
    problems.push(`${label} is not a readable ERC20`);
  }
}

// --- DEX candidates: which exist, and which market is deeper ---------------
const [dollarKey, nativeKey] = cfg.candidates.quotePair;
const dollar = tokenFacts[dollarKey], wrapped = tokenFacts[nativeKey];
let best: { name: string; dex: DexCandidate; liq: bigint; fees: number[] } | null = null;

for (const [name, dex] of Object.entries(cfg.candidates.dex)) {
  console.log(`\nDEX ${name}`);
  const sizes = { factory: await codeSize(dex.factory), quoter: await codeSize(dex.quoter), router: await codeSize(dex.router) };
  for (const [role, size] of Object.entries(sizes)) {
    const shown = size === undefined ? "UNREADABLE" : size === 0 ? "NO CODE" : `${size} bytes`;
    console.log(`  ${role.padEnd(8)} ${shown.padStart(10)}  ${dex[role as keyof DexCandidate]}`);
    if (size === 0) problems.push(`${name}.${role} has no code on this chain -- do not copy addresses between chains`);
  }
  if (!sizes.factory || !dollar || !wrapped) continue;

  console.log(`  ${dollar.symbol}/${wrapped.symbol} pools:`);
  const live: number[] = [];
  let deepest = 0n;
  for (const fee of dex.fees) {
    await sleep(120); // pace: public endpoints throttle a burst of eth_calls
    const pool = (await retry(`${name} getPool fee=${fee}`, () =>
      pc.readContract({ address: dex.factory, abi: FACTORY, functionName: "getPool", args: [dollar.address, wrapped.address, fee] }),
    )) as Address | undefined;
    if (pool === undefined) { console.log(`    fee ${String(fee).padStart(5)}  unreadable`); continue; }
    if (pool === zeroAddress) { console.log(`    fee ${String(fee).padStart(5)}  none`); continue; }
    const liq = ((await retry(`liquidity of ${pool}`, () => pc.readContract({ address: pool, abi: POOL, functionName: "liquidity" }))) ?? 0n) as bigint;
    console.log(`    fee ${String(fee).padStart(5)}  ${pool}  liquidity ${liq}`);
    if (liq > 0n) live.push(fee);
    if (liq > deepest) deepest = liq;
  }
  if (deepest === 0n) { problems.push(`${name} has no ${dollar.symbol}/${wrapped.symbol} pool with liquidity`); continue; }
  if (!best || deepest > best.liq) best = { name, dex, liq: deepest, fees: live };
}

// --- the answer, ready to paste -------------------------------------------
console.log("\n" + "-".repeat(70));
if (!best || !dollar || !wrapped) {
  console.log("NO USABLE DEX FOUND. Fix the problems below before going further.");
} else {
  console.log(`Deepest market: ${best.name} (liquidity ${best.liq})\n`);
  console.log(`  // ${cfg.name} -- every address below read live from chain ${chainId} on ${new Date().toISOString().slice(0, 10)}.`);
  console.log(`  dex: {`);
  console.log(`    factory: "${best.dex.factory}",`);
  console.log(`    quoter: "${best.dex.quoter}",`);
  console.log(`    router: "${best.dex.router}",`);
  console.log(`    fees: [${best.dex.fees.join(", ")}],   // tiers with live pools: ${best.fees.join(", ") || "none"}`);
  console.log(`  },`);
  console.log(`  quotes: {`);
  console.log(`    usd: { address: "${dollar.address}", symbol: "${dollar.symbol}", decimals: ${dollar.decimals} },`);
  console.log(`    native: { address: "${wrapped.address}", symbol: "${wrapped.symbol}", decimals: ${wrapped.decimals} },`);
  console.log(`  },`);
}

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S) -- none of these are safe to ignore:`);
  for (const p of problems) console.log(`  - ${p}`);
}
process.exit(best ? 0 : 1);
