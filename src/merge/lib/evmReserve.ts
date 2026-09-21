// Read/write helpers for the EVM half of SSR (Robinhood Chain), kept out of
// the React page so the page stays presentational.
//
// The Solana side of this app never imports anything here and vice versa: the
// two chains are separate deployments, and entangling them would make a bug on
// one look like a bug on the other.
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
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
  type AssetRef,
  type ChainConfig,
} from "./evmChain";

export function publicClientFor(cfg: ChainConfig): PublicClient {
  return createPublicClient({ chain: cfg.chain, transport: http() }) as PublicClient;
}

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

export interface BasketRow {
  address: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  /** ERC-8056 corporate-action multiplier, when the token has one. */
  uiMultiplier?: bigint;
}

export interface ReserveSnapshot {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  mintFee: bigint;
  maxAuctionLength: bigint;
  daoFeeBps: bigint;
  feeFloor: bigint;
  basket: BasketRow[];
}

export async function loadReserve(pc: PublicClient, cfg: ChainConfig): Promise<ReserveSnapshot> {
  const ssr = cfg.ssr!;
  const [name, symbol, decimals, totalSupply, mintFee, maxAuctionLength] = await Promise.all([
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "name" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "symbol" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "decimals" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "totalSupply" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "mintFee" }),
    pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "maxAuctionLength" }),
  ]);

  const [, feeNumerator, feeDenominator, feeFloor] = await pc.readContract({
    address: cfg.feeRegistry,
    abi: FEE_REGISTRY_ABI,
    functionName: "getFeeDetails",
    args: [ssr],
  });

  const [assets, amounts] = await pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "totalAssets" });
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
      return { address: a, symbol: sym, decimals: Number(dec), amount: amounts[i], uiMultiplier };
    }),
  );

  return {
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply,
    mintFee,
    maxAuctionLength,
    daoFeeBps: (feeNumerator * 10000n) / feeDenominator,
    feeFloor,
    basket,
  };
}

/**
 * The fee rule the registry applies to a reserve that does not exist yet --
 * `getFeeDetails(address(0))` returns the deployment's defaults. Real, live,
 * on-chain values, which is what a chain with no instance can honestly show.
 */
export async function loadRegistryDefaults(pc: PublicClient, cfg: ChainConfig) {
  const [recipient, num, den, floor] = await pc.readContract({
    address: cfg.feeRegistry,
    abi: FEE_REGISTRY_ABI,
    functionName: "getFeeDetails",
    args: ["0x0000000000000000000000000000000000000000"],
  });
  return { recipient, daoFeeBps: (num * 10000n) / den, feeFloor: floor };
}

/** Mirrors SSRLib.computeMintFees so a quote matches what will execute. */
export async function mintFeeBreakdown(pc: PublicClient, cfg: ChainConfig, shares: bigint) {
  const ssr = cfg.ssr!;
  const mintFee = await pc.readContract({ address: ssr, abi: SSR_ABI, functionName: "mintFee" });
  const [, num, den, floor] = await pc.readContract({
    address: cfg.feeRegistry,
    abi: FEE_REGISTRY_ABI,
    functionName: "getFeeDetails",
    args: [ssr],
  });
  let total = (shares * mintFee + D18 - 1n) / D18;
  let dao = (total * num + den - 1n) / den;
  const minDao = (shares * floor + D18 - 1n) / D18;
  if (dao < minDao) dao = minDao; // the DAO floor can bind above the SSR's own fee
  if (total < dao) total = dao;
  return { total, dao, out: shares - total };
}

/** Assets and amounts a mint of `shares` will cost (Ceil, as mint() rounds). */
export function quoteMintCost(pc: PublicClient, cfg: ChainConfig, shares: bigint) {
  return pc.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "toAssets", args: [shares, 1] });
}

/** Assets and amounts a redeem of `shares` returns (Floor, as redeem() rounds). */
export function quoteRedeemProceeds(pc: PublicClient, cfg: ChainConfig, shares: bigint) {
  return pc.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "toAssets", args: [shares, 0] });
}

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
 * Deploys a new reserve through the SSR factory.
 *
 * The starting basket is pulled from the CALLER by deploySSR, so each leg is
 * approved to the deployer -- not to the reserve, which does not exist yet.
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
): Promise<`0x${string}`> {
  for (const leg of input.legs) {
    await approveIfNeeded(pc, wallet, cfg, account, leg.asset.address, cfg.deployer, leg.amount, () =>
      onProgress?.(`Approving ${leg.asset.symbol}...`),
    );
  }
  onProgress?.("Deploying the reserve...");
  return wallet.writeContract({
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
    chain: cfg.chain,
    account,
  });
}

export { SSR_ABI, ERC20_ABI };
