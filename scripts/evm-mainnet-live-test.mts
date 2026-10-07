// Real-money end-to-end test of a LIVE EVM chain, through the app's own code
// and the chain's real ChainConfig -- no fork. Spends real funds, so it
// refuses to run without CONFIRM=1 and enforces a hard native-token cap.
//
//   CONFIRM=1 CHAIN=bnb CAP=0.074 META_ID=<reserve-metadata id> \
//     npx tsx scripts/evm-mainnet-live-test.mts
//
// Steps: native -> dollar on the chain's DEX; launch a reserve through
// planLaunch/quoteLaunch/executeLaunch; discover it through the chunked scan;
// price it; mint shares in kind; redeem them. Every transaction is printed.
// Uses the OWNER key (~/.config/evm/ssr-evm-owner.json), never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, custom, fallback, toHex, formatEther, http, parseAbi, parseEther, parseGwei, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, type ChainConfig } from "../src/merge/lib/evmChain";
import { executeLaunch, quoteLaunch } from "../src/merge/lib/evmLaunch";
import { feeRecipientsForChain, parseUsdgAmount, percentToD18, planLaunch, type PlannedAsset } from "../src/merge/lib/evmLaunchPlan";
import { approveIfNeeded, listReserveAddresses, loadReserve, mintFeeBreakdown, quoteMintCost, quoteRedeemProceeds, sendChecked, usdPrice } from "../src/merge/lib/evmReserve";
import { bestNativeHopFee, quoteExactUsdgIn, routeFor, swapExactUsdgIn } from "../src/merge/lib/evmSwap";
import { mandateForMetadataId } from "../src/merge/lib/evmReserveMeta";

