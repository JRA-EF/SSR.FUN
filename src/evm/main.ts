// The EVM app (evm.html -> /evm). Built by Vite as its own entry: it shares
// nothing with the Solana app -- no wallet adapter, no web3.js, no store --
// because the two chains are separate deployments and entangling them would
// make a bug on one look like a bug on the other.
//
// Three views:
//   Reserve   -- read a live SSR instance, mint and redeem against it
//   Create    -- deploy a new reserve through the SSR factory
//   Contracts -- what is actually deployed on the selected chain
//
// Testnet carries a live instance over mock assets. Mainnet carries the
// factory and the configured fee rule but no instance yet; the UI says so
// instead of rendering an empty reserve.
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
  CHAINS,
  D18,
  DEPLOYER_ABI,
  ERC20_ABI,
  ERC8056_ABI,
  FEE_REGISTRY_ABI,
  LIMITS,
  MULTIPLIER_WARNING,
  SAFE_REBALANCE_DEFAULTS,
  SSR_ABI,
  type AssetRef,
  type ChainConfig,
} from "./chain";

// ------------------------------------------------------------------ state

const CHAIN_KEY = "ssr.fun:evm:chain";

let cfg: ChainConfig = CHAINS[(localStorage.getItem(CHAIN_KEY) as "testnet" | "mainnet") ?? "testnet"] ?? CHAINS.testnet;
let publicClient: PublicClient = makeClient(cfg);
let wallet: WalletClient | null = null;
let account: Address | null = null;

interface BasketRow {
  address: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  /** ERC-8056 multiplier, when the token has one. */
  uiMultiplier?: bigint;
}
let basket: BasketRow[] = [];
let shareDecimals = 18;
let totalSupply = 0n;

function makeClient(c: ChainConfig): PublicClient {
  return createPublicClient({ chain: c.chain, transport: http() }) as PublicClient;
}

// ---------------------------------------------------------------- helpers

const $ = (id: string) => document.getElementById(id)!;
const setText = (id: string, v: string) => {
  $(id).textContent = v;
};
const show = (id: string, on: boolean) => {
  if (on) $(id).removeAttribute("hidden");
  else $(id).setAttribute("hidden", "");
};

function status(id: string, message: string, kind: "ok" | "err" | "busy" | "" = "") {
  const el = $(id);
  el.textContent = message;
  el.className = `msg ${kind}`;
}

/**
 * Turns a thrown value into something a tester can act on. viem puts the
 * useful line in `shortMessage`; a bare `message` is usually the whole
 * simulation dump, so it is truncated rather than flooding the page.
 */
function describeError(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  if (err?.shortMessage) return err.shortMessage;
  if (err?.details) return err.details;
  const m = err?.message ?? String(e);
  return m.length > 240 ? `${m.slice(0, 240)}...` : m;
}

