// Read/write helpers for the Robinhood Chain (EVM) half of SSR, kept out of
// the React components so they stay presentational.
//
// Nothing on the Solana side imports this, and this imports nothing from it:
// the two chains are separate deployments, and entangling them would make a
// bug on one look like a bug on the other. They meet only in the UI --
// Discover lists both, Create lets you pick one, and a reserve page is chosen
// by its id.
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseAbi,
  parseAbiItem,
  parseUnits,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  D18,
  DEPLOYER_ABI,
  ERC20_ABI,
  ERC8056_ABI,
  FEE_REGISTRY_ABI,
  SAFE_REBALANCE_DEFAULTS,
  SSR_ABI,
  UNISWAP_V3,
  USDG,
  WETH,
  type AssetRef,
  type ChainConfig,
} from "./evmChain";

/** Reserve ids in the app's /dtr/:id route (see evmReserveId.ts, which the router uses viem-free). */
export { RH_ID_PREFIX, rhReserveId, rhAddressFromId } from "./evmReserveId";

const clients = new Map<number, PublicClient>();
/** One client per chain, batching reads through Multicall3 -- the public RPC rate-limits bursts. */
export function publicClientFor(cfg: ChainConfig): PublicClient {
  let c = clients.get(cfg.chain.id);
  if (!c) {
    // In the browser, read through our own proxy (keyed provider, server-side);
    // outside it (scripts, tests) there is no origin, so use the chain's RPC.
    const url = cfg.readProxyPath && typeof window !== "undefined" ? `${window.location.origin}${cfg.readProxyPath}` : undefined;
    c = createPublicClient({
      chain: cfg.chain,
      transport: http(url, { batch: true }),
      batch: { multicall: !!cfg.chain.contracts?.multicall3 },
    }) as PublicClient;
    clients.set(cfg.chain.id, c);
  }
  return c;
}

// ------------------------------------------------------------------ wallet

export function injectedProvider(): EIP1193Provider {
  const p = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!p) throw new Error("No EVM wallet found. Install MetaMask (or any injected wallet) and reload.");
  return p;
}

/**
 * Asks the wallet for this chain, adding it if the wallet has never seen it.
 * 4902 is the EIP-1193 "unrecognised chain" code; anything else is a real
 * failure and is re-thrown rather than swallowed.
 */
export async function ensureChain(provider: EIP1193Provider, cfg: ChainConfig) {
  const hexId = `0x${cfg.chain.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: cfg.chain.name,
          nativeCurrency: cfg.chain.nativeCurrency,
          rpcUrls: [...cfg.chain.rpcUrls.default.http],
          blockExplorerUrls: [cfg.explorer],
        },
      ],
    } as never);
  }
}

export async function connectWallet(cfg: ChainConfig): Promise<{ wallet: WalletClient; account: Address }> {
  const provider = injectedProvider();
  await ensureChain(provider, cfg);
  const [account] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!account) throw new Error("The wallet returned no account.");
  const wallet = createWalletClient({ account, chain: cfg.chain, transport: custom(provider) });
  return { wallet, account };
}

/**
 * Turns a thrown value into something a person can act on. viem puts the
 * useful line in `shortMessage`; a bare `message` is usually the whole
 * simulation dump, so it is truncated rather than flooding the page.
 */
export function describeEvmError(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  if (err?.shortMessage) return err.shortMessage;
  if (err?.details) return err.details;
  const m = err?.message ?? String(e);
  return m.length > 240 ? `${m.slice(0, 240)}...` : m;
}

// ------------------------------------------------------------------ format

export function fmtUnits(v: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(v, decimals);
  if (!s.includes(".")) return s;
  const [w, f] = s.split(".");
  const trimmed = f.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${w}.${trimmed}` : w;
}

/** Percent from a D18 fraction, e.g. 0.01e18 -> "1%". */
export const pctFromD18 = (v: bigint, frac = 4) => `${fmtUnits(v * 100n, 18, frac)}%`;

export function parsePercentToD18(raw: string, field: string): bigint {
  const n = raw.trim();
  if (!n || !/^\d*\.?\d+$/.test(n)) throw new Error(`${field} must be a number.`);
  return parseUnits(n, 16); // 1% -> 0.01e18
}

export function parseAmount(raw: string, decimals: number, field: string): bigint {
  const n = raw.trim();
  if (!n || !/^\d*\.?\d+$/.test(n) || Number(n) <= 0) throw new Error(`${field} must be greater than zero.`);
  return parseUnits(n, decimals);
}

// ----------------------------------------------------------------- pricing

const V3_FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const V3_POOL_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/**
 * Spot price of `token` in `quote`, from the deepest Uniswap v3 pool between
 * them (slot0, so no price impact from probing). Null when no pool has
 * in-range liquidity. Pool prices are per RAW token, which is what a
 * reserve's balanceOf holds -- so this stays correct for ERC-8056 stock
 * tokens without touching the multiplier.
 */
