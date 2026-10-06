// The Launch button, end to end, on a fork: the form's own planLaunch ->
// quoteLaunch -> executeLaunch against a chain's REAL ChainConfig (its
// verified starter assets, its DEX, its 18-decimal dollar), with only the
// freshly forked stack's addresses swapped in.
//
// verify_evm_chain_fork.mts proves the pieces; this proves the sequence a
// creator's click actually runs -- swaps into a mixed basket (dollar-quoted,
// native-quoted, and the cash leg), approvals, deploy, 1:1 shares.
//
//   CHAIN=bnb DEPLOYER=... FEE_REGISTRY=... DEPLOYER_BLOCK=... \
//     npx tsx scripts/verify_evm_launch_fork.mts
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, type ChainConfig } from "../src/merge/lib/evmChain";
import { executeLaunch, quoteLaunch } from "../src/merge/lib/evmLaunch";
import { feeRecipientsForChain, parseUsdgAmount, planLaunch, type PlannedAsset } from "../src/merge/lib/evmLaunchPlan";
import { listReserveAddresses, loadReserve, usdPrice } from "../src/merge/lib/evmReserve";

const key = process.env.CHAIN ?? "bnb";
const real = CHAINS[key as keyof typeof CHAINS];
if (!real?.starterAssets) throw new Error(`${key} has no starterAssets to launch from`);
for (const v of ["DEPLOYER", "FEE_REGISTRY", "DEPLOYER_BLOCK"]) if (!process.env[v]) throw new Error(`Set ${v}`);
const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8547";
const WHALE = (process.env.USD_WHALE ?? "0x172fcD41E0913e95784454622d1c3724f546f849") as Address;

// The real config, pointed at the fork and at the stack just deployed there.
const cfg: ChainConfig = {
  ...real,
  chain: { ...real.chain, rpcUrls: { default: { http: [RPC] } } },
  readProxyPath: undefined,
  deployer: process.env.DEPLOYER as Address,
  feeRegistry: process.env.FEE_REGISTRY as Address,
  deployerBlock: BigInt(process.env.DEPLOYER_BLOCK!),
  logChunk: 2n,
};
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const pc = createPublicClient({ chain: cfg.chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: cfg.chain, transport: http(RPC) });
const fails: string[] = [];
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` -- got ${String(got)}`}`); if (!ok) fails.push(what); };

const cash = cfg.quotes!.usd;
const raw = (method: string, params: unknown[]) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
await raw("anvil_impersonateAccount", [WHALE]);
await raw("anvil_setBalance", [WHALE, "0xDE0B6B3A7640000"]);
const seedHuman = "500";
const seedRaw = parseUsdgAmount(seedHuman, cash.decimals);
await wallet.writeContract({ address: cash.address, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [account.address, seedRaw * 2n], account: WHALE as never });
console.log(`${cfg.chain.name}: seeding ${seedHuman} ${cash.symbol} (${cash.decimals} decimals) from the real starter list\n`);

// A mixed basket straight from the chain's verified starter list: one
// native-quoted asset (two-hop buy), one dollar-quoted asset, and the rest
// left as cash.
const sa = real.starterAssets;
const nativeQuoted = sa.find((a) => a.pool.quote === "native" && a.symbol !== "WBNB")!;
const usdQuoted = sa.find((a) => a.pool.quote === "usd" && a.symbol !== "USDC" && a.symbol !== "WBNB")!;
const ROLE = { usd: "USDG", native: "WETH" } as const;
const planned: PlannedAsset[] = [
  { address: nativeQuoted.address, symbol: nativeQuoted.symbol, decimals: nativeQuoted.decimals, weight: 0.5, pool: { ...nativeQuoted.pool, quote: ROLE[nativeQuoted.pool.quote] } },
  { address: usdQuoted.address, symbol: usdQuoted.symbol, decimals: usdQuoted.decimals, weight: 0.3, pool: { ...usdQuoted.pool, quote: ROLE[usdQuoted.pool.quote] } },
];
const plan = planLaunch(planned, seedRaw, cash.address, cash.decimals, cash.symbol);
console.log(`basket: 50% ${nativeQuoted.symbol} (via ${cfg.quotes!.native.symbol}), 30% ${usdQuoted.symbol}, 20% ${cash.symbol}`);
check(plan.initialShares === seedRaw * 10n ** BigInt(18 - cash.decimals), `one share per ${cash.symbol}: ${seedHuman} shares planned`, plan.initialShares);

const prices = new Map<string, number | null>();
for (const a of planned) prices.set(a.address.toLowerCase(), await usdPrice(pc, cfg, a.address, a.decimals));
const quotes = await quoteLaunch(pc, cfg, plan, (a) => prices.get(a.toLowerCase()) ?? null);
check(quotes.length === plan.legs.length, "every leg quoted", quotes.length);
for (const q of quotes) console.log(`  quote ${q.leg.asset.symbol.padEnd(6)} impact ${(q.impactBps / 100).toFixed(2)}%`);

const progress: string[] = [];
const before = new Set((await listReserveAddresses(pc, cfg)).map((a) => a.toLowerCase()));
const { reserve } = await executeLaunch(pc, wallet, cfg, account.address, {
  plan, quotes, name: "BNB Launch Parity", symbol: "BNBLP",
  mintFee: 3n * 10n ** 15n, tvlFee: 0n, owner: account.address,
  feeRecipients: feeRecipientsForChain(account.address, []), coManagers: [], mandate: "",
}, (m) => { progress.push(m); console.log(`  · ${m}`); });
check(/^0x[0-9a-fA-F]{40}$/.test(reserve), "executeLaunch deploys", reserve);
if (cash.symbol !== "USDG") {
  const leak = progress.filter((m) => /\bUSDG\b/.test(m));
  check(leak.length === 0, `no launch step names Robinhood's USDG on ${cfg.chain.name}`, leak.join(" | "));
}