if (process.env.CONFIRM !== "1") throw new Error("This spends REAL funds. Re-run with CONFIRM=1.");
const key = process.env.CHAIN ?? "bnb";
const cfg = CHAINS[key as keyof typeof CHAINS] as ChainConfig;
if (!cfg?.live) throw new Error(`${key} is not a live chain`);
// No single free BNB endpoint serves both receipts and logs: publicnode is the
// only one serving eth_getLogs (<= 5,000 blocks) but refuses receipts as
// "archive"; defibit and the rest serve receipts but refuse getLogs. viem's
// fallback transport moves to the next URL on an error, so each call lands on
// an endpoint that answers it. RPC=<url> forces a single endpoint (a fork).
// Receipt/state endpoint first, logs endpoint second, per chain (measured).
const DEFAULT_RPCS: Record<string, string> = {
  bnb: "https://bsc-dataseed1.defibit.io,https://bsc-rpc.publicnode.com",
  base: "https://developer-access-mainnet.base.org,https://base-rpc.publicnode.com",
  // publicnode serves receipts AND getLogs on Ethereum (measured 2026-10-07).
  ethereum: "https://ethereum-rpc.publicnode.com",
};
const RPCS = (process.env.RPC ?? DEFAULT_RPCS[process.env.CHAIN ?? "bnb"]).split(",");
const RPC = RPCS[0];
const CAP = parseEther(process.env.CAP ?? "0.074");
const owner = JSON.parse(readFileSync(`${homedir()}/.config/evm/ssr-evm-owner.json`, "utf8"))[0];
const account = privateKeyToAccount(owner.private_key);
const chain = { ...cfg.chain, rpcUrls: { default: { http: [RPC] } } };
// publicnode answers eth_maxPriorityFeePerGas -- and eth_fillTransaction --
// with a ZERO tip on Ethereum, so an approval sat unincluded past the receipt
// timeout (2026-10-07). The signer's transport refuses eth_fillTransaction (viem
// then fills locally) and floors the tip. A browser wallet sets its own fees.
const TIP_FLOOR = parseGwei(process.env.TIP_GWEI ?? "0.1");
const signerTransport = (url: string) => {
  const upstream = http(url);
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const up = upstream({ chain, retryCount: 2 });
      if (method === "eth_fillTransaction") throw Object.assign(new Error("method not supported"), { code: -32601 });
      if (method === "eth_maxPriorityFeePerGas") {
        const quoted = BigInt((await up.request({ method, params } as never)) as string);
        return toHex(quoted > TIP_FLOOR ? quoted : TIP_FLOOR);
      }
      return up.request({ method, params } as never);
    },
  });
};
// DEPLOYER_BLOCK only for a fork rehearsal, where pre-fork logs are unavailable.
const live: ChainConfig = { ...cfg, chain, readProxyPath: undefined, deployerBlock: process.env.DEPLOYER_BLOCK ? BigInt(process.env.DEPLOYER_BLOCK) : cfg.deployerBlock };
const transport = RPCS.length > 1 ? fallback(RPCS.map((u) => http(u))) : http(RPC);
const pc = createPublicClient({ chain, transport });
// The SIGNING client talks to exactly one endpoint. Spread across a fallback,
// viem's eth_fillTransaction probe was "unsupported" on the first node and
// then forwarded to a second that answered "Missing or invalid parameters" --
// which stopped the live Base run at its first approval. Sends belong on one
// node anyway: nonce, fees and broadcast should all come from the same view.
const wallet = createWalletClient({ account, chain, transport: signerTransport(RPC) });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)", "function deposit() payable"]);
const SSR = parseAbi([
  "function mint(uint256 shares, address receiver, uint256 minSharesOut) returns (address[], uint256[])",
  "function redeem(uint256 shares, address receiver, address[] assets, uint256[] minAmountsOut) returns (uint256[])",
  "function balanceOf(address) view returns (uint256)",
]);
const ROUTER = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
const QUOTER = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
const q = live.quotes!, dex = live.dex!;
const bal = (t: Address, a: Address = account.address) => pc.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const fails: string[] = [];
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` -- got ${String(got)}`}`); if (!ok) fails.push(what); };
const start = await pc.getBalance({ address: account.address });
const guard = async (step: string) => {
  const spent = start - (await pc.getBalance({ address: account.address }));
  console.log(`  [spent so far ${formatEther(spent)} ${chain.nativeCurrency.symbol} of cap ${formatEther(CAP)}]`);
  if (spent > CAP) throw new Error(`CAP EXCEEDED after ${step}`);
};
/** Re-reads until `ok` holds (or ~15s): public RPCs can serve a read from a backend a block behind the receipt. */
async function settled<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 15 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 1000)); v = await read(); }
  return v;
}
/**
 * Retries a write ONLY when it failed before anything was sent -- a simulation
 * or gas-estimate revert caused by a load-balanced backend that has not seen
 * our previous write yet ("STF", "exceeds balance", "returned no data").
 * A transaction that was mined and reverted is never retried: that would send
 * it again.
 */
async function retryPreSend<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const m = (e as Error).message ?? "";
      const preSend = !/mined but reverted|reverted on-chain/i.test(m) && /STF|exceeds balance|returned no data|Simulation|estimateGas|CallExecutionError|reverted with the following reason/i.test(m);
      if (!preSend || i >= 6) throw e;
      console.log(`  (${what}: a backend had not caught up -- retrying, nothing was sent)`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}
const tx = async (label: string, hash: `0x${string}`) => {
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log(`  tx ${label.padEnd(22)} ${hash}  ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
};

console.log(`${chain.name} LIVE  owner ${account.address}  start ${formatEther(start)} ${chain.nativeCurrency.symbol}\n`);