async function v3Spot(pc: PublicClient, token: Address, tokenDec: number, quote: Address, quoteDec: number): Promise<number | null> {
  const pools = await Promise.all(
    UNISWAP_V3.fees.map((fee) => pc.readContract({ address: UNISWAP_V3.factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [token, quote, fee] })),
  );
  const live = pools.filter((p) => p !== zeroAddress);
  if (live.length === 0) return null;
  const liq = await Promise.all(live.map((p) => pc.readContract({ address: p, abi: V3_POOL_ABI, functionName: "liquidity" })));
  let best = -1;
  liq.forEach((l, i) => {
    if (l > 0n && (best < 0 || l > liq[best])) best = i;
  });
  if (best < 0) return null;
  const [sqrtPriceX96] = await pc.readContract({ address: live[best], abi: V3_POOL_ABI, functionName: "slot0" });
  const tokenIs0 = token.toLowerCase() < quote.toLowerCase();
  const [dec0, dec1] = tokenIs0 ? [tokenDec, quoteDec] : [quoteDec, tokenDec];
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = ratio * ratio * 10 ** (dec0 - dec1); // token1 per token0, human units
  return tokenIs0 ? p1per0 : p1per0 === 0 ? null : 1 / p1per0;
}

/** USD (USDG) price of one whole token: direct USDG pool, else routed through WETH. */
export async function usdPrice(pc: PublicClient, token: Address, decimals: number): Promise<number | null> {
  if (token.toLowerCase() === USDG.toLowerCase()) return 1;
  const direct = await v3Spot(pc, token, decimals, USDG, 6);
  if (direct !== null) return direct;
  const inWeth = await v3Spot(pc, token, decimals, WETH, 18);
  const wethUsd = await v3Spot(pc, WETH, 18, USDG, 6);
  return inWeth !== null && wethUsd !== null ? inWeth * wethUsd : null;
}

// ------------------------------------------------------------------- reads

export interface BasketRow {
  address: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  /** ERC-8056 corporate-action multiplier, when the token has one. */
  uiMultiplier?: bigint;
  /** USD value of `amount`, or null when no pool can price it. */
  usd: number | null;
}

export interface ReserveSnapshot {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  mintFee: bigint;
  maxAuctionLength: bigint;
  daoFeeBps: bigint;
  feeFloor: bigint;
  basket: BasketRow[];
  /** Sum of priced legs; null if any leg could not be priced. */
  aumUsd: number | null;
  navPerShare: number | null;
}

export async function loadReserve(pc: PublicClient, cfg: ChainConfig, ssr: Address): Promise<ReserveSnapshot> {
  const [name, symbol, decimals, totalSupply, mintFee, maxAuctionLength, feeDetails, totalAssets] = await Promise.all([
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "name" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "symbol" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "decimals" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "totalSupply" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "mintFee" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "maxAuctionLength" }),
    pc.readContract({ address: cfg.feeRegistry, abi: FEE_REGISTRY_ABI, functionName: "getFeeDetails", args: [ssr] }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "totalAssets" }),
  ]);
  const [, feeNumerator, feeDenominator, feeFloor] = feeDetails;
  const [assets, amounts] = totalAssets;

  const basket = await Promise.all(
    assets.map(async (a, i): Promise<BasketRow> => {
      const [sym, dec] = await Promise.all([
        pc.readContract({ address: a, abi: ERC20_ABI, functionName: "symbol" }),
        pc.readContract({ address: a, abi: ERC20_ABI, functionName: "decimals" }),
      ]);
      // ERC-8056 is optional; a plain ERC-20 simply has no multiplier.
      let uiMultiplier: bigint | undefined;
      try {
        uiMultiplier = await pc.readContract({ address: a, abi: ERC8056_ABI, functionName: "uiMultiplier" });
      } catch {
        uiMultiplier = undefined;
      }
      let usd: number | null = null;
      try {
        const px = await usdPrice(pc, a, Number(dec));
        usd = px === null ? null : Number(formatUnits(amounts[i], Number(dec))) * px;
      } catch {
        usd = null;
      }
      return { address: a, symbol: sym, decimals: Number(dec), amount: amounts[i], uiMultiplier, usd };
    }),
  );

  const aumUsd = basket.every((b) => b.usd !== null) ? basket.reduce((s, b) => s + (b.usd ?? 0), 0) : null;
  const supply = Number(formatUnits(totalSupply, Number(decimals)));
  return {
    address: ssr,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply,
    mintFee,
    maxAuctionLength,
    daoFeeBps: (feeNumerator * 10000n) / feeDenominator,
    feeFloor,
    basket,
    aumUsd,
    navPerShare: aumUsd !== null && supply > 0 ? aumUsd / supply : null,
  };
}

const SSR_DEPLOYED = parseAbiItem("event SSRDeployed(address indexed folioOwner, address indexed folio, address folioAdmin)");

/** Every reserve ever created through this chain's factory, oldest first, straight from its logs. */
export async function listReserveAddresses(pc: PublicClient, cfg: ChainConfig): Promise<Address[]> {
  const logs = await pc.getLogs({ address: cfg.deployer, event: SSR_DEPLOYED, fromBlock: cfg.deployerBlock, toBlock: "latest" });
  return logs.map((l) => l.args.folio).filter((a): a is Address => !!a);
}

