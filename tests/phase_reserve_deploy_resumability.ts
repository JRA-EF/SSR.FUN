// Offline, pure-logic regression coverage for the resumable Reserve
// deployment pass. Root cause: a live-reported DevNet failure ("Reserve
// deployment fails during 'Funding seed assets (DevNet)' with
// InstructionError / Custom 6400, and the UI then tells the user to create
// another Reserve") traced to two real, confirmed bugs: (1) the reported
// error code 6400 does not exist anywhere in ssr_protocol's entire
// 6000-6040 custom-error range (confirmed against both errors.rs and the
// built IDL -- see describeOnChainError's tests below), and (2)
// createReserveOnChain/CreateDTR.tsx had NO step-level resume path at all --
// a failure any time after create-and-register landed discarded the one
// persisted pointer to the real, half-built on-chain Reserve and funneled
// the user back to a blank form whose only action created a SEPARATE
// Reserve. Matches this repo's existing testing split (see
// phase_rpc_resilience.ts, phase_buy_chart_category_deploy_pass.ts): pure
// decision logic covered here offline; a real signed DevNet resume is
// covered separately by manual/live verification (see PROJECT_STATUS.md).
//
// Maps to the required regression scenarios:
//   1. Fresh Reserve deployment                -> "start-fresh" resume point
//   2. Failure after the Reserve account is created -> "resume-from-funding"
//   3. Failure during seed-asset funding        -> computeFundingShortfall
//   4. Retrying/resuming a partial deployment   -> resume-point + shortfall combined
//   5. Repeated clicks / concurrent submissions  -> pending-marker persistence
//   6. An already completed deployment          -> "already-complete" resume point
//   7. Wallet rejection and expired-tx recovery  -> isWalletRejectionError + error decoding
import { expect } from "chai";
import {
  determineDeploymentResumePoint,
  computeFundingShortfall,
  isPendingDeployStale,
  isWalletRejectionError,
  PENDING_DEPLOY_STALE_MS,
} from "../src/merge/lib/createReserveResume";
import { decodeSsrProtocolError, extractCustomErrorCode, describeOnChainError, ssrProtocolErrorCodeRange } from "../packages/sdk/src/errors";
import { savePendingReserveDeploy, readPendingReserveDeploy, clearPendingReserveDeploy } from "../src/merge/lib/createReserveClient";

describe("Reserve deploy resumability -- 1. Fresh Reserve deployment (determineDeploymentResumePoint)", () => {
  it("reports start-fresh when no Reserve account exists on-chain yet", () => {
    const point = determineDeploymentResumePoint({ reserveExists: false, reserveStatus: null, onChainAssetCount: 0, expectedAssetCount: 2 });
    expect(point).to.deep.equal({ kind: "start-fresh" });
  });
});

describe("Reserve deploy resumability -- 2. Failure after the Reserve account is created", () => {
  it("reports resume-from-funding when create-and-register landed with exactly the expected assets registered", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "assetsInitializing", onChainAssetCount: 2, expectedAssetCount: 2 });
    expect(point).to.deep.equal({ kind: "resume-from-funding" });
  });

  it("refuses to resume automatically when the real on-chain asset count doesn't match what was expected -- never guesses at reconciling a mismatch", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "assetsInitializing", onChainAssetCount: 1, expectedAssetCount: 2 });
    expect(point).to.deep.equal({ kind: "asset-count-mismatch", onChainAssetCount: 1, expectedAssetCount: 2 });
  });
});

describe("Reserve deploy resumability -- 3. Failure during seed-asset funding (computeFundingShortfall)", () => {
  it("requests the FULL amount when the wallet holds nothing yet (fresh deployment behavior, unchanged)", () => {
    expect(computeFundingShortfall(1_000_000n, 0n)).to.equal(1_000_000n);
  });

  it("requests only the genuine shortfall after a partial success -- the idempotency fix", () => {
    // e.g. the DevNet faucet call landed (wallet now holds 600_000) but the
    // SOL-wrap leg then hit an expired blockhash -- a retry must top up only
    // the missing 400_000, never re-mint/re-wrap the full amount again.
    expect(computeFundingShortfall(1_000_000n, 600_000n)).to.equal(400_000n);
  });

  it("requests nothing once the wallet already holds enough -- never over-funds on a retry", () => {
    expect(computeFundingShortfall(1_000_000n, 1_000_000n)).to.equal(0n);
    expect(computeFundingShortfall(1_000_000n, 5_000_000n)).to.equal(0n);
  });
});