// --- 1. native -> dollar ----------------------------------------------------
const wrapAmt = parseEther(process.env.SWAP_NATIVE ?? "0.06");
// Resume-safe at the step level too: if an earlier run already swapped into
// enough dollar for the seed, step 1 is done -- never swap twice.
const seedNeedRaw = parseUsdgAmount(process.env.SEED ?? "30", q.usd.decimals);
const RESUME_RESERVE = process.env.RESERVE as Address | undefined;
const step1Done = !!RESUME_RESERVE || (await bal(q.usd.address)) >= seedNeedRaw;
if (step1Done) console.log(`1. already holding enough ${q.usd.symbol} from an earlier run -- skipping the native swap`);
const fee1 = await bestNativeHopFee(pc, live); // the deepest dollar/native pool on this chain
if (!step1Done) {
const { result: [quotedUsd] } = await pc.simulateContract({ address: dex.quoter, abi: QUOTER, functionName: "quoteExactInputSingle", args: [{ tokenIn: q.native.address, tokenOut: q.usd.address, amountIn: wrapAmt, fee: fee1, sqrtPriceLimitX96: 0n }] });
console.log(`1. ${formatEther(wrapAmt)} ${q.native.symbol} -> quoted ${Number(quotedUsd) / 10 ** q.usd.decimals} ${q.usd.symbol}`);
// Resume-safe: a previous run may have wrapped already and stopped. Wrap only
// the shortfall, so a re-run can never wrap (and spend) twice.
const wrapped = await bal(q.native.address);
if (wrapped < wrapAmt && wrapAmt - wrapped > CAP) throw new Error("wrapping the shortfall would exceed CAP");
if (wrapped < wrapAmt) await tx("wrap", await wallet.writeContract({ address: q.native.address, abi: ERC20, functionName: "deposit", value: wrapAmt - wrapped }));
else console.log(`  already holding ${formatEther(wrapped)} ${q.native.symbol} from an earlier run -- not wrapping again`);
await approveIfNeeded(pc, wallet, live, account.address, q.native.address, dex.router, wrapAmt);
const usd0 = await bal(q.usd.address);
await tx("swap native->dollar", await wallet.writeContract({ address: dex.router, abi: ROUTER, functionName: "exactInputSingle", args: [{ tokenIn: q.native.address, tokenOut: q.usd.address, fee: fee1, recipient: account.address, amountIn: wrapAmt, amountOutMinimum: (quotedUsd * 99n) / 100n, sqrtPriceLimitX96: 0n }] }));
let gotUsd = 0n;
for (let i = 0; i < 15 && gotUsd <= 0n; i++) { gotUsd = (await bal(q.usd.address)) - usd0; if (gotUsd <= 0n) await new Promise((r) => setTimeout(r, 1000)); }
check(gotUsd >= (quotedUsd * 99n) / 100n, `received >= 99% of quoted ${q.usd.symbol}`, gotUsd);
console.log(`   holding ${Number(await bal(q.usd.address)) / 10 ** q.usd.decimals} ${q.usd.symbol}`);
await guard("swap");
}

// --- 2. launch ----------------------------------------------------------------
const sa = live.starterAssets!;
const isQuote = (a: { address: string }) => [q.usd.address, q.native.address].some((x) => x.toLowerCase() === a.address.toLowerCase());
// One two-hop (native-quoted) leg and one direct (dollar-quoted) leg, from
// this chain's own verified list. Names kept generic: "btc" is the two-hop leg.
// Stablecoins are skipped: on Ethereum USDT is WETH-quoted, and a dollar
// routed through ETH and back proves the two-hop path less than WBTC does.
const btc = sa.find((a) => a.pool.quote === "native" && !isQuote(a) && !/^(usd|dai)/i.test(a.symbol))!;
const cake = sa.find((a) => a.pool.quote === "usd" && !isQuote(a) && !/^usd/i.test(a.symbol))!;
const ROLE = { usd: "USDG", native: "WETH" } as const;
const pa = (a: typeof btc, w: number): PlannedAsset => ({ address: a.address, symbol: a.symbol, decimals: a.decimals, weight: w, pool: { ...a.pool, quote: ROLE[a.pool.quote] } });
const seedHuman = process.env.SEED ?? "30";
const plan = planLaunch([pa(btc, 0.4), pa(cake, 0.3)], parseUsdgAmount(seedHuman, q.usd.decimals), q.usd.address, q.usd.decimals, q.usd.symbol);
const prices = new Map<string, number | null>();
for (const a of [btc, cake]) prices.set(a.address.toLowerCase(), await usdPrice(pc, live, a.address, a.decimals));
const quotes = await quoteLaunch(pc, live, plan, (a) => prices.get(a.toLowerCase()) ?? null);
const mandate = process.env.META_ID ? mandateForMetadataId("https://ssr.fun", process.env.META_ID) : "";
const NAME = process.env.NAME ?? "BNB Majors", SYMBOL = process.env.SYMBOL ?? "BNBMAJ";
console.log(`\n2. launching ${NAME}: ${seedHuman} ${q.usd.symbol} -> 40% ${btc.symbol}, 30% ${cake.symbol}, 30% cash   mandate ${mandate || "(none)"}`);
const { reserve, hash: deployHash } = RESUME_RESERVE ? { reserve: RESUME_RESERVE, hash: "(launched in an earlier run)" } : await executeLaunch(pc, wallet, live, account.address, {
  plan, quotes, name: NAME, symbol: SYMBOL,
  mintFee: percentToD18(0.5), tvlFee: percentToD18(1), owner: account.address,
  feeRecipients: feeRecipientsForChain(account.address, []), coManagers: [], mandate,
}, (m) => console.log(`   · ${m}`));
console.log(`   RESERVE ${reserve}   deploy tx ${deployHash}`);
await guard("launch");