/** Mirrors SSRLib.computeMintFees so a quote matches what will execute. */
export async function mintFeeBreakdown(pc: PublicClient, cfg: ChainConfig, ssr: Address, shares: bigint) {
  const [mintFee, [, num, den, floor]] = await Promise.all([
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "mintFee" }),
    pc.readContract({ address: cfg.feeRegistry, abi: FEE_REGISTRY_ABI, functionName: "getFeeDetails", args: [ssr] }),
  ]);
  let total = (shares * mintFee + D18 - 1n) / D18;
  let dao = (total * num + den - 1n) / den;
  const minDao = (shares * floor + D18 - 1n) / D18;
  if (dao < minDao) dao = minDao; // the DAO floor can bind above the SSR's own fee
  if (total < dao) total = dao;
  return { total, dao, out: shares - total };
}

/** Assets and amounts a mint of `shares` will cost (Ceil, as mint() rounds). */
export function quoteMintCost(pc: PublicClient, ssr: Address, shares: bigint) {
  return pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "toAssets", args: [shares, 1] });
}

/** Assets and amounts a redeem of `shares` returns (Floor, as redeem() rounds). */
export function quoteRedeemProceeds(pc: PublicClient, ssr: Address, shares: bigint) {
  return pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "toAssets", args: [shares, 0] });
}

// ------------------------------------------------------------------ writes

/**
 * Approves exactly what is needed, never unlimited: Folio uses the allowance
 * as the minter's slippage limit (see SSR.mint), so a max approval would
 * quietly remove that protection.
 */
export async function approveIfNeeded(
  pc: PublicClient,
  wallet: WalletClient,
  cfg: ChainConfig,
  account: Address,
  token: Address,
  spender: Address,
  needed: bigint,
  onProgress?: (msg: string) => void,
) {
  if (needed === 0n) return;
  const allowance = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account, spender] });
  if (allowance >= needed) return;
  onProgress?.("Approving...");
  const hash = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, needed], chain: cfg.chain, account });
  await pc.waitForTransactionReceipt({ hash });
}

export interface CreateReserveInput {
  name: string;
  symbol: string;
  legs: { asset: AssetRef; amount: bigint }[];
  initialShares: bigint;
  mintFee: bigint;
  tvlFee: bigint;
  owner: Address;
}

/**
 * Deploys a new reserve through the SSR factory and returns its address.
 *
 * The starting basket is pulled from the CALLER by deploySSR, so each leg is
 * approved to the factory -- not to the reserve, which does not exist yet.
 * The call is simulated before it is sent, which both catches a revert
 * before the user pays gas and yields the new reserve's address.
 *
 * Rebalance settings are fixed to the stock-token-safe pair: ATOMIC_SWAP
 * pricing (an auction opens and fills in one block) and a short auction cap,
 * which also bounds the permissionless openAuctionUnrestricted path. See
 * MULTIPLIER_WARNING in evmChain.ts for why.
 */
export async function createReserve(
  pc: PublicClient,
  wallet: WalletClient,
  cfg: ChainConfig,
  account: Address,
  input: CreateReserveInput,
  onProgress?: (msg: string) => void,
): Promise<{ hash: `0x${string}`; reserve: Address }> {
  for (const leg of input.legs) {
    await approveIfNeeded(pc, wallet, cfg, account, leg.asset.address, cfg.deployer, leg.amount, () =>
      onProgress?.(`Approving ${leg.asset.symbol}...`),
    );
  }
  onProgress?.("Deploying the reserve...");
  const { request, result } = await pc.simulateContract({
    account,
    address: cfg.deployer,
    abi: DEPLOYER_ABI,
    functionName: "deploySSR",
    args: [
      {
        name: input.name,
        symbol: input.symbol,
        assets: input.legs.map((l) => l.asset.address),
        amounts: input.legs.map((l) => l.amount),
        initialShares: input.initialShares,
      },
      {
        maxAuctionLength: SAFE_REBALANCE_DEFAULTS.maxAuctionLength,
        feeRecipients: [{ recipient: input.owner, portion: D18 }],
        immutableFeeRecipients: [],
        tvlFee: input.tvlFee,
        mintFee: input.mintFee,
        folioFeeForSelf: 0n,
        mandate: input.name,
      },
      {
        trustedFillerEnabled: false,
        rebalanceControl: { weightControl: SAFE_REBALANCE_DEFAULTS.weightControl, priceControl: SAFE_REBALANCE_DEFAULTS.priceControl },
        bidsEnabled: true,
      },
      input.owner,
      [input.owner],
      [input.owner],
      [input.owner],
      `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`,
    ],
  });
  const hash = await wallet.writeContract(request);
  await pc.waitForTransactionReceipt({ hash });
  return { hash, reserve: result[0] };
}

export { SSR_ABI, ERC20_ABI };
