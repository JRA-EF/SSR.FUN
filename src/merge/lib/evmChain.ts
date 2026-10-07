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
import { ROBINHOOD_ASSETS } from "./robinhoodAssets.generated";

export interface AssetRef {
  address: Address;
  symbol: string;
  decimals: number;
  /** Only mock assets expose an unguarded mint(); real ones never do. */
  faucetAmount?: bigint;
  note?: string;
}

/**
 * A Uniswap v3 deployment, or a fork of one. BNB's liquidity is on
 * PancakeSwap v3, whose fee tiers differ from Uniswap's -- which is why the
 * tiers travel with the deployment rather than being a module constant.
 */
export interface DexConfig {
  /** Shown to users ("bought on PancakeSwap"). */
  name: string;
  factory: Address;
  quoter: Address;
  router: Address;
  fees: readonly number[];
}

export interface QuoteRef {
  address: Address;
  symbol: string;
  decimals: number;
}

/**
 * An asset a chain offers WITHOUT a discovery catalogue: proposed by a human,
 * verified live by scripts/evm-chain-assets.mts (code, symbol, decimals, and
 * a minimum of quote-asset depth in its deepest pool), and carrying the pool
 * the launch flow buys it through. `quote` is a ROLE -- "usd" when the pool is
 * against the chain's dollar, "native" when against its wrapped native.
 */
export interface StarterAsset {
  address: Address;
  symbol: string;
  decimals: number;
  pool: { address: Address; fee: number; quote: "usd" | "native" };
}

/** The dollar leg and the native wrapper a chain prices through (USDG/WETH here, USDC/WETH on Base). */
export interface ChainQuotes {
  usd: QuoteRef;
  native: QuoteRef;
}

/**
 * One key per CHAIN. This used to be `"testnet" | "mainnet"` -- Robinhood's two
 * environments -- which made a second chain inexpressible.
 */
export type ChainKey = "robinhood" | "robinhood-testnet" | "base" | "bnb" | "ethereum";

export interface ChainConfig {
  key: ChainKey;
  /** Prefix for this chain's reserve ids in the shared /dtr/:id route ("rh" -> "rh-0x..."). Unique across chains. */
  idPrefix: string;
  /**
   * Whether the app OFFERS this chain. A config may be fully verified and
   * still not live: Base and BNB below have real, probe-verified DEX and quote
   * wiring but no deployed SSR stack, so they are reference entries for
   * `.claude/skills/evm-chain-onboarding`, not choices a creator can make.
   */
  live: boolean;
  chain: ReturnType<typeof defineChain>;
  explorer: string;
  /** The live SSR instance, or null when none has been created yet. */
  ssr: Address | null;
  /**
   * Same-origin proxy the BROWSER reads through (api/robinhood/rpc-proxy.ts),
   * which holds the keyed provider URL server-side. Wallets are still handed
   * the public RPC in wallet_addEthereumChain -- they sign and broadcast
   * through their own node, never through our key.
   */
  readProxyPath?: string;
  deployer: Address;
  /** Block the factory was created in -- where reserve discovery starts reading SSRDeployed logs. */
  deployerBlock: bigint;
  /**
   * The widest eth_getLogs range this chain's read endpoint accepts, or unset
   * for no cap. Measured 2026-10-06: BNB's publicnode accepts 5,000 blocks and
   * every other public BSC endpoint refuses getLogs outright; Base's public RPC
   * caps at 500. Discovery is chunked to this, so a capped endpoint degrades to
   * more calls instead of an empty directory.
   */
  logChunk?: bigint;
  versionRegistry: Address;
  feeRegistry: Address;
  roleRegistry: Address;
  fillerRegistry: Address;
  /** Assets the UI offers when creating a reserve. A product choice, not a contract limit. */
  assets: AssetRef[];
  /**
   * The Uniswap-v3-compatible DEX this chain is priced and traded through.
   *
   * Absent on a chain that has none (the mock testnet). Pricing then returns
   * null honestly, instead of what it used to do: read whichever factory
   * address happened to be a module constant -- which on any chain but
   * Robinhood mainnet finds no pool, so a perfectly good reserve reported
   * $0 AUM and no NAV. Proven on a Base fork, 2026-10-04; see
   * docs/project/MULTICHAIN_RESERVES.md.
   */
  dex?: DexConfig;
  /** The two assets every price routes through: the dollar, and the native wrapper. */
  quotes?: ChainQuotes;
  /**
   * For a chain with no discovery catalogue: the verified basket list the
   * launch form offers. Robinhood has a catalogue (api/robinhood/asset-catalogue)
   * and leaves this unset.
   */
  starterAssets?: StarterAsset[];
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

/** Uniswap v3 on Robinhood Chain mainnet (Uniswap sdk-core, ROBINHOOD_ADDRESSES). */
const ROBINHOOD_DEX: DexConfig = {
  name: "Uniswap",
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  router: "0xcaf681a66d020601342297493863e78c959e5cb2",
  fees: [100, 500, 3000, 10000],
};

const ROBINHOOD_QUOTES: ChainQuotes = {
  usd: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
  native: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18 },
};