describe("Reserve deploy resumability -- 4. Retrying and resuming a partial deployment (combined)", () => {
  it("a Reserve stuck in assetsInitializing with a partially-funded wallet resumes by funding only the shortfall, never re-registering assets", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "assetsInitializing", onChainAssetCount: 1, expectedAssetCount: 1 });
    expect(point.kind).to.equal("resume-from-funding");
    const shortfall = computeFundingShortfall(2_000_000n, 750_000n);
    expect(shortfall).to.equal(1_250_000n);
  });

  it("a Reserve that reached Active between the failed attempt and the resume click is reported already-complete -- never re-seeded", () => {
    // e.g. an earlier seed_reserve call's confirmation came back "unknown"
    // (RPC timeout) but had actually landed -- resuming must detect this via
    // a fresh on-chain read, not blindly resubmit seed_reserve.
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "active", onChainAssetCount: 1, expectedAssetCount: 1 });
    expect(point).to.deep.equal({ kind: "already-complete" });
  });
});

describe("Reserve deploy resumability -- 5. Repeated clicks / concurrent submissions (pending-marker persistence)", () => {
  before(() => {
    // ts-mocha runs under plain Node, which has no `localStorage` global --
    // shim a minimal in-memory version (shared, like a real browser's
    // localStorage is shared across tabs of the same origin) so the marker
    // that gates a second concurrent submission gets genuine round-trip
    // coverage, not just its try/catch fallback.
    const store = new Map<string, string>();
    (global as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage;
  });
  afterEach(() => clearPendingReserveDeploy());

  const ASSETS = [{ mint: "MintX", decimals: 6, seedWeightFraction: 1 }];

  it("a second read (simulating a second tab / a fast second click) sees the SAME pending deployment a first submission already wrote -- this is what lets a concurrent attempt be blocked instead of starting a duplicate", () => {
    savePendingReserveDeploy({ wallet: "WalletA", reserve: "ReserveA", reserveId: "7", name: "Test", ticker: "TST", startedAt: Date.now(), assets: ASSETS, seedTotalUsd: 25 });
    const firstTabRead = readPendingReserveDeploy("WalletA");
    const secondTabRead = readPendingReserveDeploy("WalletA");
    expect(firstTabRead).to.deep.equal(secondTabRead);
    expect(secondTabRead?.reserve).to.equal("ReserveA");
  });

  it("clearing after a genuinely terminal outcome (success, or confirmed nothing landed) lets a later, real new deployment proceed", () => {
    savePendingReserveDeploy({ wallet: "WalletA", reserve: "ReserveA", reserveId: "7", name: "Test", ticker: "TST", startedAt: Date.now(), assets: ASSETS, seedTotalUsd: 25 });
    clearPendingReserveDeploy();
    expect(readPendingReserveDeploy("WalletA")).to.equal(null);
  });
});

describe("Reserve deploy resumability -- 6. An already completed deployment", () => {
  it("Active, Paused, WindDown, and Closed all report already-complete -- none of them should ever trigger a re-seed attempt", () => {
    for (const status of ["active", "paused", "windDown", "closed"] as const) {
      const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: status, onChainAssetCount: 3, expectedAssetCount: 3 });
      expect(point, status).to.deep.equal({ kind: "already-complete" });
    }
  });

  it("isPendingDeployStale is a pure display signal only -- it does not gate resumability (readPendingReserveDeploy has no expiry, see its own test file)", () => {
    expect(isPendingDeployStale(Date.now() - PENDING_DEPLOY_STALE_MS - 1, Date.now())).to.equal(true);
    expect(isPendingDeployStale(Date.now() - 1000, Date.now())).to.equal(false);
  });
});

