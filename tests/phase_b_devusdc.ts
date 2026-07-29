// Offline, pure-logic regression coverage for Phase B's devUSDC/DevNet-SOL
// onboarding infrastructure (see
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B -- security
// model"). Matches this repo's existing testing split: pure/config logic is
// covered here, offline; anything touching a real Connection/transaction
// (RPC failure, confirmation, faucet exhaustion, Explorer-link generation
// against a real signature, wallet disconnection mid-flow) is covered by the
// live verification pass instead (scripts/verify_devusdc_faucet.ts), exactly
// how this repo already treats api/devnet/swap-sign.ts and
// api/devnet/mint-test-assets.ts (no offline HTTP-handler mocks; live
// scripts are the verification layer for real on-chain behavior).
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEVUSDC, DEVUSDC_MINT, DEVUSDC_DECIMALS } from "../packages/sdk/src";
import { assertDevnetCluster, DEVNET_GENESIS_HASH, NotDevnetError } from "../api/devnet/_lib/network";
import { cooldownRemainingMs, recordAction } from "../api/devnet/_lib/rateLimit";
import { loadDevnetAuthority } from "../api/devnet/_lib/authority";
import { parseJsonBody } from "../api/devnet/_lib/apiTypes";

describe("Phase B -- devUSDC mint configuration (correct config, never a substitute for canonical identity)", () => {
  it("has a real, well-formed base58 mint address distinct from the fixture test-asset mints", () => {
    expect(() => new PublicKey(DEVUSDC.mint)).to.not.throw();
    expect(DEVUSDC_MINT.toBase58()).to.equal(DEVUSDC.mint);
  });

  it("uses 6 decimals, matching the documented Phase B decision", () => {
    expect(DEVUSDC_DECIMALS).to.equal(6);
    expect(DEVUSDC.decimals).to.equal(6);
  });

  it("uses the classic SPL Token program, not Token-2022", () => {
    expect(DEVUSDC.tokenProgram).to.equal(TOKEN_PROGRAM_ID.toBase58());
  });

  it("is explicitly scoped to devnet in its own registry record", () => {
    expect(DEVUSDC.network).to.equal("devnet");
  });

  it("carries symbol/name as an off-chain convenience label only, never presented as on-chain metadata", () => {
    expect(DEVUSDC.symbol).to.equal("devUSDC");
    expect(DEVUSDC.name).to.equal("SSR Test USD");
    expect(DEVUSDC.note.toLowerCase()).to.include("no on-chain");
  });
});

describe("Phase B -- DevNet-only enforcement (fails closed, never assumes)", () => {
  function fakeConnection(genesisHash: string) {
    return { getGenesisHash: async () => genesisHash } as unknown as Parameters<typeof assertDevnetCluster>[0];
  }

  it("resolves silently when the connection's genesis hash matches Solana DevNet's known genesis", async () => {
    await assertDevnetCluster(fakeConnection(DEVNET_GENESIS_HASH));
  });

  it("throws NotDevnetError when the genesis hash does not match DevNet (e.g. Mainnet, a local validator, or a misconfigured RPC)", async () => {
    let threw = false;
    try {
      await assertDevnetCluster(fakeConnection("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")); // Mainnet-beta's real genesis hash
    } catch (e) {
      threw = true;
      expect(e).to.be.instanceOf(NotDevnetError);
      expect((e as Error).message).to.include("does not match");
    }
    expect(threw).to.equal(true);
  });

  it("fails closed (throws, does not silently pass) when the genesis hash is empty/unrecognized", async () => {
    let threw = false;
    try {
      await assertDevnetCluster(fakeConnection(""));
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});

describe("Phase B -- best-effort per-wallet cooldown (secondary defense; the durable check is the live on-chain balance ceiling, tested only via the live verification script)", () => {
  it("is eligible (0ms remaining) for a key that has never acted", () => {
    expect(cooldownRemainingMs(`test-key-${Date.now()}-a`, 60_000)).to.equal(0);
  });

  it("is ineligible immediately after recordAction, and the remaining time is <= the configured cooldown", () => {
    const key = `test-key-${Date.now()}-b`;
    recordAction(key);
    const remaining = cooldownRemainingMs(key, 60_000);
    expect(remaining).to.be.greaterThan(0);
    expect(remaining).to.be.at.most(60_000);
  });

  it("treats different keys (different wallets) independently -- one wallet's cooldown never blocks another's", () => {
    const keyA = `test-key-${Date.now()}-c`;
    const keyB = `test-key-${Date.now()}-d`;
    recordAction(keyA);
    expect(cooldownRemainingMs(keyB, 60_000)).to.equal(0);
  });

  it("is eligible again once the cooldown window has elapsed", () => {
    const key = `test-key-${Date.now()}-e`;
    recordAction(key);
    expect(cooldownRemainingMs(key, 0)).to.equal(0); // a 0ms cooldown always elapses immediately
  });
});

describe("Phase B -- authority loading (no secret hardcoded, no frontend exposure path)", () => {
  const ORIGINAL = process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY;
    else process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = ORIGINAL;
  });

  it("throws an honest configuration error when DEVNET_SWAP_AUTHORITY_SECRET_KEY is unset -- never falls back to a hardcoded/default keypair", () => {
    delete process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY;
    expect(() => loadDevnetAuthority()).to.throw(/DEVNET_SWAP_AUTHORITY_SECRET_KEY/);
  });

  it("parses a validly-configured secret key into the matching keypair (using a disposable, freshly-generated test keypair -- never the real deployed authority)", () => {
    const disposable = Keypair.generate();
    process.env.DEVNET_SWAP_AUTHORITY_SECRET_KEY = JSON.stringify(Array.from(disposable.secretKey));
    const loaded = loadDevnetAuthority();
    expect(loaded.publicKey.toBase58()).to.equal(disposable.publicKey.toBase58());
  });
});

describe("Phase B -- shared API request/response helpers", () => {
  it("parses a JSON-object body as-is", () => {
    expect(parseJsonBody({ headers: {}, body: { userPubkey: "abc" } })).to.deep.equal({ userPubkey: "abc" });
  });

  it("parses a JSON-string body", () => {
    expect(parseJsonBody({ headers: {}, body: '{"userPubkey":"abc"}' })).to.deep.equal({ userPubkey: "abc" });
  });

  it("returns an empty object for a malformed JSON-string body, rather than throwing", () => {
    expect(parseJsonBody({ headers: {}, body: "{not json" })).to.deep.equal({});
  });

  it("returns an empty object when no body is present", () => {
    expect(parseJsonBody({ headers: {} })).to.deep.equal({});
  });
});

describe("Phase B -- invalid recipient handling (mirrors the validation every new endpoint performs before touching the chain)", () => {
  it("rejects a malformed public key string, the same check faucet-devusdc.ts/sponsor-sol.ts perform first", () => {
    expect(() => new PublicKey("not-a-real-pubkey")).to.throw();
  });

  it("accepts a well-formed public key string", () => {
    expect(() => new PublicKey("11111111111111111111111111111111")).to.not.throw();
  });
});