const after = await listReserveAddresses(pc, cfg);
check(after.some((a) => a.toLowerCase() === reserve.toLowerCase()) && !before.has(reserve.toLowerCase()), "the new reserve is discoverable");

const snap = await loadReserve(pc, cfg, reserve);
const held = new Map(snap.basket.map((b) => [b.symbol.toUpperCase(), b]));
check(snap.basket.length === 3, "the basket holds all three legs", snap.basket.map((b) => b.symbol).join(","));
check(Number(snap.totalSupply) / 1e18 === Number(seedHuman), `${seedHuman} shares minted, not 1e12 too many or too few`, Number(snap.totalSupply) / 1e18);
check(snap.aumUsd !== null && Math.abs(snap.aumUsd - Number(seedHuman)) / Number(seedHuman) < 0.03, `AUM is ~$${seedHuman} (within 3% for fees + impact)`, snap.aumUsd);
const cashLeg = held.get(cash.symbol.toUpperCase());
check(!!cashLeg && Math.abs(Number(cashLeg.amount) / 10 ** cash.decimals - Number(seedHuman) * 0.2) < 0.01, `the cash leg holds 20% as real ${cash.symbol}`, cashLeg && Number(cashLeg.amount) / 10 ** cash.decimals);
console.log(`\n  ${snap.name}  AUM $${snap.aumUsd?.toFixed(2)}  NAV/share $${snap.navPerShare?.toFixed(4)}`);
for (const b of snap.basket) console.log(`    ${b.symbol.padEnd(6)} ${(Number(b.amount) / 10 ** b.decimals).toPrecision(6).padStart(14)}  $${b.usd?.toFixed(2)}`);

console.log(`\n${fails.length === 0 ? "ALL CHECKS PASSED" : `${fails.length} FAILED: ${fails.join("; ")}`}`);
process.exit(fails.length ? 1 : 0);
