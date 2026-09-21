// Robinhood Chain wiring for the EVM test page (/evm).
//
// SSR's EVM half is a fork of Reserve's audited Folio (reserve-index-dtf),
// deep-renamed to SSR, with ONE behavioural change: SSRDAOFeeRegistry's fee
// caps were raised so the Solana fee rule (mint 50% with a 0.5% floor) is
// expressible on both chains. The source of truth for the contracts lives at
// /Volumes/GitStuff/ssr-evm (see its PROVENANCE.md for the upstream commit,
// the audits, and the exact diff).
//
// This page points at the TESTNET (46630) deployment, which is the one that
// carries a live SSR instance with a real basket. The mainnet (4663)
// deployment has the registries and the deployer but no instance yet, and its
// role registry is still the mock -- see MAINNET_ADDRESSES below.
import { defineChain } from "viem";

export const ROBINHOOD_TESTNET = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const EXPLORER = ROBINHOOD_TESTNET.blockExplorers.default.url;

/** The live SSR instance (an SSRProxy) and the infrastructure behind it. */
export const ADDRESSES = {
  ssr: "0x33651dca47088f87e6fb7ef846c695aeb8195d66",
  deployer: "0x5ad2281bca3b0232ca2e9d57a9cb8333392589ef",
  versionRegistry: "0xa523cfb8168559c889068a1047f483821f0a361b",
  feeRegistry: "0xf6248693d45706ea00dd7aaaa56bbf1f050eb2c4",
  roleRegistry: "0x64563ac360a3c0b2d7690d1b519a70d8015712f5",
  fillerRegistry: "0x8de7d7d97e57a65a9e7a5497f80c0e8fec4c20c5",
} as const;

/**
 * Robinhood MAINNET (4663). Recorded here so the two deployments are readable
 * side by side; nothing on this page transacts against them. There is no SSR
 * instance on mainnet yet, and `roleRegistry` is still MockRoleRegistry --
 * both have to change before anything here is pointed at 4663.
 */
export const MAINNET_ADDRESSES = {
  chainId: 4663,
  deployer: "0x81dd183c53C95F251869520d8DB10B0A4a4F8858",
  versionRegistry: "0x835dd7fF172874749855aae0174c6ecAA82Ef1e6",
  feeRegistry: "0x03079d5f8d3B6d27827315205D1328b193c48d31",
  roleRegistry: "0x3a96Fd76dAB64be73404BF59587beF21773Dcd94",
  fillerRegistry: "0x95CB8550056680a004019fD45db4347A622C2CFc",
} as const;

/**
 * The basket assets are MockERC20s deployed alongside the instance. Their
 * `mint(address,uint256)` is deliberately UNGUARDED, which is what makes this
 * page self-service: a tester funds themselves rather than asking for a
 * transfer. That is a test-fixture property and must never be true of a real
 * asset -- it is the reason this page is testnet-only.
 */
export const FAUCET_ASSETS = [
  { address: "0xd60cece26598397b6f90deababf22c1ce6066d8f", symbol: "USDC", decimals: 6, faucetAmount: 10_000n },
  { address: "0x638626af66bbaf2a8fe5a9c293a2f718f6f170cd", symbol: "WBTC", decimals: 8, faucetAmount: 1n },
] as const;

// Minimal hand-written ABIs -- only the functions this page calls. Kept small
// and explicit rather than importing the full artifact, so a reader can see
// the entire contract surface the page touches in one place.

export const SSR_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "totalAssets",
    inputs: [],
    outputs: [{ name: "_assets", type: "address[]" }, { name: "_amounts", type: "uint256[]" }],
    stateMutability: "view",
  },
  { type: "function", name: "mintFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "tvlFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    // OpenZeppelin's Math.Rounding is { Floor, Ceil, Trunc, Expand }, so
    // Floor = 0 and Ceil = 1. Mint quotes round Ceil (the minter pays the
    // rounding) and redeem quotes round Floor -- the same values SSR.mint and
    // SSR.redeem pass internally, so a quote here matches what executes.
    type: "function",
    name: "toAssets",
    inputs: [{ name: "shares", type: "uint256" }, { name: "rounding", type: "uint8" }],
    outputs: [{ name: "_assets", type: "address[]" }, { name: "_amounts", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mint",
    inputs: [{ name: "shares", type: "uint256" }, { name: "receiver", type: "address" }, { name: "minSharesOut", type: "uint256" }],
    outputs: [{ name: "_assets", type: "address[]" }, { name: "_amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "redeem",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "assets", type: "address[]" },
      { name: "minAmountsOut", type: "uint256[]" },
    ],
    outputs: [{ name: "_amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * The one contract SSR changed from upstream Folio. `getFeeDetails` returns
 * the DAO's cut of every mint fee and the FLOOR beneath it -- the pair that
 * had to be raised from upstream's (1/3, 0.1%) caps to express the Solana
 * rule. Reading it live is how this page proves the two chains agree.
 */
export const FEE_REGISTRY_ABI = [
  {
    type: "function",
    name: "getFeeDetails",
    inputs: [{ name: "folio", type: "address" }],
    outputs: [
      { name: "recipient", type: "address" },
      { name: "feeNumerator", type: "uint256" },
      { name: "feeDenominator", type: "uint256" },
      { name: "feeFloor", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "allowance",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [{ name: "account", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