describe("Reserve deploy resumability -- 7. Wallet rejection and expired-transaction recovery", () => {
  it("recognizes @solana/wallet-adapter-base's typed signing-rejection error by name", () => {
    const e = new Error("User rejected the request.");
    e.name = "WalletSignTransactionError";
    expect(isWalletRejectionError(e)).to.equal(true);
  });

  it("recognizes common real-wallet rejection message text even without the typed name", () => {
    expect(isWalletRejectionError(new Error("User rejected the request"))).to.equal(true);
    expect(isWalletRejectionError(new Error("Transaction cancelled by user"))).to.equal(true);
  });

  it("does NOT misclassify an unrelated failure (e.g. an RPC timeout) as a wallet rejection", () => {
    expect(isWalletRejectionError(new Error("DevNet RPC could not confirm signature sig123 within the verification window."))).to.equal(false);
  });

  // --- Error decoding: the actual "Custom 6400" root-cause fix -------------
  it("decodes a real ssr_protocol custom-error code against the deployed IDL", () => {
    const decoded = decodeSsrProtocolError(6010); // UnexpectedReserveStatus
    expect(decoded?.name).to.equal("UnexpectedReserveStatus");
  });

  it("confirms 6400 is NOT a real ssr_protocol error -- this program's entire custom-error range is 6000-6043 (grew from 6000-6040 in the 2026-08-13 corrective pass, which added PendingFeesNotCollected plus 2 previously-undocumented entries -- see DEC-0093)", () => {
    expect(decodeSsrProtocolError(6400)).to.equal(null);
    expect(ssrProtocolErrorCodeRange()).to.equal("6000-6043");
  });

  it("extracts a Custom(N) code from a raw InstructionError object (e.g. status.err from getSignatureStatuses)", () => {
    const code = extractCustomErrorCode({ InstructionError: [0, { Custom: 6020 }] });
    expect(code).to.equal(6020);
  });

  it("extracts a Custom(N) code from a JSON-stringified InstructionError (e.g. confirmSignatureBounded's outcome.error)", () => {
    const stringified = JSON.stringify({ InstructionError: [0, { Custom: 6400 }] });
    expect(extractCustomErrorCode(new Error(`Transaction failed on-chain (${stringified}). Signature: sigXYZ.`))).to.equal(6400);
  });

  it("extracts a Custom(N) code from the cluster's own 'custom program error: 0x..' text", () => {
    expect(extractCustomErrorCode(new Error("failed: custom program error: 0x1770"))).to.equal(6000); // 0x1770 == 6000
  });

  it("returns null (never a guessed code) when no error-code shape is present at all", () => {
    expect(extractCustomErrorCode(new Error("Blockhash not found"))).to.equal(null);
  });

  it("describeOnChainError decodes a recognized code into its real name and message", () => {
    const stringified = JSON.stringify({ InstructionError: [0, { Custom: 6020 }] });
    const described = describeOnChainError(new Error(`Transaction failed on-chain (${stringified}).`));
    expect(described).to.include("SsrError::ReserveAlreadySeeded");
    expect(described).to.include("Reserve has already been seeded");
  });

  it("describeOnChainError says PLAINLY that an unrecognized code (like the reported 6400) is not a genuine ssr_protocol error, instead of fabricating a meaning for it", () => {
    const stringified = JSON.stringify({ InstructionError: [0, { Custom: 6400 }] });
    const described = describeOnChainError(new Error(`Transaction failed on-chain (${stringified}).`));
    expect(described).to.include("6400");
    expect(described).to.include("not defined anywhere in the deployed SSR Protocol IDL");
    expect(described).to.include("6000-6043");
  });

  it("describeOnChainError passes through a message unchanged when it carries no error code at all", () => {
    expect(describeOnChainError(new Error("Blockhash not found"))).to.equal("Blockhash not found");
  });
});
