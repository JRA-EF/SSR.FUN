// The EVM test page (evm.html -> /evm). Built by Vite as its own entry: it
// shares nothing with the Solana app -- no wallet adapter, no web3.js, no
// store -- because the two chains are genuinely separate deployments and
// entangling them would make a bug on one look like a bug on the other.
//
// What it is FOR: exercising the ported contracts end to end on a real chain
// (Robinhood testnet 46630) -- read the basket, fund yourself, mint shares,
// redeem them -- and showing the mint-fee split live, since the fee rule is
// the only thing SSR changed from upstream Folio.
//
// Everything here is testnet. The basket assets are MockERC20s whose mint()
// is unguarded, which is what makes self-service funding possible; see
// chain.ts. Nothing on this page can touch mainnet or real funds.
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from "viem";
import { ADDRESSES, ERC20_ABI, EXPLORER, FAUCET_ASSETS, FEE_REGISTRY_ABI, ROBINHOOD_TESTNET, SSR_ABI } from "./chain";

const SSR = ADDRESSES.ssr as Address;
const D18 = 10n ** 18n;

const publicClient = createPublicClient({ chain: ROBINHOOD_TESTNET, transport: http() });

let wallet: WalletClient | null = null;
let account: Address | null = null;

// ---------------------------------------------------------------- DOM helpers

const $ = (id: string) => document.getElementById(id)!;
const setText = (id: string, v: string) => {
  $(id).textContent = v;
};

/** Every status line goes through here so a failure is never silent. */
function status(id: string, message: string, kind: "ok" | "err" | "busy" | "" = "") {
  const el = $(id);
  el.textContent = message;
  el.className = `msg ${kind}`;
}

function txLink(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
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

// ------------------------------------------------------------------ wallet

function injectedProvider(): EIP1193Provider {
  const p = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!p) throw new Error("No EVM wallet found. Install MetaMask (or any injected wallet) and reload.");
  return p;
}

/**
 * Asks the wallet for Robinhood testnet, adding it if the wallet has never
 * seen it. 4902 is the EIP-1193 "unrecognised chain" code; anything else is a
 * real failure and is re-thrown rather than swallowed.
 */