// --- 3. discover + price, through the chunked mainnet scan ------------------
const found = await settled(() => listReserveAddresses(pc, live), (v) => v.some((a) => a.toLowerCase() === reserve.toLowerCase()));
check(found.some((a) => a.toLowerCase() === reserve.toLowerCase()), `chunked discovery (logChunk ${live.logChunk}) finds it on mainnet`, found.length);
const snap = await settled(() => loadReserve(pc, live, reserve).catch(() => null), (v) => v !== null) as Awaited<ReturnType<typeof loadReserve>>;
check(snap.chainKey === live.key && snap.idPrefix === live.idPrefix, "snapshot knows its chain", `${snap.chainKey}/${snap.idPrefix}`);
if (!RESUME_RESERVE) {
  check(Number(snap.totalSupply) / 1e18 === Number(seedHuman), `${seedHuman} shares, one per ${q.usd.symbol}`, Number(snap.totalSupply) / 1e18);
  check(snap.aumUsd !== null && Math.abs(snap.aumUsd - Number(seedHuman)) / Number(seedHuman) < 0.03, `AUM ~$${seedHuman}`, snap.aumUsd);
}
// Holds on a fresh launch and on a resumed one alike: one share is worth ~$1.
check(snap.navPerShare !== null && Math.abs(snap.navPerShare - 1) < 0.03, "NAV/share ~$1.00", snap.navPerShare);
check(snap.mandate === mandate, "mandate written on-chain", snap.mandate);
console.log(`   NAV/share $${snap.navPerShare?.toFixed(4)}   AUM $${snap.aumUsd?.toFixed(2)}`);
for (const b of snap.basket) console.log(`     ${b.symbol.padEnd(6)} ${(Number(b.amount) / 10 ** b.decimals).toPrecision(6)}  $${b.usd?.toFixed(2)}`);