const baseChain = defineChain({
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const bnbChain = defineChain({
  id: 56,
  name: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  // Handed to WALLETS (wallet_addEthereumChain), which send and then poll for
  // the receipt. publicnode refuses receipts ("archive"), so a wallet given it
  // would never see its own transaction confirm; BNB Chain's official endpoint
  // serves receipts and sends. The APP reads through the proxy, which routes
  // eth_getLogs to publicnode separately (api/robinhood/rpc-proxy.ts).
  rpcUrls: { default: { http: ["https://bsc-dataseed.bnbchain.org"] } },
  blockExplorers: { default: { name: "BscScan", url: "https://bscscan.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const ethereumChain = defineChain({
  id: 1,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Handed to wallets: publicnode serves receipts AND getLogs on Ethereum
  // (measured 2026-10-07), unlike its BNB and Base endpoints.
  rpcUrls: { default: { http: ["https://ethereum-rpc.publicnode.com"] } },
  blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const CHAINS: Record<ChainKey, ChainConfig> = {
  "robinhood-testnet": {
    key: "robinhood-testnet",
    idPrefix: "rht",
    live: false,
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
    // No DEX and no quote assets: these are mock tokens with no pools, so
    // nothing here can be priced and usdPrice says so rather than guessing.
    faucetUrl: "https://docs.robinhood.com/chain/",
    notice:
      "Testnet fixtures. The reserve here is a TEST deployment: its name, its basket and its balances " +
      "are made up, and the assets are mock tokens anyone can mint. Nothing on this network is real value. " +
      "You still need testnet ETH for gas -- the faucet button only mints basket assets.",
  },
  robinhood: {
    key: "robinhood",
    idPrefix: "rh",
    live: true,
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
    readProxyPath: "/api/robinhood/rpc-proxy",
    deployer: "0x81dd183c53C95F251869520d8DB10B0A4a4F8858",
    deployerBlock: 68886534n,
    versionRegistry: "0x835dd7fF172874749855aae0174c6ecAA82Ef1e6",
    feeRegistry: "0x03079d5f8d3B6d27827315205D1328b193c48d31",
    roleRegistry: "0x3a96Fd76dAB64be73404BF59587beF21773Dcd94",
    fillerRegistry: "0x95CB8550056680a004019fD45db4347A622C2CFc",
    // Only the two quote assets live here. Everything a Reserve can hold on
    // this chain is served by api/robinhood/asset-catalogue (built by
    // lib/robinhood/catalogue.ts from Uniswap v3 pools, with Robinhood stock
    // tokens proven by their contract code), which the Launch form fetches.
    assets: ROBINHOOD_ASSETS,
    dex: ROBINHOOD_DEX,
    quotes: ROBINHOOD_QUOTES,
    notice:
      "Live on Robinhood Chain mainnet. This reserve holds real USDG and Robinhood stock tokens; " +
      "minting moves real assets into it and redeeming returns them.",
  },

  // ---------------------------------------------------------------------
  // Reference entries. Every address below was read live from the chain by
  // scripts/evm-chain-probe.mts on 2026-10-05 and the whole launch path was
  // driven against a fork by scripts/verify_evm_chain_fork.mts. What they do
  // NOT have is a deployed SSR stack, so `deployer` is the zero address and
  // `live` is false. Deploy the stack, paste the five addresses in, flip
  // `live`, and the chain is offered -- that is the entire remaining step.
  // See .claude/skills/evm-chain-onboarding/SKILL.md.
  // ---------------------------------------------------------------------
  base: {
    key: "base",
    idPrefix: "base",
    live: true,
    chain: baseChain,
    // Logs go to publicnode via the proxy, which accepts 2,000 blocks.
    logChunk: 2_000n,
    readProxyPath: "/api/robinhood/rpc-proxy?chain=base",
    explorer: "https://basescan.org",
    ssr: null,
    // Deployed 2026-10-07 by scripts/go-live-evm-chain.sh at block 52,278,846;
    // registerVersion -> "6.0.0", admin = the owner key 0x8b41e427..., DAO fee
    // rule 50% with a 0.5% floor. Same addresses as Robinhood and BNB: the
    // deployer had never transacted on Base.
    deployer: "0x81dd183c53C95F251869520d8DB10B0A4a4F8858",
    deployerBlock: 52278846n,
    versionRegistry: "0x835dd7fF172874749855aae0174c6ecAA82Ef1e6",
    feeRegistry: "0x03079d5f8d3B6d27827315205D1328b193c48d31",
    roleRegistry: "0x3a96Fd76dAB64be73404BF59587beF21773Dcd94",
    fillerRegistry: "0x95CB8550056680a004019fD45db4347A622C2CFc",
    assets: [],
    dex: {
      name: "Uniswap",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      router: "0x2626664c2603336E57B271c5C0b26F421741e481",
      fees: [100, 500, 3000, 10000],
    },
    quotes: {
      usd: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
      native: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    },
    // Verified live 2026-10-06 by scripts/evm-chain-assets.mts: each has
    // >= $100,000 of quote asset in its deepest Uniswap v3 pool. Refused at that
    // floor ON UNISWAP: wstETH, cbETH, LINK, ZORA, EURC, USDbC, DAI -- most of
    // their Base liquidity is on Aerodrome, which would need its own adapter
    // (Slipstream keys pools by tick spacing, not fee). cbBTC is 8 decimals.
    starterAssets: [
      { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, pool: { address: "0x6c561B446416E1A00E8E93E221854d6eA4171372", fee: 3000, quote: "usd" } },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8, pool: { address: "0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1", fee: 500, quote: "native" } },
      { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18, pool: { address: "0x3d5D143381916280ff91407FeBEB52f2b60f33Cf", fee: 3000, quote: "native" } },
      { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", symbol: "BRETT", decimals: 18, pool: { address: "0xBA3F945812a83471d709BCe9C3CA699A19FB46f7", fee: 10000, quote: "native" } },
      { address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", symbol: "MORPHO", decimals: 18, pool: { address: "0x2F42Df4aF5312B492E9d7F7b2110D9c7bf2D9e4F", fee: 3000, quote: "native" } },
      { address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", symbol: "TOSHI", decimals: 18, pool: { address: "0x4b0Aaf3EBb163dd45F663b38b6d93f6093EBC2d3", fee: 10000, quote: "native" } },
      { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", symbol: "VIRTUAL", decimals: 18, pool: { address: "0x529d2863a1521d0b57db028168fdE2E97120017C", fee: 3000, quote: "usd" } },
      { address: "0x63706e401c06ac8513145b7687A14804d17f814b", symbol: "AAVE", decimals: 18, pool: { address: "0x2e86514CFd61Fb19c5cf2b879d536D273d6E693d", fee: 3000, quote: "native" } },
      { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN", decimals: 18, pool: { address: "0x0cA6485b7e9cF814A3Fd09d81672B07323535b64", fee: 10000, quote: "native" } },
      { address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83", symbol: "UNI", decimals: 18, pool: { address: "0xAb365f161Dd501473a1ff0D2ef0dCE94E7398839", fee: 10000, quote: "native" } },
    ],
    isMock: false,
    notice: "Live on Base. Reserves hold real ERC-20 assets, swapped into on Uniswap; minting moves real assets in and redeeming returns them.",
  },
  bnb: {
    key: "bnb",
    idPrefix: "bnb",
    live: true,
    chain: bnbChain,
    logChunk: 5_000n,
    readProxyPath: "/api/robinhood/rpc-proxy?chain=bnb",
    explorer: "https://bscscan.com",
    ssr: null,
    // Deployed 2026-10-06 by scripts/go-live-evm-chain.sh at block 126,130,904;
    // registerVersion -> "6.0.0", admin = the owner key 0x8b41e427... (the
    // single-key governance the Creator accepted for the port). The deployer
    // had never transacted on BNB, so these are Robinhood mainnet's addresses.
    deployer: "0x81dd183c53C95F251869520d8DB10B0A4a4F8858",
    deployerBlock: 126130904n,
    versionRegistry: "0x835dd7fF172874749855aae0174c6ecAA82Ef1e6",
    feeRegistry: "0x03079d5f8d3B6d27827315205D1328b193c48d31",
    roleRegistry: "0x3a96Fd76dAB64be73404BF59587beF21773Dcd94",
    fillerRegistry: "0x95CB8550056680a004019fD45db4347A622C2CFc",
    assets: [],
    // PancakeSwap v3, not Uniswap: it is a Uniswap v3 fork answering the same
    // calls (so no adapter), its USDT/WBNB pool is the deeper market, and its
    // fee tiers differ -- 2500 where Uniswap has 3000.
    dex: {
      name: "PancakeSwap",
      factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
      router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
      fees: [100, 500, 2500, 10000],
    },
    // BOTH of these are 18 decimals on BNB, not the 6 a dollar has elsewhere.
    quotes: {
      usd: { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
      native: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18 },
    },
    // Verified live 2026-10-06 by scripts/evm-chain-assets.mts: each has
    // >= $100,000 of quote asset in its deepest PancakeSwap v3 pool. Refused
    // at that floor: TRX, DOT, LTC, UNI, FDUSD, AVAX, XVS, FIL, SHIB, BCH, ATOM.
    // Note DOGE is 8 decimals here and USDC is 18 -- never assume.
    starterAssets: [
      { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18, pool: { address: "0x172fcD41E0913e95784454622d1c3724f546f849", fee: 100, quote: "usd" } },
      { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18, pool: { address: "0x92b7807bF19b7DDdf89b706143896d05228f3121", fee: 100, quote: "usd" } },
      { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", decimals: 18, pool: { address: "0x6bbc40579ad1BBD243895cA0ACB086BB6300d636", fee: 500, quote: "native" } },
      { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", decimals: 18, pool: { address: "0xD0e226f674bBf064f54aB47F42473fF80DB98CBA", fee: 500, quote: "native" } },
      { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", symbol: "Cake", decimals: 18, pool: { address: "0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1", fee: 2500, quote: "usd" } },
      { address: "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", symbol: "SOL", decimals: 18, pool: { address: "0xbFFEc96e8f3b5058B1817c14E4380758Fada01EF", fee: 500, quote: "native" } },
      { address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", symbol: "LINK", decimals: 18, pool: { address: "0x0E1893BEEb4d0913d26B9614B18Aea29c56d94b9", fee: 2500, quote: "native" } },
      { address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", symbol: "XRP", decimals: 18, pool: { address: "0x71f5a8F7d448E59B1ede00A19fE59e05d125E742", fee: 2500, quote: "usd" } },
      { address: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47", symbol: "ADA", decimals: 18, pool: { address: "0x673516E510d702Ab5F2bBf0c6B545111a85f7ea7", fee: 2500, quote: "native" } },
      { address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43", symbol: "DOGE", decimals: 8, pool: { address: "0xce6160bB594fC055c943F59De92ceE30b8c6B32c", fee: 2500, quote: "native" } },
      { address: "0x4B0F1812e5Df2A09796481Ff14017e6005508003", symbol: "TWT", decimals: 18, pool: { address: "0x8cCB4544b3030dACF3d4D71C658f04e8688e25b1", fee: 2500, quote: "native" } },
    ],
    isMock: false,
    notice: "Live on BNB Smart Chain. Reserves hold real BEP-20 assets, swapped into on PancakeSwap; minting moves real assets in and redeeming returns them.",
  },
  ethereum: {
    key: "ethereum",
    idPrefix: "eth",
    live: false,
    chain: ethereumChain,
    // publicnode serves getLogs up to 10,000 blocks on Ethereum.
    logChunk: 10_000n,
    readProxyPath: "/api/robinhood/rpc-proxy?chain=ethereum",
    explorer: "https://etherscan.io",
    ssr: null,
    deployer: "0x0000000000000000000000000000000000000000",
    deployerBlock: 0n,
    versionRegistry: "0x0000000000000000000000000000000000000000",
    feeRegistry: "0x0000000000000000000000000000000000000000",
    roleRegistry: "0x0000000000000000000000000000000000000000",
    fillerRegistry: "0x0000000000000000000000000000000000000000",
    assets: [],
    dex: {
      name: "Uniswap",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      fees: [100, 500, 3000, 10000],
    },
    quotes: {
      usd: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
      native: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    },
    // Verified live 2026-10-07 by scripts/evm-chain-assets.mts at a $250,000
    // floor (higher than BNB/Base: this is Ethereum). Refused at that floor:
    // LDO, RNDR, CRV, PEPE, SHIB, MORPHO, ARB. EXCLUDED: MKR, whose symbol() is
    // a bytes32, not a string -- the app reads symbols as strings, so a reserve
    // holding it would not load (MKR is migrating to SKY, which is listed).
    // USDT is listed: its approve() returns no data, which the app's approve
    // ABI now tolerates. WBTC and cbBTC are 8 decimals; USDT is 6.
    starterAssets: [
      { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18, pool: { address: "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8", fee: 3000, quote: "usd" } },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, pool: { address: "0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36", fee: 3000, quote: "native" } },
      { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8, pool: { address: "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD", fee: 3000, quote: "native" } },
      { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", symbol: "AAVE", decimals: 18, pool: { address: "0x5aB53EE1d50eeF2C1DD3d5402789cd27bB52c1bB", fee: 3000, quote: "native" } },
      { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18, pool: { address: "0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8", fee: 3000, quote: "native" } },
      { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", symbol: "wstETH", decimals: 18, pool: { address: "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa", fee: 100, quote: "native" } },
      { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", decimals: 18, pool: { address: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801", fee: 3000, quote: "native" } },
      { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18, pool: { address: "0xC2e9F25Be6257c210d7Adf0D4Cd6E3E881ba25f8", fee: 3000, quote: "native" } },
      { address: "0x57e114B691Db790C35207b2e685D4A43181e6061", symbol: "ENA", decimals: 18, pool: { address: "0xc3Db44ADC1fCdFd5671f555236eae49f4A8EEa18", fee: 3000, quote: "native" } },
      { address: "0x56072C95FAA701256059aa122697B133aDEd9279", symbol: "SKY", decimals: 18, pool: { address: "0x764510aB1d39CF300e7abe8F5B8977D18F290628", fee: 3000, quote: "native" } },
      { address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3", symbol: "ONDO", decimals: 18, pool: { address: "0x7b1E5D984A43eE732de195628d20d05CFaBc3cC7", fee: 3000, quote: "native" } },
      { address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", symbol: "PAXG", decimals: 18, pool: { address: "0x5aE13BAAEF0620FdaE1D355495Dc51a17adb4082", fee: 500, quote: "usd" } },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8, pool: { address: "0x15aA01580ae866f9FF4DBe45E06e307941d90C7b", fee: 3000, quote: "native" } },
    ],
    isMock: false,
    notice: "Ethereum is wired and fork-verified but has no deployed SSR stack yet.",
  },
};

/** The chains a creator may actually choose, in display order. */
export const LIVE_EVM_CHAINS: ChainConfig[] = Object.values(CHAINS).filter((c) => c.live);

export function chainByKey(key: string): ChainConfig | null {
  return (CHAINS as Record<string, ChainConfig | undefined>)[key] ?? null;
}

/** The chain owning a reserve-id prefix ("rh" -> Robinhood). Unique by construction; a duplicate prefix is a bug. */
export function chainByIdPrefix(prefix: string): ChainConfig | null {
  return Object.values(CHAINS).find((c) => c.idPrefix === prefix) ?? null;
}

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
 * Robinhood mainnet's DEX and quote assets, kept as flat exports for the
 * Robinhood-specific UI that still reads them directly. DERIVED from the
 * chain config above -- these are a convenience, never a second source of
 * truth, and nothing chain-agnostic may import them.
 */
export const UNISWAP_V3 = { factory: ROBINHOOD_DEX.factory, fees: ROBINHOOD_DEX.fees };
export const USDG: Address = ROBINHOOD_QUOTES.usd.address;
export const WETH: Address = ROBINHOOD_QUOTES.native.address;

/** The Robinhood network the app shows. Testnet stays configured for development only. */
export const ROBINHOOD = CHAINS.robinhood;

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
  // The Folio's one free-text field. An SSR.FUN reserve stores its metadata
  // URL here (see evmReserveMeta.ts); verified live on the first mainnet
  // reserve 2026-09-30 (Folio 6.0.0 answers `mandate()`).
  { type: "function", name: "mandate", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
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
    // Deliberately no outputs. USDT on Ethereum returns NO data from approve()
    // (read live 2026-10-07: return data "0x"), and a declared bool makes the
    // simulation fail decoding an empty result -- so any basket holding USDT
    // could never be approved. Nothing here reads the bool; a failed approval
    // still reverts and is caught by the receipt check.
    outputs: [],
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
