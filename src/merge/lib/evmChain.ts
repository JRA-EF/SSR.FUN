// Robinhood Chain wiring for the EVM app (/evm).
//
// SSR's EVM half is a fork of Reserve's audited Folio (reserve-index-dtf),
// deep-renamed to SSR, with ONE behavioural change: SSRDAOFeeRegistry's fee
// caps were raised so the Solana fee rule (mint 50% with a 0.5% floor) is
// expressible on both chains. Contract source lives at /Volumes/GitStuff/ssr-evm
// (see its PROVENANCE.md for the upstream commit, the audits and the diff).
//
// TWO chains are configured. They are genuinely different situations and the
// UI says so rather than pretending otherwise:
//
//   testnet 46630 -- carries a live SSR instance over MOCK assets whose
//     mint() is unguarded, so anyone can fund themselves. Safe to break.
//   mainnet  4663 -- carries the factory (SSRDeployer), the registries, the
//     configured fee rule, and the first real reserve (EQSSR) over USDG and
//     Robinhood stock tokens. Creating another costs ~1.8M gas and real
//     assets to seed the basket.
import { defineChain, type Address } from "viem";

export interface AssetRef {
  address: Address;
  symbol: string;
  decimals: number;
  /** Only mock assets expose an unguarded mint(); real ones never do. */
  faucetAmount?: bigint;
  note?: string;
}

export interface ChainConfig {
  key: "testnet" | "mainnet";
  chain: ReturnType<typeof defineChain>;
  explorer: string;
  /** The live SSR instance, or null when none has been created yet. */
  ssr: Address | null;
  deployer: Address;
  /** Block the factory was created in -- where reserve discovery starts reading SSRDeployed logs. */
  deployerBlock: bigint;
  versionRegistry: Address;
  feeRegistry: Address;
  roleRegistry: Address;
  fillerRegistry: Address;
  /** Assets the UI offers when creating a reserve. A product choice, not a contract limit. */
  assets: AssetRef[];
  /** True when the instance and its assets are test fixtures, not real value. */
  isMock: boolean;
  faucetUrl?: string;
  /** Shown as a banner. The honest state of this deployment. */
  notice: string;
}

const testnetChain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

const mainnetChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://robinhoodchain.blockscout.com" } },
  // Canonical Multicall3, verified deployed on 4663.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const CHAINS: Record<"testnet" | "mainnet", ChainConfig> = {
  testnet: {
    key: "testnet",
    chain: testnetChain,
    explorer: "https://explorer.testnet.chain.robinhood.com",
    ssr: "0x33651dca47088f87e6fb7ef846c695aeb8195d66",
    deployer: "0x5ad2281bca3b0232ca2e9d57a9cb8333392589ef",
    deployerBlock: 122412044n,
    versionRegistry: "0xa523cfb8168559c889068a1047f483821f0a361b",
    feeRegistry: "0xf6248693d45706ea00dd7aaaa56bbf1f050eb2c4",
    roleRegistry: "0x64563ac360a3c0b2d7690d1b519a70d8015712f5",
    fillerRegistry: "0x8de7d7d97e57a65a9e7a5497f80c0e8fec4c20c5",
    assets: [
      { address: "0xd60cece26598397b6f90deababf22c1ce6066d8f", symbol: "USDC", decimals: 6, faucetAmount: 10_000n },
      { address: "0x638626af66bbaf2a8fe5a9c293a2f718f6f170cd", symbol: "WBTC", decimals: 8, faucetAmount: 1n },
    ],
    isMock: true,
    faucetUrl: "https://docs.robinhood.com/chain/",
    notice:
      "Testnet fixtures. The reserve here is a TEST deployment: its name, its basket and its balances " +
      "are made up, and the assets are mock tokens anyone can mint. Nothing on this network is real value. " +
      "You still need testnet ETH for gas -- the faucet button only mints basket assets.",
  },
  mainnet: {
    key: "mainnet",
    chain: mainnetChain,
    explorer: "https://robinhoodchain.blockscout.com",
    // First reserve created through the mainnet factory, 2026-09-21:
    // deploySSR tx 0x835b3bea496bae28f0449948dd6eb4c953667ea94c8f74ac82260630e53c48eb
    // (block 69019394). Seeded with ~$10 of USDG / NVDA / SPY bought on
    // Uniswap v3; ATOMIC_SWAP pricing and a 300s auction cap. Admin is the
    // separate owner key 0x8b41e427...; its ProxyAdmin is
    // 0xCd098aD73A19fe647d462e8A10C7B5A4024051bF.
    ssr: "0xADEd2d2967AC92EE8FB52612D3436511F302Fe2f",
    isMock: false,
    deployer: "0x81dd183c53C95F251869520d8DB10B0A4a4F8858",
    deployerBlock: 68886534n,
    versionRegistry: "0x835dd7fF172874749855aae0174c6ecAA82Ef1e6",
    feeRegistry: "0x03079d5f8d3B6d27827315205D1328b193c48d31",
    roleRegistry: "0x3a96Fd76dAB64be73404BF59587beF21773Dcd94",
    fillerRegistry: "0x95CB8550056680a004019fD45db4347A622C2CFc",
    // Robinhood's tokenised equities. VERIFIED on-chain 2026-09-21 by reading
    // symbol()/decimals() directly; USDG is the quote asset everything trades
    // against. These are ERC-8056: see MULTIPLIER_WARNING below.
    assets: [
      { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, note: "Global Dollar -- the cash leg" },
      { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18 },
      { address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", symbol: "NVDA", decimals: 18, note: "NVIDIA -- stock token" },
      { address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", symbol: "SPY", decimals: 18, note: "S&P 500 ETF -- stock token" },
      { address: "0x12f190a9f9d7d37a250758b26824b97ce941bf54", symbol: "AMZN", decimals: 18, note: "Amazon -- stock token" },
      { address: "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681", symbol: "INTC", decimals: 18, note: "Intel -- stock token" },
    ],
    notice:
      "Live on Robinhood Chain mainnet. This reserve holds real USDG and Robinhood stock tokens; " +
      "minting moves real assets into it and redeeming returns them.",
  },
};

/**
 * Robinhood's stock tokens implement ERC-8056: a corporate action (split,
 * dividend) does NOT move raw balances, it moves a `uiMultiplier`.
 *
 * Custody is unaffected -- mint and redeem are pro-rata over raw units, so a
 * multiplier cancels for every holder equally (proven in
 * ssr-evm/test/SSRStockTokenMultiplier.t.sol). PRICING is the exposure: a
 * rebalance price quoted before a corporate action is wrong by exactly the
 * multiplier. The mitigation is configuration, applied at creation below:
 * ATOMIC_SWAP price control (auction opens and fills in one block) plus a
 * short maxAuctionLength, which also bounds the permissionless
 * openAuctionUnrestricted path.
 */
export const MULTIPLIER_WARNING =
  "Robinhood stock tokens use an ERC-8056 corporate-action multiplier. Custody is safe " +
  "(mint/redeem are pro-rata over raw units), but rebalance prices go stale across a split " +
  "or dividend. New reserves are created with atomic-swap pricing and a 5-minute auction cap.";

/**
 * Uniswap v3 on Robinhood Chain mainnet (Uniswap sdk-core, ROBINHOOD_ADDRESSES).
 * Used only to MARK basket assets to USDG from pool spot prices (slot0) --
 * never to trade from the app.
 */
export const UNISWAP_V3 = {
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address,
  fees: [100, 500, 3000, 10000] as const,
};
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** The Robinhood network the app shows. Testnet stays configured for development only. */
export const ROBINHOOD = CHAINS.mainnet;

/** Contract limits, mirrored from ssr-evm/contracts/utils/Constants.sol. */
export const LIMITS = {
  MIN_AUCTION_LENGTH: 120n,
  MAX_AUCTION_LENGTH: 604800n,
  MAX_MINT_FEE: 5n * 10n ** 16n, // 5%
  MIN_MINT_FEE: 3n * 10n ** 14n, // 0.03%
  MAX_TVL_FEE: 10n ** 17n, // 10%/year
} as const;

/** Safe defaults for a stock-token reserve -- see MULTIPLIER_WARNING. */
export const SAFE_REBALANCE_DEFAULTS = {
  /** 300s: bounds every auction, including openAuctionUnrestricted. */
  maxAuctionLength: 300n,
  /** PriceControl.ATOMIC_SWAP -- auction opens and fills in the same block. */
  priceControl: 2,
  weightControl: false,
} as const;

export const D18 = 10n ** 18n;

// --- Minimal hand-written ABIs: only what this app calls. ---

export const SSR_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "mintFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "tvlFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "maxAuctionLength", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "totalAssets",
    inputs: [],
    outputs: [{ name: "_assets", type: "address[]" }, { name: "_amounts", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    // OpenZeppelin Math.Rounding is { Floor, Ceil, Trunc, Expand }: Floor = 0,
    // Ceil = 1. Mint quotes round Ceil and redeem quotes round Floor -- the
    // same values SSR.mint/redeem pass internally, so a quote matches the fill.
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
 * the DAO's cut of every mint fee and the FLOOR beneath it -- the pair raised
 * from upstream's (1/3, 0.1%) so the Solana rule fits. Read live rather than
 * asserted: that is how this page proves the two chains agree.
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
  { type: "function", name: "mint", inputs: [{ name: "account", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
] as const;

/** ERC-8056, for reading true exposure alongside the raw balance. */
export const ERC8056_ABI = [
  { type: "function", name: "uiMultiplier", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOfUI", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

export const DEPLOYER_ABI = [
  { type: "function", name: "ssrImplementation", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  {
    type: "function",
    name: "deploySSR",
    inputs: [
      {
        name: "basicDetails",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "assets", type: "address[]" },
          { name: "amounts", type: "uint256[]" },
          { name: "initialShares", type: "uint256" },
        ],
      },
      {
        name: "additionalDetails",
        type: "tuple",
        components: [
          { name: "maxAuctionLength", type: "uint256" },
          { name: "feeRecipients", type: "tuple[]", components: [{ name: "recipient", type: "address" }, { name: "portion", type: "uint96" }] },
          { name: "immutableFeeRecipients", type: "tuple[]", components: [{ name: "recipient", type: "address" }, { name: "portion", type: "uint96" }] },
          { name: "tvlFee", type: "uint256" },
          { name: "mintFee", type: "uint256" },
          { name: "folioFeeForSelf", type: "uint256" },
          { name: "mandate", type: "string" },
        ],
      },
      {
        name: "folioFlags",
        type: "tuple",
        components: [
          { name: "trustedFillerEnabled", type: "bool" },
          { name: "rebalanceControl", type: "tuple", components: [{ name: "weightControl", type: "bool" }, { name: "priceControl", type: "uint8" }] },
          { name: "bidsEnabled", type: "bool" },
        ],
      },
      { name: "owner", type: "address" },
      { name: "basketManagers", type: "address[]" },
      { name: "auctionLaunchers", type: "address[]" },
      { name: "brandManagers", type: "address[]" },
      { name: "deploymentNonce", type: "bytes32" },
    ],
    outputs: [{ name: "folio", type: "address" }, { name: "proxyAdmin", type: "address" }],
    stateMutability: "nonpayable",
  },
] as const;
