// Offline, pure-logic regression coverage for the Helius RPC integration and
// the Buy 429/"insufficient SOL" diagnosis pass (see
// docs/project/DECISION_LOG.md). Matches this repo's existing testing split
// -- pure logic covered here offline; a real live Buy against DevNet is
// covered separately (see scripts/verify_rpc_resilience_buy.ts and this
// pass's own live-verification run recorded in PROJECT_STATUS.md).
import { expect } from "chai";
import { WRAPPED_SOL_MINT, DEVUSDC } from "../packages/sdk/src";
import { resolveRpcUrl, FALLBACK_RPC_URL } from "../api/devnet/_lib/rpc";
import { checkRateWindow } from "../api/devnet/_lib/rateLimit";
import { ALLOWED_METHODS, methodNotAllowed, invalidRequest } from "../api/devnet/rpc-proxy";
import { sumWrappedSolLegLamports, SwapAuthorityLowSolError } from "../api/devnet/swap-sign";
import { ZapBuildError } from "../src/merge/lib/zapClient";

describe("Helius RPC integration -- server-side endpoint resolution (resolveRpcUrl)", () => {
  const originalHelius = process.env.HELIUS_RPC_URL;
  const originalSolana = process.env.SOLANA_RPC_URL;

  afterEach(() => {
    if (originalHelius === undefined) delete process.env.HELIUS_RPC_URL;
    else process.env.HELIUS_RPC_URL = originalHelius;
    if (originalSolana === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = originalSolana;
  });

  it("prefers HELIUS_RPC_URL over everything else when set", () => {
    process.env.HELIUS_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test-key";
    process.env.SOLANA_RPC_URL = "https://some-other-endpoint.example";
    expect(resolveRpcUrl()).to.equal("https://devnet.helius-rpc.com/?api-key=test-key");
  });

  it("falls back to SOLANA_RPC_URL when Helius isn't configured", () => {
    delete process.env.HELIUS_RPC_URL;
    process.env.SOLANA_RPC_URL = "https://some-other-endpoint.example";
    expect(resolveRpcUrl()).to.equal("https://some-other-endpoint.example");
  });

  it("falls back to the public DevNet endpoint when neither is configured", () => {
    delete process.env.HELIUS_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    expect(resolveRpcUrl()).to.equal(FALLBACK_RPC_URL);
    expect(FALLBACK_RPC_URL).to.equal("https://api.devnet.solana.com");
  });
});

describe("rpc-proxy -- method allowlist (only what this app's own Connection genuinely calls)", () => {
  it("allows every read/submit method the frontend actually uses", () => {
    for (const m of ["getLatestBlockhash", "getBalance", "getAccountInfo", "getMultipleAccounts", "getTokenSupply", "getTokenAccountBalance", "getSignatureStatuses", "getBlockHeight", "getMinimumBalanceForRentExemption", "sendTransaction"]) {
      expect(ALLOWED_METHODS.has(m), m).to.equal(true);
    }
  });

  it("never allows getProgramAccounts (confirmed blocked/403 on the public DevNet RPC, and not needed by this app's discovery design)", () => {
    expect(ALLOWED_METHODS.has("getProgramAccounts")).to.equal(false);
  });

  it("never allows requestAirdrop or any account-mutating admin method", () => {
    for (const m of ["requestAirdrop", "setLogFilter", "deleteAccount", "getIdentity"]) {
      expect(ALLOWED_METHODS.has(m)).to.equal(false);
    }
  });

  it("methodNotAllowed/invalidRequest produce well-formed JSON-RPC 2.0 error shapes preserving the caller's id", () => {
    const notAllowed = methodNotAllowed(42);
    expect(notAllowed).to.deep.equal({ jsonrpc: "2.0", id: 42, error: { code: -32601, message: "Method not permitted via this proxy." } });
    const invalid = invalidRequest("abc", "bad request");
    expect(invalid.id).to.equal("abc");
    expect(invalid.error.code).to.equal(-32600);
  });
});

describe("rpc-proxy -- best-effort per-IP throttle (checkRateWindow)", () => {
  it("allows requests under the cap within the window", () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 5; i++) expect(checkRateWindow(key, 1000, 5)).to.equal(true);
  });

  it("blocks once the cap within the window is exceeded", () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(checkRateWindow(key, 1000, 3)).to.equal(true);
    expect(checkRateWindow(key, 1000, 3)).to.equal(false);
  });

  it("resets after the window elapses", async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    expect(checkRateWindow(key, 50, 1)).to.equal(true);
    expect(checkRateWindow(key, 50, 1)).to.equal(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(checkRateWindow(key, 50, 1)).to.equal(true);
  });

  it("tracks independent keys independently -- one client's throttle never blocks another's", () => {
    const a = `test-a-${Date.now()}`;
    const b = `test-b-${Date.now()}`;
    expect(checkRateWindow(a, 1000, 1)).to.equal(true);
    expect(checkRateWindow(a, 1000, 1)).to.equal(false);
    expect(checkRateWindow(b, 1000, 1)).to.equal(true);
  });
});