function fmt(v: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(v, decimals);
  if (!s.includes(".")) return s;
  const [w, f] = s.split(".");
  const trimmed = f.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${w}.${trimmed}` : w;
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const txLink = (h: string) => `${cfg.explorer}/tx/${h}`;
const addrLink = (a: string) => `${cfg.explorer}/address/${a}`;

/** Percent from a D18 fraction, e.g. 0.01e18 -> "1%". */
const pctFromD18 = (v: bigint, frac = 4) => `${fmt(v * 100n, 18, frac)}%`;

function parsePercentToD18(raw: string, field: string): bigint {
  const n = raw.trim();
  if (!n || !/^\d*\.?\d+$/.test(n)) throw new Error(`${field} must be a number.`);
  return parseUnits(n, 16); // 1% -> 0.01e18
}

// ------------------------------------------------------------------ wallet

function injectedProvider(): EIP1193Provider {
  const p = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!p) throw new Error("No EVM wallet found. Install MetaMask (or any injected wallet) and reload.");
  return p;
}

/**
 * Asks the wallet for the selected chain, adding it if the wallet has never
 * seen it. 4902 is the EIP-1193 "unrecognised chain" code; anything else is a
 * real failure and is re-thrown rather than swallowed.
 */
async function ensureChain(provider: EIP1193Provider) {
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

async function connect() {
  status("global-msg", "Connecting...", "busy");
  try {
    const provider = injectedProvider();
    await ensureChain(provider);
    const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
    if (!addr) throw new Error("The wallet returned no account.");
    account = addr;
    wallet = createWalletClient({ account: addr, chain: cfg.chain, transport: custom(provider) });
    ($("connect") as HTMLButtonElement).textContent = short(addr);
    status("global-msg", "", "");

    // A wallet can switch account or network under us; re-read rather than
    // keep acting on a stale address.
    provider.on?.("accountsChanged", () => window.location.reload());
    provider.on?.("chainChanged", () => window.location.reload());

    await refresh();
  } catch (e) {
    status("global-msg", describeError(e), "err");
  }
}

// ------------------------------------------------------------------- reads

async function refresh() {
  renderContracts();
  $("chain-notice").textContent = cfg.notice;
  show("multiplier-notice", cfg.key === "mainnet");
  if (cfg.key === "mainnet") $("multiplier-notice").textContent = MULTIPLIER_WARNING;

  if (!cfg.ssr) {
    show("instance-wrap", false);
    show("no-instance", true);
    setText(
      "no-instance-text",
      `The SSR factory is live on ${cfg.chain.name}, but nobody has created a reserve through it yet. ` +
        `Creating one deploys a new contract and moves your chosen assets into it as the starting basket.`,
    );
    return;
  }
  show("no-instance", false);
  show("instance-wrap", true);

  status("global-msg", "Loading...", "busy");
  try {
    const ssr = cfg.ssr;
    const [name, symbol, decimals, supply, mintFee, maxAuctionLength] = await Promise.all([
      publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "name" }),
      publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "totalSupply" }),
      publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "mintFee" }),
      publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "maxAuctionLength" }),
    ]);
    shareDecimals = Number(decimals);
    totalSupply = supply;

    setText("ssr-name", name);
    setText("ssr-symbol", symbol);
    setText("ssr-supply", `${fmt(supply, shareDecimals, 4)} ${symbol}`);
    $("ssr-link").setAttribute("href", addrLink(ssr));
    $("ssr-link").textContent = ssr;

    // The fee rule, read live rather than asserted. feeNumerator/Denominator
    // is the DAO's share OF the mint fee; feeFloor is a minimum expressed as a
    // fraction of shares minted, which is why a 0% mint fee still charges.
    const [, feeNumerator, feeDenominator, feeFloor] = await publicClient.readContract({
      address: cfg.feeRegistry,
      abi: FEE_REGISTRY_ABI,
      functionName: "getFeeDetails",
      args: [ssr],
    });
    setText("fee-mint", pctFromD18(mintFee));
    setText("fee-dao", `${fmt((feeNumerator * 10000n) / feeDenominator, 2, 2)}%`);
    setText("fee-floor", pctFromD18(feeFloor));
    setText("auction-cap", `${maxAuctionLength}s`);

    const [assets, amounts] = await publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "totalAssets" });
    basket = await Promise.all(
      assets.map(async (a, i) => {
        const [sym, dec] = await Promise.all([
          publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "symbol" }),
          publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "decimals" }),
        ]);
        // ERC-8056 is optional; a plain ERC-20 simply has no multiplier.
        let uiMultiplier: bigint | undefined;
        try {
          uiMultiplier = await publicClient.readContract({ address: a, abi: ERC8056_ABI, functionName: "uiMultiplier" });
        } catch {
          uiMultiplier = undefined;
        }
        return { address: a, symbol: sym, decimals: Number(dec), amount: amounts[i], uiMultiplier };
      }),
    );

    renderBasket();
    show("position-card", !!account);
    show("faucet", cfg.assets.some((a) => a.faucetAmount !== undefined));
    if (account) await refreshBalances();
    status("global-msg", "", "");
  } catch (e) {
    status("global-msg", describeError(e), "err");
  }
}

function renderBasket() {
  const perShare = (b: BasketRow) => (totalSupply === 0n ? 0n : (b.amount * 10n ** BigInt(shareDecimals)) / totalSupply);
  $("basket").innerHTML = basket
    .map((b) => {
      const tag = b.uiMultiplier !== undefined && b.uiMultiplier !== D18 ? `<span class="tag">x${fmt(b.uiMultiplier, 18, 4)}</span>` : "";
      return (
        `<tr><td class="sym">${b.symbol}${tag}</td>` +
        `<td class="r num">${fmt(b.amount, b.decimals, 6)}</td>` +
        `<td class="r num">${fmt(perShare(b), b.decimals, 8)}</td>` +
        `<td class="r"><a class="mono" href="${addrLink(b.address)}" target="_blank" rel="noopener">${short(b.address)}</a></td></tr>`
      );
    })
    .join("");
}

async function refreshBalances() {
  if (!account) return;
  const ssr = cfg.ssr!;
  const [shares, gas] = await Promise.all([
    publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "balanceOf", args: [account] }),
    publicClient.getBalance({ address: account }),
  ]);
  setText("account", account);
  setText("my-shares", fmt(shares, shareDecimals, 6));

  // Gas is the single most common reason a tester's first click fails: the
  // faucet mints basket assets, never the native token.
  const gasText = `${fmt(gas, 18, 6)} ${cfg.chain.nativeCurrency.symbol}`;
  setText("gas-balance", gas === 0n ? `${gasText} -- you need gas before anything will send` : gasText);
  $("gas-balance").className = gas === 0n ? "num down" : "num";

  const rows = await Promise.all(
    basket.map(async (b) => {
      const bal = await publicClient.readContract({ address: b.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account!] });
      return `<tr><td class="sym">${b.symbol}</td><td class="r num">${fmt(bal, b.decimals, 6)}</td></tr>`;
    }),
  );
  $("my-assets").innerHTML = rows.join("");
}

function renderContracts() {
  const rows: [string, string | null][] = [
    ["SSR instance", cfg.ssr],
    ["SSRDeployer (factory)", cfg.deployer],
    ["SSRDAOFeeRegistry", cfg.feeRegistry],
    ["SSRVersionRegistry", cfg.versionRegistry],
    ["RoleRegistry", cfg.roleRegistry],
    ["TrustedFillerRegistry", cfg.fillerRegistry],
  ];
  $("contracts").innerHTML = rows
    .map(
      ([label, a]) =>
        `<tr><td class="sym">${label}</td><td class="r">` +
        (a ? `<a class="mono" href="${addrLink(a)}" target="_blank" rel="noopener">${a}</a>` : `<span style="color:var(--text-3)">not deployed yet</span>`) +
        `</td></tr>`,
    )
    .join("");
}

// ------------------------------------------------------------------ faucet

async function faucet() {
  if (!wallet || !account) return status("faucet-msg", "Connect a wallet first.", "err");
  const mintable = cfg.assets.filter((a) => a.faucetAmount !== undefined);
  if (mintable.length === 0) return status("faucet-msg", "This chain has no mintable test assets.", "err");
  status("faucet-msg", "Minting test assets...", "busy");
  try {
    for (const a of mintable) {
      const hash = await wallet.writeContract({
        address: a.address,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [account, parseUnits(a.faucetAmount!.toString(), a.decimals)],
        chain: cfg.chain,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    await refreshBalances();
    status("faucet-msg", "Test assets minted to your wallet.", "ok");
  } catch (e) {
    status("faucet-msg", describeError(e), "err");
  }
}

// -------------------------------------------------------------------- mint

function sharesInput(id: string): bigint {
  const raw = ($(id) as HTMLInputElement).value.trim();
  if (!raw || !/^\d*\.?\d+$/.test(raw) || Number(raw) <= 0) throw new Error("Enter an amount greater than zero.");
  return parseUnits(raw, shareDecimals);
}

function describeAmounts(assets: readonly Address[], amounts: readonly bigint[]): string {
  return assets
    .map((a, i) => {
      const row = basket.find((b) => b.address.toLowerCase() === a.toLowerCase());
      return `${fmt(amounts[i], row?.decimals ?? 18, 8)} ${row?.symbol ?? short(a)}`;
    })
    .join(" + ");
}

/** Mirrors SSRLib.computeMintFees so the quote matches what will execute. */
async function mintFeeBreakdown(shares: bigint) {
  const ssr = cfg.ssr!;
  const mintFee = await publicClient.readContract({ address: ssr, abi: SSR_ABI, functionName: "mintFee" });
  const [, num, den, floor] = await publicClient.readContract({
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

async function quoteMint() {
  status("mint-msg", "", "");
  try {
    const shares = sharesInput("mint-shares");
    const [assets, amounts] = await publicClient.readContract({
      address: cfg.ssr!,
      abi: SSR_ABI,
      functionName: "toAssets",
      args: [shares, 1], // Ceil -- the minter pays the rounding, as mint() does
    });
    const fee = await mintFeeBreakdown(shares);
    $("mint-quote").innerHTML =
      `<div class="quote-row"><span>You pay</span><b>${describeAmounts(assets, amounts)}</b></div>` +
      `<div class="quote-row"><span>Fee</span><b>${fmt(fee.total, shareDecimals, 6)} shares (DAO ${fmt(fee.dao, shareDecimals, 6)})</b></div>` +
      `<div class="quote-row"><span>You receive</span><b>${fmt(fee.out, shareDecimals, 6)} shares</b></div>`;
    show("mint-quote", true);
    return { shares, assets, amounts };
  } catch (e) {
    status("mint-msg", describeError(e), "err");
    return null;
  }
}

async function doMint() {
  if (!wallet || !account) return status("mint-msg", "Connect a wallet first.", "err");
  const quote = await quoteMint();
  if (!quote) return;
  try {
    // Approve only what this mint needs. Folio uses the allowance as the
    // minter's slippage limit (see SSR.mint), so an unlimited approval would
    // quietly remove that protection.
    for (let i = 0; i < quote.assets.length; i++) {
      const asset = quote.assets[i];
      const needed = quote.amounts[i];
      if (needed === 0n) continue;
      const allowance = await publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "allowance", args: [account, cfg.ssr!] });
      if (allowance < needed) {
        const sym = basket.find((b) => b.address.toLowerCase() === asset.toLowerCase())?.symbol ?? short(asset);
        status("mint-msg", `Approving ${sym}...`, "busy");
        const h = await wallet.writeContract({ address: asset, abi: ERC20_ABI, functionName: "approve", args: [cfg.ssr!, needed], chain: cfg.chain, account });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
    }

    status("mint-msg", "Minting...", "busy");
    const before = await publicClient.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
    const hash = await wallet.writeContract({
      address: cfg.ssr!,
      abi: SSR_ABI,
      functionName: "mint",
      args: [quote.shares, account, 0n],
      chain: cfg.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const after = await publicClient.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "balanceOf", args: [account] });

    await refresh();
    $("mint-msg").className = "msg";
    $("mint-msg").innerHTML = `<span class="ok">Received ${fmt(after - before, shareDecimals, 6)} shares.</span> <a href="${txLink(hash)}" target="_blank" rel="noopener">View transaction</a>`;
  } catch (e) {
    status("mint-msg", describeError(e), "err");
  }
}

// ------------------------------------------------------------------ redeem

async function redeemMax() {
  if (!account) return status("redeem-msg", "Connect a wallet first.", "err");
  const bal = await publicClient.readContract({ address: cfg.ssr!, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
  ($("redeem-shares") as HTMLInputElement).value = formatUnits(bal, shareDecimals);
}

async function doRedeem() {
  if (!wallet || !account) return status("redeem-msg", "Connect a wallet first.", "err");
  try {
    const shares = sharesInput("redeem-shares");

    // redeem() requires the asset array to match the basket EXACTLY, in the
    // contract's own order -- so it is read fresh here rather than assumed.
    const [assets, amounts] = await publicClient.readContract({
      address: cfg.ssr!,
      abi: SSR_ABI,
      functionName: "toAssets",
      args: [shares, 0], // Floor -- redeem() rounds down, in the SSR's favour
    });
    $("redeem-quote").innerHTML = `<div class="quote-row"><span>You receive</span><b>${describeAmounts(assets, amounts)}</b></div>`;
    show("redeem-quote", true);

    status("redeem-msg", "Redeeming...", "busy");
    const hash = await wallet.writeContract({
      address: cfg.ssr!,
      abi: SSR_ABI,
      functionName: "redeem",
      args: [shares, account, [...assets], assets.map(() => 0n)],
      chain: cfg.chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const got = describeAmounts(assets, amounts);
    await refresh();
    $("redeem-msg").className = "msg";
    $("redeem-msg").innerHTML = `<span class="ok">Redeemed for ${got}.</span> <a href="${txLink(hash)}" target="_blank" rel="noopener">View transaction</a>`;
  } catch (e) {
    status("redeem-msg", describeError(e), "err");
  }
}

// ------------------------------------------------------------------ create

function assetRowHtml(i: number): string {
  const opts = cfg.assets
    .map((a) => `<option value="${a.address}">${a.symbol}${a.note ? ` -- ${a.note}` : ""}</option>`)
    .join("");
  return (
    `<div class="assetrow" data-row="${i}">` +
    `<select class="c-asset">${opts}</select>` +
    `<input class="c-amount" type="text" inputmode="decimal" placeholder="Amount">` +
    `<button class="x" type="button" title="Remove">&times;</button>` +
    `</div>`
  );
}

function renderAssetRows(n = 2) {
  $("asset-rows").innerHTML = Array.from({ length: n }, (_, i) => assetRowHtml(i)).join("");
  $("asset-rows")
    .querySelectorAll(".x")
    .forEach((b) =>
      b.addEventListener("click", (e) => {
        const row = (e.currentTarget as HTMLElement).closest(".assetrow");
        if ($("asset-rows").children.length > 1) row?.remove();
      }),
    );
  // Default the selects to distinct assets so the form starts usable.
  const selects = $("asset-rows").querySelectorAll<HTMLSelectElement>(".c-asset");
  selects.forEach((s, i) => {
    if (cfg.assets[i]) s.value = cfg.assets[i].address;
  });
}

function readAssetRows(): { asset: AssetRef; amount: bigint }[] {
  const out: { asset: AssetRef; amount: bigint }[] = [];
  const rows = $("asset-rows").querySelectorAll<HTMLElement>(".assetrow");
  for (const r of rows) {
    const addr = r.querySelector<HTMLSelectElement>(".c-asset")!.value as Address;
    const raw = r.querySelector<HTMLInputElement>(".c-amount")!.value.trim();
    if (!raw) continue;
    if (!/^\d*\.?\d+$/.test(raw) || Number(raw) <= 0) throw new Error("Every basket amount must be a number greater than zero.");
    const asset = cfg.assets.find((a) => a.address.toLowerCase() === addr.toLowerCase());
    if (!asset) throw new Error("Unknown asset selected.");
    if (out.some((o) => o.asset.address.toLowerCase() === addr.toLowerCase())) throw new Error(`${asset.symbol} is listed twice.`);
    out.push({ asset, amount: parseUnits(raw, asset.decimals) });
  }
  if (out.length === 0) throw new Error("Add at least one asset with an amount.");
  return out;
}

async function createReserve() {
  if (!wallet || !account) return status("create-msg", "Connect a wallet first.", "err");
  try {
    const name = ($("c-name") as HTMLInputElement).value.trim();
    const symbol = ($("c-symbol") as HTMLInputElement).value.trim();
    if (!name) throw new Error("Give the reserve a name.");
    if (!symbol) throw new Error("Give the reserve a ticker.");

    const legs = readAssetRows();
    const initialShares = parseUnits(($("c-shares") as HTMLInputElement).value.trim() || "0", 18);
    if (initialShares <= 0n) throw new Error("Initial shares must be greater than zero.");

    const mintFee = parsePercentToD18(($("c-mintfee") as HTMLInputElement).value, "Mint fee");
    const tvlFee = parsePercentToD18(($("c-tvlfee") as HTMLInputElement).value, "TVL fee");
    if (mintFee > LIMITS.MAX_MINT_FEE) throw new Error(`Mint fee cannot exceed ${pctFromD18(LIMITS.MAX_MINT_FEE, 2)}.`);
    if (mintFee !== 0n && mintFee < LIMITS.MIN_MINT_FEE) throw new Error(`A non-zero mint fee must be at least ${pctFromD18(LIMITS.MIN_MINT_FEE, 2)}.`);
    if (tvlFee > LIMITS.MAX_TVL_FEE) throw new Error(`TVL fee cannot exceed ${pctFromD18(LIMITS.MAX_TVL_FEE, 2)} a year.`);

    const ownerRaw = ($("c-owner") as HTMLInputElement).value.trim();
    const owner = (ownerRaw || account) as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("Owner must be a valid address.");

    // Approve each leg to the FACTORY: deploySSR pulls the starting basket
    // from the caller, so the deployer is the spender, not the new reserve.
    for (const leg of legs) {
      const allowance = await publicClient.readContract({ address: leg.asset.address, abi: ERC20_ABI, functionName: "allowance", args: [account, cfg.deployer] });
      if (allowance < leg.amount) {
        status("create-msg", `Approving ${leg.asset.symbol}...`, "busy");
        const h = await wallet.writeContract({
          address: leg.asset.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [cfg.deployer, leg.amount],
          chain: cfg.chain,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
    }

    status("create-msg", "Deploying the reserve...", "busy");
    const hash = await wallet.writeContract({
      address: cfg.deployer,
      abi: DEPLOYER_ABI,
      functionName: "deploySSR",
      args: [
        {
          name,
          symbol,
          assets: legs.map((l) => l.asset.address),
          amounts: legs.map((l) => l.amount),
          initialShares,
        },
        {
          maxAuctionLength: SAFE_REBALANCE_DEFAULTS.maxAuctionLength,
          feeRecipients: [{ recipient: owner, portion: D18 }],
          immutableFeeRecipients: [],
          tvlFee,
          mintFee,
          folioFeeForSelf: 0n,
          mandate: name,
        },
        {
          trustedFillerEnabled: false,
          rebalanceControl: { weightControl: SAFE_REBALANCE_DEFAULTS.weightControl, priceControl: SAFE_REBALANCE_DEFAULTS.priceControl },
          bidsEnabled: true,
        },
        owner,
        [owner],
        [owner],
        [owner],
        `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`,
      ],
      chain: cfg.chain,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    $("create-msg").className = "msg";
    $("create-msg").innerHTML =
      `<span class="ok">Reserve created in block ${receipt.blockNumber}.</span> ` +
      `<a href="${txLink(hash)}" target="_blank" rel="noopener">View transaction</a> &mdash; ` +
      `copy the new reserve's address from the transaction and add it to src/evm/chain.ts to make it the default here.`;
  } catch (e) {
    status("create-msg", describeError(e), "err");
  }
}

