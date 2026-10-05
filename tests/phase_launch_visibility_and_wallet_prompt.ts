// Offline coverage for DEC-0217: (1) the post-launch token-metadata safety
// net's decision logic, (2) the wallet-prompt explanation shown when a Buy or
// Sell cannot fit one transaction, (3) the launch success message's
// visibility note, and (4) which warm-cache request URLs may trigger a
// snapshot refresh without the scheduler secret.
import { expect } from "chai";
import { describeAfterLaunchMetadataOutcome, ensureReserveTokenMetadataPublished } from "../src/merge/lib/tokenMetadataAfterLaunch";
import { describeBatchBuyWalletPrompt, describeBatchSellWalletPrompt, RESERVE_VISIBILITY_NOTE } from "../src/merge/lib/walletPromptCopy";
import { manualRefreshTrigger } from "../lib/reserve-warm-cache/manualRefresh";

const someMetadata = { address: "a", mint: "m", updateAuthority: "u", name: "ALPHA", symbol: "ALPHA", uri: "https://ssr.fun/x", isMutable: true };

describe("DEC-0217 post-launch token metadata safety net", () => {
  it("does nothing when the metadata account already exists", async () => {
    let published = 0;
    const r = await ensureReserveTokenMetadataPublished({ read: async () => someMetadata, publish: async () => void published++ });
    expect(r).to.deep.equal({ outcome: "already-published" });
    expect(published).to.equal(0);
    expect(describeAfterLaunchMetadataOutcome(r, "ALPHA")).to.equal(null);
  });

  it("publishes exactly once when the account is missing", async () => {
    let published = 0;
    const r = await ensureReserveTokenMetadataPublished({ read: async () => null, publish: async () => void published++ });
    expect(r.outcome).to.equal("published");
    expect(published).to.equal(1);
    expect(describeAfterLaunchMetadataOutcome(r, "SOLTEN")).to.contain("SOLTEN is now named in wallets");
  });

  it("reports a declined/failed publish with the Manage page as the way out", async () => {
    const r = await ensureReserveTokenMetadataPublished({
      read: async () => null,
      publish: async () => {
        throw new Error("User rejected the request.");
      },
    });
    expect(r.outcome).to.equal("failed");
    expect(r.error).to.equal("User rejected the request.");
    const note = describeAfterLaunchMetadataOutcome(r, "TEST");
    expect(note).to.contain("TEST without its name");
    expect(note).to.contain("Publish to wallets and exchanges");
  });

  it("never publishes when the read itself failed", async () => {
    let published = 0;
    const r = await ensureReserveTokenMetadataPublished({
      read: async () => {
        throw new Error("429 Too Many Requests");
      },
      publish: async () => void published++,
    });
    expect(r.outcome).to.equal("failed");
    expect(published).to.equal(0);
  });

  it("falls back to a generic noun for an empty ticker", () => {
    expect(describeAfterLaunchMetadataOutcome({ outcome: "failed" }, "  ")).to.contain("your Reserve Token without its name");
  });
});

describe("DEC-0217 wallet-prompt copy for multi-transaction Buy/Sell", () => {
  it("names every transaction the wallet will show for a Buy and what the buyer ends up holding", () => {
    const s = describeBatchBuyWalletPrompt({ swaps: 3, total: 4, ticker: "STOCK" });
    expect(s).to.contain("approve 4 transactions at once");
    expect(s).to.contain("3 swaps of your USDC into the Reserve's assets");
    expect(s).to.contain("the deposit that mints your STOCK");
    expect(s).to.contain("pass through your wallet");
    expect(s).to.contain("you hold STOCK, not the assets");
  });

  it("uses singular forms and tolerates a mint-only batch", () => {
    expect(describeBatchBuyWalletPrompt({ swaps: 1, total: 2, ticker: "X" })).to.contain("1 swap of your USDC");
    const mintOnly = describeBatchBuyWalletPrompt({ swaps: 0, total: 1, ticker: "X" });
    expect(mintOnly).to.contain("approve 1 transaction at once: the deposit that mints your X");
    expect(mintOnly).to.not.contain("0 swaps");
  });

  it("never reports fewer transactions than swaps + the mint", () => {
    expect(describeBatchBuyWalletPrompt({ swaps: 3, total: 1, ticker: "X" })).to.contain("approve 4 transactions");
  });

  it("describes a Sell as redemption first, then sales into USDC", () => {
    const s = describeBatchSellWalletPrompt({ swaps: 2, total: 3, ticker: "DELTA" });
    expect(s).to.contain("approve 3 transactions at once");
    expect(s).to.contain("redemption of your DELTA into the Reserve's assets, then 2 sales of those assets into USDC");
    expect(s).to.contain("you hold USDC");
  });

  it("falls back to 'Reserve Token' for a blank ticker", () => {
    expect(describeBatchBuyWalletPrompt({ swaps: 1, total: 2, ticker: "" })).to.contain("mints your Reserve Token");
  });

  it("the launch success note says the Reserve may take a few minutes to appear and that funds are safe", () => {
    expect(RESERVE_VISIBILITY_NOTE).to.match(/few minutes/);
    expect(RESERVE_VISIBILITY_NOTE).to.contain("Discover");
    expect(RESERVE_VISIBILITY_NOTE).to.contain("Portfolio");
    expect(RESERVE_VISIBILITY_NOTE).to.match(/funds are already safe on-chain/);
  });
});

describe("DEC-0217 warm-cache manual refresh triggers", () => {
  it("recognises the dry-run and the launch trigger, and nothing else", () => {
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron?dryRun=true")).to.equal("dry-run");
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron?dryRun=1&x=y")).to.equal("dry-run");
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron?trigger=reserve-created")).to.equal("reserve-created");
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron?a=b&trigger=reserve-created")).to.equal("reserve-created");
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron")).to.equal(null);
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron?trigger=reserve-createdX")).to.equal(null);
    expect(manualRefreshTrigger("/api/mainnet/warm-cache-cron?dryRun=false")).to.equal(null);
    expect(manualRefreshTrigger(undefined)).to.equal(null);
  });
});
