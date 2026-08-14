// Regression coverage for the "Manager Dashboard still shows 'N delegate(s)
// reported on-chain, but none matched this discovery pass's candidate
// wallets'" bug (see docs/project/DECISION_LOG.md for the corrective entry
// this test file backs). Root cause: packages/sdk/src/discovery.ts's
// discoverDelegatesForReserve can only ever resolve a delegate wallet it's
// explicitly told to check (a Delegate account is a PDA seeded by
// (reserve, wallet), with no on-chain reverse index, and the public DevNet
// RPC blocks the getProgramAccounts scan that would otherwise enumerate
// them) -- but the candidate list callers built used to be a small,
// hardcoded set (the Reserve's manager, 2 DevNet fixture demo wallets, and
// whichever wallet happened to be currently connected). A delegate granted
// to any OTHER wallet -- the overwhelmingly common real case -- was
// therefore invisible forever, even immediately after granting it and even
// after refreshing indefinitely.
//
// src/merge/lib/delegateDiscoveryCandidates.ts fixes this by (1) recording
// every wallet this browser has ever granted delegate status to, per
// Reserve, in a small local registry (rememberDelegateWallet), purely as a
// discovery HINT -- never trusted without a fresh, genuine on-chain
// Delegate-account fetch/decode -- and (2) always including the connected
// wallet directly, which is what makes a delegate's OWN connected wallet
// correctly self-discover every Reserve it has an active delegation on,
// regardless of this registry.
//
// Deliberately network- and Anchor-toolchain-free: these tests cover only
// the pure candidate-list-building and local-registry logic. The actual
// on-chain verification step (discoverDelegatesForReserve fetching and
// decoding the real Delegate account for each candidate) is exercised live
// against DevNet elsewhere (see scripts/verify_delegate_wiring.ts) -- by
// design, a candidate that never resolves on-chain grants nothing here.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_delegate_discovery_candidates.ts
import { expect } from "chai";

// Node (this repo targets Node 24) has no global `localStorage` by default;
// delegateDiscoveryCandidates.ts assumes a browser-like environment, same
// as delegateLabels.ts (see tests/phase_a_discovery.ts's identical
// polyfill). In-memory, this test file only -- production code untouched.
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

// Imported after the polyfill above is installed -- the module reads
// `localStorage` lazily inside its functions, but importing after setup is
// the safer, more obviously correct ordering regardless.
import { DEVNET_FIXTURES } from "../packages/sdk/src/fixtures";
import { buildDelegateCandidateWallets, forgetDelegateWallet, getKnownDelegateWallets, rememberDelegateWallet } from "../src/merge/lib/delegateDiscoveryCandidates";

// Real, on-curve, valid-base58 wallet addresses (same fixtures used by
// tests/phase_delegate_wiring.ts) -- buildDelegateCandidateWallets
// constructs a real `PublicKey` per candidate, so these must actually parse.
const MANAGER = "Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj";
const GRANTED_DELEGATE = "Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k";
const CONNECTED_WALLET = "9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv";
const RESERVE_A = "GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C";
const RESERVE_B = "8pMzAdrjkeqRq6ZTFcGSFAdNL5X6ZC5cLAFo1PoxAxE7";

describe("delegateDiscoveryCandidates -- local known-wallet registry", () => {
  it("starts empty for a Reserve nothing has been remembered for", () => {
    expect(getKnownDelegateWallets(RESERVE_A)).to.deep.equal([]);
  });

  it("remembers a granted wallet and returns it going forward", () => {
    rememberDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    expect(getKnownDelegateWallets(RESERVE_A)).to.include(GRANTED_DELEGATE);
  });

  it("is idempotent -- remembering the same wallet twice doesn't duplicate it", () => {
    rememberDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    rememberDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    expect(getKnownDelegateWallets(RESERVE_A).filter((w) => w === GRANTED_DELEGATE)).to.have.lengthOf(1);
  });

  it("is keyed per Reserve -- a wallet remembered for one Reserve is not a candidate for another", () => {
    rememberDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    expect(getKnownDelegateWallets(RESERVE_B)).to.not.include(GRANTED_DELEGATE);
  });

  it("forgetDelegateWallet removes a wallet from the registry (hygiene after a confirmed Remove Delegate)", () => {
    rememberDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    forgetDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    expect(getKnownDelegateWallets(RESERVE_A)).to.not.include(GRANTED_DELEGATE);
  });

  it("forgetting a wallet never remembered, or from a Reserve never touched, is a safe no-op", () => {
    expect(() => forgetDelegateWallet(RESERVE_B, GRANTED_DELEGATE)).to.not.throw();
    expect(getKnownDelegateWallets(RESERVE_B)).to.deep.equal([]);
  });
});