// REDEEM_SHARES=<n> resumes after a mint that already succeeded: redeem those
// shares without minting again.
const REDEEM_ONLY = process.env.REDEEM_SHARES ? parseEther(process.env.REDEEM_SHARES) : null;
let minted = REDEEM_ONLY ?? 0n;
if (REDEEM_ONLY) console.log(`\n4. mint already proven in an earlier run -- redeeming ${formatEther(REDEEM_ONLY)} shares it produced`);
else {
// --- 4. mint in kind ------------------------------------------------------------
const mintShares = parseEther(process.env.MINT_SHARES ?? "5");
const [assets, amounts] = (await quoteMintCost(pc, reserve, mintShares)) as [readonly Address[], readonly bigint[]];
const fee = await mintFeeBreakdown(pc, live, reserve, mintShares);
console.log(`\n4. minting ${formatEther(mintShares)} shares (fee ${formatEther(fee.total)}, DAO ${formatEther(fee.dao)}); basket needed:`);
for (let i = 0; i < assets.length; i++) {
  const a = assets[i], need = amounts[i];
  const have = await bal(a);
  const meta = [btc, cake].find((x) => x.address.toLowerCase() === a.toLowerCase());
  console.log(`     ${(meta?.symbol ?? q.usd.symbol).padEnd(6)} need ${need}  have ${have}`);
  if (have >= need || !meta) continue;
  // Swap enough dollar into the shortfall, 3% over to absorb price movement.
  const px = prices.get(a.toLowerCase())!;
  const usdNeeded = (Number(need - have) / 10 ** meta.decimals) * px * 1.03 + 0.05;
  const usdIn = parseUsdgAmount(usdNeeded.toFixed(6), q.usd.decimals);
  const route = await routeFor(pc, live, a, { fee: meta.pool.fee, quote: ROLE[meta.pool.quote] });
  const out = await quoteExactUsdgIn(pc, live, route, usdIn);
  // Approve explicitly every time: approve-then-spend in quick succession is
  // exactly where approveIfNeeded's single stale read skipped an approval.
  await tx(`approve for ${meta.symbol}`, await wallet.writeContract({ address: q.usd.address, abi: ERC20, functionName: "approve", args: [dex.router, usdIn] }));
  await settled(() => pc.readContract({ address: q.usd.address, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [account.address, dex.router] }) as Promise<bigint>, (v) => v >= usdIn);
  await retryPreSend(`swap into ${meta.symbol}`, () => swapExactUsdgIn(pc, wallet, live, account.address, route, usdIn, (out * 99n) / 100n));
  console.log(`       topped up ${meta.symbol} with ${usdNeeded.toFixed(2)} ${q.usd.symbol}`);
}
for (let i = 0; i < assets.length; i++) await settled(() => bal(assets[i]), (v) => v >= amounts[i]);
for (let i = 0; i < assets.length; i++) await approveIfNeeded(pc, wallet, live, account.address, assets[i], reserve, amounts[i]);
const sh0 = (await pc.readContract({ address: reserve, abi: SSR, functionName: "balanceOf", args: [account.address] })) as bigint;
// The app's own send path: simulated, gas with headroom, receipt status checked.
console.log(`  tx mint                   ${await retryPreSend("mint", () => sendChecked(pc, wallet, { address: reserve, abi: SSR, functionName: "mint", args: [mintShares, account.address, fee.out], account: account.address, chain }, "mint"))}  success`);
minted = (await settled(() => pc.readContract({ address: reserve, abi: SSR, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>, (v) => v > sh0)) - sh0;
check(minted === fee.out, `received exactly the quoted ${formatEther(fee.out)} shares after the 0.5% fee`, formatEther(minted));
await guard("mint");

}
// --- 5. redeem ----------------------------------------------------------------
const [rAssets, rAmounts] = (await quoteRedeemProceeds(pc, reserve, minted)) as [readonly Address[], readonly bigint[]];
const before = await Promise.all(rAssets.map((a) => bal(a)));
console.log(`\n5. redeeming the ${formatEther(minted)} minted shares`);
console.log(`  tx redeem                 ${await retryPreSend("redeem", () => sendChecked(pc, wallet, { address: reserve, abi: SSR, functionName: "redeem", args: [minted, account.address, [...rAssets], rAmounts.map((x) => (x * 99n) / 100n)], account: account.address, chain }, "redemption"))}  success`);
const after = await Promise.all(rAssets.map((a, i) => settled(() => bal(a), (v) => v > before[i])));
rAssets.forEach((a, i) => {
  const got = after[i] - before[i];
  const meta = [btc, cake].find((x) => x.address.toLowerCase() === a.toLowerCase());
  check(got >= (rAmounts[i] * 99n) / 100n, `redeem paid ${meta?.symbol ?? q.usd.symbol} >= 99% of quote`, `${got} vs ${rAmounts[i]}`);
});
const end = await loadReserve(pc, live, reserve);
console.log(`   reserve after: supply ${Number(end.totalSupply) / 1e18}  AUM $${end.aumUsd?.toFixed(2)}  NAV/share $${end.navPerShare?.toFixed(4)}`);
await guard("redeem");

const spent = start - (await pc.getBalance({ address: account.address }));
console.log(`\nRESERVE ${reserve}\nspent ${formatEther(spent)} ${chain.nativeCurrency.symbol} of the ${formatEther(CAP)} cap`);
console.log(`${fails.length === 0 ? "ALL CHECKS PASSED" : `${fails.length} FAILED: ${fails.join("; ")}`}`);
process.exit(fails.length ? 1 : 0);
