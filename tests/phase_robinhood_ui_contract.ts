// Robinhood must stay FIRST-CLASS in the app, not a section beside it.
// These read the source because that is where the integration lives: a later
// edit that quietly drops Robinhood from a shared surface should fail here.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_robinhood_ui_contract.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("Robinhood is integrated into the shared surfaces", () => {
  it("connects from the header, so an EVM wallet is reachable on every page", () => {
    const shell = read("src/components/Shell.tsx");
    expect(shell).to.include("EvmWalletChip");
    // The Shell is in the main bundle: the chip must not drag viem in with it.
    const chip = read("src/merge/components/robinhood/useEvmWallet.ts");
    expect(chip, "useEvmWallet must stay viem-free at import").to.not.match(/^import\s+\{[^}]*\}\s+from\s+"viem"/m);
    expect(chip, "the EVM stack loads on click").to.include('import("@/lib/evmReserve")');
  });

  it("appears in Discover, Home featured, Portfolio and the shared reserve route", () => {
    expect(read("src/merge/pages/Discover.tsx"), "Discover lists both chains").to.include("robinhoodEntry");
    expect(read("src/pages/Home.tsx"), "Featured spans both chains").to.include("robinhoodEntry");
    expect(read("src/merge/pages/Portfolio.tsx"), "Portfolio shows Robinhood holdings").to.include("RobinhoodHoldings");
    expect(read("src/App.tsx"), "a Robinhood reserve opens on the shared /dtr/:id route").to.include("rhAddressFromId");
  });

  it("offers the chain as an equal choice when launching", () => {
    const create = read("src/merge/pages/CreateReserve.tsx");
    expect(create).to.include("Robinhood Chain");
    expect(create).to.include("RobinhoodCreateForm");
  });
});

describe("merge.css's action-button treatment cannot capture non-CTA controls", () => {
  // Live 2026-09-23: the chain picker's SELECTED card was a <button> carrying
  // `bg-primary/10`, so this rule restyled it as an uppercase Lexend Giga CTA
  // while the unselected one stayed in body type. Any control that is not a
  // call to action must avoid <button> + a bg-primary/bg-action class.
  it("still matches only filled action buttons (the rule this guards)", () => {
    const css = read("src/merge/merge.css");
    expect(css).to.include(".merge-scope button:is([class*='bg-action'], [class*='bg-primary'], [class*='bg-destructive'])");
    expect(css).to.include("text-transform: uppercase");
  });

  it("the chain picker is labels + radios, never a bg-primary button", () => {
    const create = read("src/merge/pages/CreateReserve.tsx");
    const picker = create.slice(create.indexOf("export function ChainPicker"), create.indexOf("export function CreateReserve"));
    expect(picker, "picker must not use <button>").to.not.include("<button");
    expect(picker, "picker uses radio inputs for semantics").to.include('type="radio"');
    expect(/<button[^>]*bg-(primary|action|destructive)/.test(create), "no bg-primary button on the Create page").to.equal(false);
  });

  it("a wallet chip never wraps: a truncated address is one line", () => {
    // Live 2026-09-23: with two chips in the nav (Solana + Robinhood) the pill
    // shrank and broke "52b7...7ERa" across two lines.
    const css = read("src/index.css");
    const rule = css.slice(css.indexOf(".wallet-chip {"), css.indexOf(".wallet-chip:hover"));
    expect(rule).to.include("white-space: nowrap");
    expect(rule).to.include("flex-shrink: 0");
  });

  it("asks the wallet for accounts BEFORE switching chains", () => {
    // Live 2026-09-23 (Phantom): wallets differ on whether an unauthorized
    // site may switch/add a chain, and several no-op until connected -- doing
    // it first made connecting take several attempts.
    const src = read("src/merge/lib/evmReserve.ts");
    const fn = src.slice(src.indexOf("export async function connectWallet"), src.indexOf("export function describeEvmError"));
    expect(fn.indexOf("eth_requestAccounts"), "requestAccounts must come first").to.be.lessThan(fn.indexOf("ensureChain"));
  });

  it("discovers wallets via EIP-6963 rather than trusting window.ethereum", () => {
    // window.ethereum is one slot several extensions race for; with Phantom and
    // MetaMask both installed, connect hit whichever won.
    const src = read("src/merge/components/robinhood/useEvmWallet.ts");
    expect(src).to.include("eip6963:requestProvider");
    expect(src).to.include("eip6963:announceProvider");
    expect(read("src/components/EvmWalletChip.tsx"), "offers a choice when several are installed").to.include("discoverEvmProviders");
  });

  it("treats every flavour of \"unrecognised chain\" as needing the chain added", () => {
    const src = read("src/merge/lib/evmReserve.ts");
    const fn = src.slice(src.indexOf("function needsChainAdded"), src.indexOf("export async function ensureChain"));
    expect(fn).to.include("4902");
    expect(fn).to.include("-32603");
  });
});