async function ensureChain(provider: EIP1193Provider) {
  const hexId = `0x${ROBINHOOD_TESTNET.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: ROBINHOOD_TESTNET.name,
          nativeCurrency: ROBINHOOD_TESTNET.nativeCurrency,
          rpcUrls: [...ROBINHOOD_TESTNET.rpcUrls.default.http],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    } as never);
  }
}

async function connect() {
  status("connect-msg", "Connecting...", "busy");
  try {
    const provider = injectedProvider();
    await ensureChain(provider);
    const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
    if (!addr) throw new Error("The wallet returned no account.");
    account = addr;
    wallet = createWalletClient({ account: addr, chain: ROBINHOOD_TESTNET, transport: custom(provider) });
    setText("account", addr);
    $("connected").removeAttribute("hidden");
    ($("connect") as HTMLButtonElement).textContent = "Reconnect";
    status("connect-msg", "", "");

    // A wallet can switch account or network under us; re-read rather than
    // keep acting on a stale address.
    provider.on?.("accountsChanged", () => window.location.reload());
    provider.on?.("chainChanged", () => window.location.reload());

    await refresh();
  } catch (e) {
    status("connect-msg", describeError(e), "err");
  }
}

// ------------------------------------------------------------------- reads

interface BasketRow {
  address: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
}

let basket: BasketRow[] = [];
let shareDecimals = 18;

/** Reads the instance, its basket, the fee split, and (if connected) balances. */
async function refresh() {
  status("refresh-msg", "Loading...", "busy");
  try {
    const [name, symbol, decimals, totalSupply, mintFee] = await Promise.all([
      publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "name" }),
      publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "totalSupply" }),
      publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "mintFee" }),
    ]);
    shareDecimals = Number(decimals);

    setText("ssr-name", name);
    setText("ssr-symbol", symbol);
    setText("ssr-supply", `${fmt(totalSupply, shareDecimals, 4)} ${symbol}`);

    // The fee rule, read live rather than asserted. feeNumerator/Denominator
    // is the DAO's share OF the mint fee; feeFloor is a minimum expressed as a
    // fraction of the shares minted, which is why a 0% mint fee still charges.
    const [, feeNumerator, feeDenominator, feeFloor] = await publicClient.readContract({
      address: ADDRESSES.feeRegistry as Address,
      abi: FEE_REGISTRY_ABI,
      functionName: "getFeeDetails",
      args: [SSR],
    });
    const daoPct = (feeNumerator * 10000n) / feeDenominator;
    setText("fee-mint", `${fmt(mintFee * 100n, 18, 4)}%`);
    setText("fee-dao", `${fmt(daoPct, 2, 2)}% of the mint fee`);
    setText("fee-floor", `${fmt(feeFloor * 100n, 18, 4)}% of shares minted`);

    const [assets, amounts] = await publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "totalAssets" });
    basket = await Promise.all(
      assets.map(async (a, i) => {
        const [sym, dec] = await Promise.all([
          publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "symbol" }),
          publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "decimals" }),
        ]);
        return { address: a, symbol: sym, decimals: Number(dec), amount: amounts[i] };
      }),
    );

    renderBasket();
    if (account) await refreshBalances();
    status("refresh-msg", "", "");
  } catch (e) {
    status("refresh-msg", describeError(e), "err");
  }
}

function renderBasket() {
  $("basket").innerHTML = basket
    .map(
      (b) =>
        `<tr><td>${b.symbol}</td><td class="num">${fmt(b.amount, b.decimals, 6)}</td>` +
        `<td class="addr"><a href="${EXPLORER}/address/${b.address}" target="_blank" rel="noopener">${b.address.slice(0, 10)}...</a></td></tr>`,
    )
    .join("");
}

async function refreshBalances() {
  if (!account) return;
  const shares = await publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
  setText("my-shares", fmt(shares, shareDecimals, 6));

  const rows = await Promise.all(
    basket.map(async (b) => {
      const bal = await publicClient.readContract({ address: b.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account!] });
      return `<tr><td>${b.symbol}</td><td class="num">${fmt(bal, b.decimals, 6)}</td></tr>`;
    }),
  );
  $("my-assets").innerHTML = rows.join("");
}

// ------------------------------------------------------------------ faucet

async function faucet() {
  if (!wallet || !account) return status("faucet-msg", "Connect a wallet first.", "err");
  status("faucet-msg", "Minting test assets...", "busy");
  try {
    for (const a of FAUCET_ASSETS) {
      const amount = parseUnits(a.faucetAmount.toString(), a.decimals);
      const hash = await wallet.writeContract({
        address: a.address as Address,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [account, amount],
        chain: ROBINHOOD_TESTNET,
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
  if (!raw || Number(raw) <= 0) throw new Error("Enter an amount greater than zero.");
  return parseUnits(raw, shareDecimals);
}

/** Quotes what minting `shares` costs, and what the fee leaves you with. */
async function quoteMint() {
  status("mint-msg", "", "");
  try {
    const shares = sharesInput("mint-shares");
    const [assets, amounts] = await publicClient.readContract({
      address: SSR,
      abi: SSR_ABI,
      functionName: "toAssets",
      args: [shares, 1], // Ceil -- the minter pays the rounding, as mint() does
    });
    const mintFee = await publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "mintFee" });
    const [, feeNumerator, feeDenominator, feeFloor] = await publicClient.readContract({
      address: ADDRESSES.feeRegistry as Address,
      abi: FEE_REGISTRY_ABI,
      functionName: "getFeeDetails",
      args: [SSR],
    });

    // Mirrors SSRLib.computeMintFees: the DAO floor can raise the total fee
    // above the SSR's own mintFee, so the floor is what actually binds here.
    let totalFeeShares = (shares * mintFee + D18 - 1n) / D18;
    let daoFeeShares = (totalFeeShares * feeNumerator + feeDenominator - 1n) / feeDenominator;
    const minDaoShares = (shares * feeFloor + D18 - 1n) / D18;
    if (daoFeeShares < minDaoShares) daoFeeShares = minDaoShares;
    if (totalFeeShares < daoFeeShares) totalFeeShares = daoFeeShares;
    const sharesOut = shares - totalFeeShares;

    const cost = assets
      .map((a, i) => {
        const row = basket.find((b) => b.address.toLowerCase() === a.toLowerCase());
        return `${fmt(amounts[i], row?.decimals ?? 18, 8)} ${row?.symbol ?? a.slice(0, 8)}`;
      })
      .join(" + ");

    $("mint-quote").innerHTML =
      `<div class="quote-row"><span>You pay</span><b>${cost}</b></div>` +
      `<div class="quote-row"><span>Fee</span><b>${fmt(totalFeeShares, shareDecimals, 6)} shares` +
      ` (DAO ${fmt(daoFeeShares, shareDecimals, 6)})</b></div>` +
      `<div class="quote-row"><span>You receive</span><b>${fmt(sharesOut, shareDecimals, 6)} shares</b></div>`;
    $("mint-quote").removeAttribute("hidden");
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
    // Approve only what this mint needs. Folio uses allowances as the minter's
    // slippage limit (see SSR.mint's comment), so an unlimited approval would
    // quietly remove that protection.
    for (let i = 0; i < quote.assets.length; i++) {
      const asset = quote.assets[i];
      const needed = quote.amounts[i];
      if (needed === 0n) continue;
      const allowance = await publicClient.readContract({
        address: asset,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, SSR],
      });
      if (allowance < needed) {
        status("mint-msg", `Approving ${basket.find((b) => b.address === asset)?.symbol ?? "asset"}...`, "busy");
        const hash = await wallet.writeContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [SSR, needed],
          chain: ROBINHOOD_TESTNET,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
    }

    status("mint-msg", "Minting...", "busy");
    const before = await publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "balanceOf", args: [account] });
    const hash = await wallet.writeContract({
      address: SSR,
      abi: SSR_ABI,
      functionName: "mint",
      args: [quote.shares, account, 0n],
      chain: ROBINHOOD_TESTNET,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const after = await publicClient.readContract({ address: SSR, abi: SSR_ABI, functionName: "balanceOf", args: [account] });

    await refresh();
    status("mint-msg", "", "");
    $("mint-msg").innerHTML =
      `<span class="ok">Received ${fmt(after - before, shareDecimals, 6)} shares.</span> ` +
      `<a href="${txLink(hash)}" target="_blank" rel="noopener">View transaction</a>`;
  } catch (e) {
    status("mint-msg", describeError(e), "err");
  }
}

// ------------------------------------------------------------------ redeem

async function doRedeem() {
  if (!wallet || !account) return status("redeem-msg", "Connect a wallet first.", "err");
  try {
    const shares = sharesInput("redeem-shares");

    // redeem() requires the asset array to match the basket EXACTLY, in the
    // contract's own order -- so it is read fresh here rather than assumed.
    const [assets, amounts] = await publicClient.readContract({
      address: SSR,
      abi: SSR_ABI,
      functionName: "toAssets",
      args: [shares, 0], // Floor -- redeem() rounds down, in the SSR's favour
    });

    status("redeem-msg", "Redeeming...", "busy");
    const hash = await wallet.writeContract({
      address: SSR,
      abi: SSR_ABI,
      functionName: "redeem",
      args: [shares, account, [...assets], assets.map(() => 0n)],
      chain: ROBINHOOD_TESTNET,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const got = assets
      .map((a, i) => {
        const row = basket.find((b) => b.address.toLowerCase() === a.toLowerCase());
        return `${fmt(amounts[i], row?.decimals ?? 18, 8)} ${row?.symbol ?? a.slice(0, 8)}`;
      })
      .join(" + ");

    await refresh();
    $("redeem-msg").innerHTML = `<span class="ok">Redeemed for ${got}.</span> <a href="${txLink(hash)}" target="_blank" rel="noopener">View transaction</a>`;
  } catch (e) {
    status("redeem-msg", describeError(e), "err");
  }
}

// -------------------------------------------------------------------- init

setText("chain-name", `${ROBINHOOD_TESTNET.name} (${ROBINHOOD_TESTNET.id})`);
$("ssr-link").setAttribute("href", `${EXPLORER}/address/${SSR}`);
setText("ssr-address", SSR);

$("connect").addEventListener("click", connect);
$("refresh").addEventListener("click", refresh);
$("faucet").addEventListener("click", faucet);
$("mint-quote-btn").addEventListener("click", () => void quoteMint());
$("mint-btn").addEventListener("click", doMint);
$("redeem-btn").addEventListener("click", doRedeem);

void refresh();