describe("Buy diagnosis -- devUSDC amount scaling (guards the exact decimals bug hypothesis)", () => {
  it("devUSDC has exactly 6 decimals -- 50 devUSDC must scale to 50_000_000 raw units, never 9-decimals-scaled or unscaled", () => {
    expect(DEVUSDC.decimals).to.equal(6);
    const numBuyAmount = 50;
    const devUsdcAmountRaw = BigInt(Math.floor(numBuyAmount * 10 ** DEVUSDC.decimals));
    expect(devUsdcAmountRaw).to.equal(50_000_000n);
    // Ruling out the two most likely regressions this test guards against:
    expect(devUsdcAmountRaw).to.not.equal(50n); // "devUSDC interpreted as lamports" (no scaling at all)
    expect(devUsdcAmountRaw).to.not.equal(50_000_000_000n); // accidental 9-decimal (SOL-style) scaling
  });

  it("never double-scales a fractional amount (e.g. 12.5 devUSDC)", () => {
    const devUsdcAmountRaw = BigInt(Math.floor(12.5 * 10 ** DEVUSDC.decimals));
    expect(devUsdcAmountRaw).to.equal(12_500_000n);
  });
});

describe("Buy diagnosis -- swap-authority SOL sufficiency (sumWrappedSolLegLamports, SwapAuthorityLowSolError)", () => {
  it("sums only the wrapped-SOL leg's requirement, ignoring every token leg", () => {
    const assets = [{ mint: "mockXMintAddress111111111111111111111111111" }, { mint: WRAPPED_SOL_MINT.toBase58() }, { mint: "mockYMintAddress111111111111111111111111111" }];
    const amounts = [500_000n, 2_000_000_000n, 300_000n];
    expect(sumWrappedSolLegLamports(assets, amounts)).to.equal(2_000_000_000n);
  });

  it("returns 0 when the Reserve has no wrapped-SOL leg at all (e.g. an all-token-asset Reserve) -- never a bogus SOL requirement for a Buy that doesn't touch SOL", () => {
    const assets = [{ mint: "mockXMintAddress111111111111111111111111111" }, { mint: "mockYMintAddress111111111111111111111111111" }];
    const amounts = [500_000n, 300_000n];
    expect(sumWrappedSolLegLamports(assets, amounts)).to.equal(0n);
  });

  it("SwapAuthorityLowSolError carries a distinguishing code and never implies the CONNECTED WALLET is short on SOL", () => {
    const err = new SwapAuthorityLowSolError(10_000_000n, 1_000_000n);
    expect(err.code).to.equal("swap_authority_low_sol");
    expect(err.message.toLowerCase()).to.include("not a problem with your wallet");
    expect(err.message).to.include("0.0100"); // required, formatted in SOL
    expect(err.message).to.include("0.0010"); // available, formatted in SOL
  });
});

describe("Buy diagnosis -- client-side error classification (ZapBuildError)", () => {
  it("carries the server's distinguishing code so the UI can tell congestion, swap-authority-SOL, and generic build failures apart", () => {
    const congested = new ZapBuildError("Solana DevNet RPC is temporarily congested.", "rpc_congested");
    expect(congested.code).to.equal("rpc_congested");
    expect(congested).to.be.instanceOf(Error);

    const lowSol = new ZapBuildError("The DevNet swap adapter's own SOL balance is too low.", "swap_authority_low_sol");
    expect(lowSol.code).to.equal("swap_authority_low_sol");

    const generic = new ZapBuildError("Reserve is not Active.");
    expect(generic.code).to.equal(undefined);
  });
});
