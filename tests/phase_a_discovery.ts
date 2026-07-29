// Pure-logic regression coverage for the Phase A canonical-discovery /
// mock-purge work (see docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md
// "Phase A"). Deliberately network-free -- discovery.ts's live on-chain
// enumeration itself is exercised against real DevNet by
// scripts/verify_*.ts-style scripts, not here; this file covers the pure
// helpers (metadata parsing, local delegate labels, coverage honesty) that
// can and should run offline in CI.
//
// Run in isolation (does not touch the network or an Anchor toolchain):
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_a_discovery.ts
import { expect } from "chai";
import { parseReserveMetadataUri } from "../packages/sdk/src/discovery";
import { decodeOnChainPermissions } from "../src/merge/lib/onChainPermissions";

// Node (this repo targets Node 24) has no global `localStorage` by default --
// delegateLabels.ts assumes a browser-like environment. Polyfill minimally,
// in-memory, for this test file only; production code is untouched.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => {
      backing.set(k, v);
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

// Imported after the polyfill above is installed, since the module reads
// `localStorage` lazily inside its functions (not at import time) -- but
// importing after the polyfill is set up is the safer, more obviously
// correct ordering regardless.
import { displayDelegateName, getDelegateLabel, setDelegateLabel, shortenAddress } from "../src/merge/lib/delegateLabels";

describe("Phase A -- parseReserveMetadataUri (recovers on-chain Reserve name/ticker without fabrication)", () => {
  it("parses a real data:application/json metadataUri, matching CreateDTR.tsx's real-deployment format", () => {
    const uri = `data:application/json,${encodeURIComponent(
      JSON.stringify({ name: "Strategic Sol Reserve", ticker: "TestLo", description: "A test reserve.", category: "DevNet" }),
    )}`;
    const parsed = parseReserveMetadataUri(uri);
    expect(parsed).to.not.equal(null);
    expect(parsed!.name).to.equal("Strategic Sol Reserve");
    expect(parsed!.ticker).to.equal("TestLo");
    expect(parsed!.category).to.equal("DevNet");
  });

  it("returns null (never a fabricated guess) for a non-data-URI metadataUri, e.g. the committed fixtures' empty/placeholder value", () => {
    expect(parseReserveMetadataUri("")).to.equal(null);
    expect(parseReserveMetadataUri("https://example.com/metadata.json")).to.equal(null);
  });

  it("returns null for a malformed data URI instead of throwing", () => {
    expect(parseReserveMetadataUri("data:application/json,not-json-at-all-%")).to.equal(null);
  });

  it("returns null when the JSON parses but has neither name nor ticker", () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ description: "no name or ticker here" }))}`;
    expect(parseReserveMetadataUri(uri)).to.equal(null);
  });
});

describe("Phase A -- decodeOnChainPermissions (mirrors programs/ssr_protocol's permission_flags)", () => {
  it("decodes a single bit correctly", () => {
    expect(decodeOnChainPermissions(1 << 1)).to.deep.equal(["Update Targets"]);
  });

  it("decodes multiple bits correctly, in flag-table order", () => {
    const bitmask = (1 << 6) | (1 << 7) | (1 << 1); // pause + unpause + update targets
    expect(decodeOnChainPermissions(bitmask)).to.deep.equal(["Update Targets", "Pause Reserve", "Unpause Reserve"]);
  });

  it("decodes zero as no capabilities", () => {
    expect(decodeOnChainPermissions(0)).to.deep.equal([]);
  });
});

describe("Phase A -- delegate local labels (off-chain only, honest fallback, per item 6/11)", () => {
  const reserve = "ReserveAddress111111111111111111111111111";
  const wallet = "WalletAddress2222222222222222222222222222";

  it("falls back to a shortened address when no local label is set", () => {
    expect(getDelegateLabel(reserve, wallet)).to.equal(null);
    expect(displayDelegateName(reserve, wallet)).to.equal(shortenAddress(wallet));
  });

  it("returns the local label once set, and displayDelegateName prefers it over the address", () => {
    setDelegateLabel(reserve, wallet, "Ops wallet");
    expect(getDelegateLabel(reserve, wallet)).to.equal("Ops wallet");
    expect(displayDelegateName(reserve, wallet)).to.equal("Ops wallet");
  });

  it("clearing a label (empty string) falls back to the shortened address again -- never a blank name", () => {
    setDelegateLabel(reserve, wallet, "Temp");
    setDelegateLabel(reserve, wallet, "   ");
    expect(getDelegateLabel(reserve, wallet)).to.equal(null);
    expect(displayDelegateName(reserve, wallet)).to.equal(shortenAddress(wallet));
  });

  it("labels are keyed by (reserve, wallet) -- the same wallet under a different Reserve has no label", () => {
    setDelegateLabel(reserve, wallet, "Reserve-A label");
    expect(getDelegateLabel("SomeOtherReserve111111111111111111111111", wallet)).to.equal(null);
  });

  it("shortenAddress never truncates an address short enough to show in full", () => {
    expect(shortenAddress("short")).to.equal("short");
  });
});