// -------------------------------------------------------------------- views

function selectTab(which: "reserve" | "create" | "contracts") {
  for (const t of ["reserve", "create", "contracts"] as const) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === which));
    show(`view-${t}`, t === which);
  }
}

async function selectChain(key: "testnet" | "mainnet") {
  cfg = CHAINS[key];
  publicClient = makeClient(cfg);
  localStorage.setItem(CHAIN_KEY, key);
  $("sel-testnet").setAttribute("aria-pressed", String(key === "testnet"));
  $("sel-mainnet").setAttribute("aria-pressed", String(key === "mainnet"));

  // The connected wallet is on the old chain; make the user reconnect rather
  // than letting a write go to the wrong network.
  wallet = null;
  account = null;
  ($("connect") as HTMLButtonElement).textContent = "Connect wallet";
  show("position-card", false);

  renderAssetRows();
  updateCreateNote();
  await refresh();
}

function updateCreateNote() {
  $("create-config-note").innerHTML =
    `New reserves are created with <b>atomic-swap pricing</b> and a <b>${SAFE_REBALANCE_DEFAULTS.maxAuctionLength}s auction cap</b>. ` +
    `That combination is what keeps a rebalance price from going stale across a corporate action on a stock token &mdash; ` +
    `an auction opens and fills in a single block, and the cap bounds the permissionless path too.`;
}