describe("delegateDiscoveryCandidates -- buildDelegateCandidateWallets (regression: the exact reported bug)", () => {
  it("ROOT-CAUSE REGRESSION: a delegate wallet granted through the Grant Delegate UI (not the manager, not a fixture, not currently connected) IS a discovery candidate once remembered -- this is what used to be silently invisible forever", () => {
    rememberDelegateWallet(RESERVE_A, GRANTED_DELEGATE);
    const candidates = buildDelegateCandidateWallets(RESERVE_A, MANAGER, null).map((k) => k.toBase58());
    expect(candidates).to.include(GRANTED_DELEGATE);
  });

  it("without ever having been remembered, an arbitrary granted-elsewhere wallet is honestly NOT a candidate -- the documented, unavoidable limitation this fix narrows but cannot fully close (no getProgramAccounts scan on the public DevNet RPC)", () => {
    const candidates = buildDelegateCandidateWallets(RESERVE_B, MANAGER, null).map((k) => k.toBase58());
    expect(candidates).to.not.include(GRANTED_DELEGATE);
  });

  it("always includes the Reserve's manager", () => {
    const candidates = buildDelegateCandidateWallets(RESERVE_A, MANAGER, null).map((k) => k.toBase58());
    expect(candidates).to.include(MANAGER);
  });

  it("always includes the connected wallet when one is connected -- the connected delegate wallet's own delegations are always directly, authoritatively discoverable, independent of the local registry", () => {
    const candidates = buildDelegateCandidateWallets(RESERVE_B, MANAGER, CONNECTED_WALLET).map((k) => k.toBase58());
    expect(candidates).to.include(CONNECTED_WALLET);
  });

  it("never includes a connected-wallet candidate when no wallet is connected", () => {
    const candidates = buildDelegateCandidateWallets(RESERVE_B, MANAGER, null).map((k) => k.toBase58());
    expect(candidates).to.have.lengthOf(new Set(candidates).size); // no accidental dupes/nulls either
    expect(candidates.some((c) => c === "null")).to.equal(false);
  });

  it("always includes both documented DevNet fixture delegate wallets, for continuity with the seeded Gate-9 fixtures", () => {
    const candidates = buildDelegateCandidateWallets(RESERVE_A, MANAGER, null).map((k) => k.toBase58());
    expect(candidates).to.include(DEVNET_FIXTURES.delegates.updateTargets.wallet);
    expect(candidates).to.include(DEVNET_FIXTURES.delegates.pauseUnpause.wallet);
  });

  it("de-duplicates when the same wallet appears in multiple roles (e.g. the connected wallet is also the manager)", () => {
    const candidates = buildDelegateCandidateWallets(RESERVE_A, MANAGER, MANAGER).map((k) => k.toBase58());
    expect(candidates.filter((c) => c === MANAGER)).to.have.lengthOf(1);
  });

  it("skips a malformed locally-stored address instead of throwing -- a corrupted registry entry must never crash discovery", () => {
    rememberDelegateWallet(RESERVE_A, "not-a-real-base58-pubkey");
    expect(() => buildDelegateCandidateWallets(RESERVE_A, MANAGER, null)).to.not.throw();
    const candidates = buildDelegateCandidateWallets(RESERVE_A, MANAGER, null).map((k) => k.toBase58());
    expect(candidates).to.not.include("not-a-real-base58-pubkey");
  });
});
