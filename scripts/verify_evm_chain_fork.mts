// Proves the EVM half works on a chain that is NOT Robinhood, by deploying the
// whole stack onto an anvil fork and driving it with the app's own code.
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

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH: Address = "0x4200000000000000000000000000000000000006";

const baseFork = defineChain({
  id: 8453, name: "Base (fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** Base's real Uniswap v3 + quote assets, read live from chain 8453 on 2026-10-04. */
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
  assets: [
    { address: USDC, symbol: "USDC", decimals: 6 },
    { address: WETH, symbol: "WETH", decimals: 18 },
  ],
  dex: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    fees: [100, 500, 3000, 10000],
  },
  quotes: {
    usd: { address: USDC, symbol: "USDC", decimals: 6 },
    native: { address: WETH, symbol: "WETH", decimals: 18 },
  },
  isMock: false,
  notice: "Base fork, local only.",
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
console.log(`chain ${await pc.getChainId()}  block ${await pc.getBlockNumber()}\n`);

// Fund this account from a holder on the fork -- no real value moves.
const WHALE: Address = (process.env.USDC_WHALE ?? "0xd0b53D9277642d899DF5C87A3966A349A798F224") as Address;
const raw = (method: string, params: unknown[]) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
await raw("anvil_impersonateAccount", [WHALE]);
await raw("anvil_setBalance", [WHALE, "0xDE0B6B3A7640000"]);
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function deposit() payable"]);
await wallet.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [account.address, 2_000_000_000n], account: WHALE as never });
await wallet.writeContract({ address: WETH, abi: erc20, functionName: "deposit", value: 10n ** 18n });

// 1. Pricing on a non-Robinhood chain -- the defect this file guards.
const ethUsd = await usdPrice(pc, BASE, WETH, 18);
check(ethUsd !== null && ethUsd > 100, "WETH prices on Base (was null while the factory was a module constant)", ethUsd);
check((await usdPrice(pc, BASE, USDC, 6)) === 1, "the chain's own dollar prices at exactly 1", await usdPrice(pc, BASE, USDC, 6));

// 2. A chain with no DEX configured must say so, not read someone else's.
const noDex = { ...BASE, dex: undefined, quotes: undefined } as ChainConfig;
check((await usdPrice(pc, noDex, WETH, 18)) === null, "a chain with no DEX prices null instead of guessing", await usdPrice(pc, noDex, WETH, 18));

// 3. The app's own launch path, unmodified.
const { reserve } = await createReserve(pc, wallet, BASE, account.address, {
  name: "Fork Parity Reserve", symbol: "FORK",
  legs: [
    { asset: BASE.assets[0], amount: 1_000_000_000n },
    { asset: BASE.assets[1], amount: 250_000_000_000_000_000n },
  ],
  initialShares: 100n * 10n ** 18n,
  owner: account.address, coManagers: [], feeRecipients: [],
  tvlFee: 0n, mintFee: 0n, mandate: "",
} as never);
check(/^0x[0-9a-fA-F]{40}$/.test(reserve), "createReserve deploys on Base", reserve);

const found = await listReserveAddresses(pc, BASE);
check(found.some((a) => a.toLowerCase() === reserve.toLowerCase()), "listReserveAddresses finds it from SSRDeployed logs", found.length);

const snap = await loadReserve(pc, BASE, reserve);
check(snap.symbol === "FORK", "loadReserve reads name/symbol", snap.symbol);
check(snap.basket.length === 2, "basket has both legs", snap.basket.length);
check(snap.basket.every((b) => b.usd !== null), "EVERY leg prices (the regression)", JSON.stringify(snap.basket.map((b) => b.usd)));
check(snap.aumUsd !== null && snap.aumUsd > 1000, "aumUsd is a real number, not null", snap.aumUsd);
check(snap.navPerShare !== null, "navPerShare is a real number, not null", snap.navPerShare);
console.log(`\n  AUM $${snap.aumUsd?.toFixed(2)}   NAV/share $${snap.navPerShare?.toFixed(4)}`);

console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} FAILED: ${fail.join("; ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
