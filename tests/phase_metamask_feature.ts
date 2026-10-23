// MetaMask is held back from production behind VITE_ENABLE_METAMASK
// (src/merge/lib/metamaskFeature.ts). These read the source so a later edit
// that drops the gate, or lets autoConnect bring a saved MetaMask back, fails.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_metamask_feature.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("MetaMask stays off unless VITE_ENABLE_METAMASK=true", () => {
  it("is off by default: only the literal string 'true' turns it on", () => {
    const feature = read("src/merge/lib/metamaskFeature.ts");
    expect(feature).to.include('(import.meta.env.VITE_ENABLE_METAMASK as string | undefined) === "true"');
  });

  it("filters the MetaMask tile out of the Solana wallet picker", () => {
    const modal = read("src/components/WalletModal.tsx");
    expect(modal).to.include("import { METAMASK_ENABLED } from '@/lib/metamaskFeature'");
    expect(modal).to.include("ALL_WALLET_OPTIONS.filter(opt => METAMASK_ENABLED || opt.id !== 'metamask')");
    expect(modal, "the picker renders the filtered list").to.include("{WALLET_OPTIONS.map(opt =>");
  });

  it("forgets a saved MetaMask choice before autoConnect runs, under the same storage key", () => {
    const providers = read("src/merge/lib/SolanaProviders.tsx");
    expect(providers.indexOf("forgetDisabledWalletChoice();"), "called at module load").to.be.greaterThan(-1);
    expect(providers.indexOf("forgetDisabledWalletChoice();")).to.be.lessThan(providers.indexOf("export function SolanaProviders"));
    expect(providers).to.include("localStorageKey={WALLET_NAME_STORAGE_KEY}");
    expect(read("src/merge/lib/metamaskFeature.ts")).to.include('WALLET_NAME_STORAGE_KEY = "ssr.fun:walletName"');
  });
});