// --------------------------------------------------------------------- init

$("connect").addEventListener("click", connect);
$("refresh").addEventListener("click", refresh);
$("faucet").addEventListener("click", faucet);
$("mint-quote-btn").addEventListener("click", () => void quoteMint());
$("mint-btn").addEventListener("click", doMint);
$("redeem-btn").addEventListener("click", doRedeem);
$("redeem-max").addEventListener("click", () => void redeemMax());
$("create-btn").addEventListener("click", createReserve);
$("add-asset").addEventListener("click", () => {
  $("asset-rows").insertAdjacentHTML("beforeend", assetRowHtml($("asset-rows").children.length));
  const last = $("asset-rows").lastElementChild!;
  last.querySelector(".x")!.addEventListener("click", () => {
    if ($("asset-rows").children.length > 1) last.remove();
  });
});
$("goto-create").addEventListener("click", () => selectTab("create"));
$("tab-reserve").addEventListener("click", () => selectTab("reserve"));
$("tab-create").addEventListener("click", () => selectTab("create"));
$("tab-contracts").addEventListener("click", () => selectTab("contracts"));
$("sel-testnet").addEventListener("click", () => void selectChain("testnet"));
$("sel-mainnet").addEventListener("click", () => void selectChain("mainnet"));

void selectChain(cfg.key);
