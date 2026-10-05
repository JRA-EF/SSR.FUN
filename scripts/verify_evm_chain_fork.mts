// Proves the EVM half works on a chain that is NOT Robinhood, by deploying the
// whole stack onto an anvil fork and driving it with the app's own code.
//
// CHAIN=base (default) or CHAIN=bnb. Every address below was read live from
// the chain itself, never copied from memory -- two addresses that "looked
// right" for Uniswap on BNB turned out to have no code there at all.
//
// This exists because of a defect it now guards: evmReserve.ts used to read
// Robinhood's Uniswap factory and USDG from module constants, so a correct
// reserve on any other chain reported $0 AUM and no NAV -- the same shape as
// DEC-0211 on Solana. See docs/project/MULTICHAIN_RESERVES.md.
//
//   anvil --fork-url https://mainnet.base.org --port 8546 --silent &
//   cd ../ssr-evm && SSR_OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
//     forge script script/SSRMainnet.s.sol --rpc-url http://127.0.0.1:8546 \
//     --broadcast --private-key <anvil key 0>
//   DEPLOYER=0x... npx tsx scripts/verify_evm_chain_fork.mts
//
// Nothing here touches a real network: the key below is anvil's well-known
// test account 0, worthless anywhere else.
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createReserve, loadReserve, listReserveAddresses, usdPrice } from "../src/merge/lib/evmReserve";
import type { ChainConfig } from "../src/merge/lib/evmChain";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface Preset {
  id: number;
  name: string;
  rpc: string;
  native: { symbol: string; decimals: number };
  /** The chain's dollar and its wrapped native, with REAL decimals -- BNB's USDT is 18, not 6. */
  usd: { address: Address; symbol: string; decimals: number };
  wrapped: { address: Address; symbol: string; decimals: number };
  dex: { factory: Address; quoter: Address; router: Address; fees: readonly number[] };
  /** An address holding the dollar on that chain; impersonated on the fork so no real value moves. */
  whale: Address;
  seedUsd: bigint;
  seedWrapped: bigint;
}

const PRESETS: Record<string, Preset> = {
  base: {
    id: 8453, name: "Base", rpc: "http://127.0.0.1:8546",
    native: { symbol: "ETH", decimals: 18 },
    usd: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    wrapped: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    dex: {
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      router: "0x2626664c2603336E57B271c5C0b26F421741e481",
      fees: [100, 500, 3000, 10000],
    },
    whale: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    seedUsd: 1_000_000_000n,                 // 1,000 USDC at 6dp
    seedWrapped: 250_000_000_000_000_000n,   // 0.25 WETH
  },
  bnb: {
    id: 56, name: "BNB Smart Chain", rpc: "http://127.0.0.1:8547",
    native: { symbol: "BNB", decimals: 18 },
    // NOTE: BNB's USDT is 18 decimals, not the 6 it has on Base/Ethereum.
    // The chain config carries decimals per quote asset precisely for this.
    usd: { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
    wrapped: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18 },
    // PancakeSwap v3, not Uniswap: Uniswap v3's factory is deployed on BNB but
    // its quoter/router are not at the addresses they occupy elsewhere, and
    // Pancake's USDT/WBNB pool is the deeper market anyway. Its fee tiers
    // differ from Uniswap's (2500 rather than 3000), which is why the tiers
    // travel with the DEX in ChainConfig.
    dex: {
      factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
      router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
      fees: [100, 500, 2500, 10000],
    },
    whale: "0x172fcD41E0913e95784454622d1c3724f546f849",
    seedUsd: 1_000n * 10n ** 18n,            // 1,000 USDT at 18dp
    seedWrapped: 10n ** 18n,                 // 1 WBNB
  },
};

const P = PRESETS[process.env.CHAIN ?? "base"];
if (!P) throw new Error(`CHAIN must be one of ${Object.keys(PRESETS).join(", ")}`);
const RPC = process.env.FORK_RPC ?? P.rpc;
const USDC: Address = P.usd.address;
const WETH: Address = P.wrapped.address;

const baseFork = defineChain({
  id: P.id, name: `${P.name} (fork)`,
  nativeCurrency: { name: P.native.symbol, symbol: P.native.symbol, decimals: P.native.decimals },
  rpcUrls: { default: { http: [RPC] } },
});

/** The chain under test, assembled from the preset above. */
const BASE: ChainConfig = {
  key: "mainnet" as never,
  chain: baseFork,
  explorer: "https://basescan.org",
  ssr: null,
  deployer: (process.env.DEPLOYER ?? "") as Address,
  deployerBlock: BigInt(process.env.DEPLOYER_BLOCK ?? "0"),
  versionRegistry: "0x0000000000000000000000000000000000000000",
  feeRegistry: (process.env.FEE_REGISTRY ?? "0x0000000000000000000000000000000000000000") as Address,
  roleRegistry: "0x0000000000000000000000000000000000000000",
  fillerRegistry: "0x0000000000000000000000000000000000000000",
  assets: [P.usd, P.wrapped],
  dex: P.dex,
  quotes: { usd: P.usd, native: P.wrapped },
  isMock: false,
  notice: `${P.name} fork, local only.`,
};

const account = privateKeyToAccount(ANVIL_KEY);
const pc = createPublicClient({ chain: baseFork, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: baseFork, transport: http(RPC) });
const fail: string[] = [];
const check = (ok: boolean, what: string, got: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` -- got ${String(got)}`}`);
  if (!ok) fail.push(what);
};

if (!BASE.deployer) throw new Error("Set DEPLOYER=<SSRDeployer address from the forge run>");
// Without this the fee registry is the zero address and loadReserve fails deep
// inside getFeeDetails with "returned no data", which reads like a code bug.
if (!process.env.FEE_REGISTRY) throw new Error("Set FEE_REGISTRY=<SSRDAOFeeRegistry address from the forge run>");
console.log(`${P.name}: chain ${await pc.getChainId()}  block ${await pc.getBlockNumber()}\n`);

// Fund this account from a holder on the fork -- no real value moves.
const WHALE: Address = (process.env.USDC_WHALE ?? P.whale) as Address;
const raw = (method: string, params: unknown[]) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
await raw("anvil_impersonateAccount", [WHALE]);
await raw("anvil_setBalance", [WHALE, "0xDE0B6B3A7640000"]);
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function deposit() payable"]);
await wallet.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [account.address, P.seedUsd * 2n], account: WHALE as never });
await wallet.writeContract({ address: WETH, abi: erc20, functionName: "deposit", value: 10n ** 18n });

// 1. Pricing on a non-Robinhood chain -- the defect this file guards.
const ethUsd = await usdPrice(pc, BASE, WETH, 18);
check(ethUsd !== null && ethUsd > 10, `${P.wrapped.symbol} prices on ${P.name} (was null while the factory was a module constant)`, ethUsd);
check((await usdPrice(pc, BASE, USDC, P.usd.decimals)) === 1, "the chain's own dollar prices at exactly 1", await usdPrice(pc, BASE, USDC, P.usd.decimals));

// 2. A chain with no DEX configured must say so, not read someone else's.
const noDex = { ...BASE, dex: undefined, quotes: undefined } as ChainConfig;
check((await usdPrice(pc, noDex, WETH, 18)) === null, "a chain with no DEX prices null instead of guessing", await usdPrice(pc, noDex, WETH, 18));

// 3. The app's own launch path, unmodified.
const { reserve } = await createReserve(pc, wallet, BASE, account.address, {
  name: "Fork Parity Reserve", symbol: "FORK",
  legs: [
    { asset: BASE.assets[0], amount: P.seedUsd },
    { asset: BASE.assets[1], amount: P.seedWrapped },
  ],
  initialShares: 100n * 10n ** 18n,
  owner: account.address, coManagers: [], feeRecipients: [],
  tvlFee: 0n, mintFee: 0n, mandate: "",
} as never);
check(/^0x[0-9a-fA-F]{40}$/.test(reserve), `createReserve deploys on ${P.name}`, reserve);

const found = await listReserveAddresses(pc, BASE);
check(found.some((a) => a.toLowerCase() === reserve.toLowerCase()), "listReserveAddresses finds it from SSRDeployed logs", found.length);

const snap = await loadReserve(pc, BASE, reserve);
check(snap.symbol === "FORK", "loadReserve reads name/symbol", snap.symbol);
check(snap.basket.length === 2, "basket has both legs", snap.basket.length);
check(snap.basket.every((b) => b.usd !== null), "EVERY leg prices (the regression)", JSON.stringify(snap.basket.map((b) => b.usd)));
check(snap.aumUsd !== null && snap.aumUsd > 500, "aumUsd is a real number, not null", snap.aumUsd);
check(snap.navPerShare !== null, "navPerShare is a real number, not null", snap.navPerShare);
console.log(`\n  AUM $${snap.aumUsd?.toFixed(2)}   NAV/share $${snap.navPerShare?.toFixed(4)}`);

console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} FAILED: ${fail.join("; ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
