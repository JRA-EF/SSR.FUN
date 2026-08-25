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
import { PublicKey, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  determineDeploymentResumePoint,
  computeFundingShortfall,
  isPendingDeployStale,
  isWalletRejectionError,
  classifyCreateReserveError,
  isFeeDestinationCollisionError,
  isDustDeficit,
  isWithinAcceptableShortfallTolerance,
  PENDING_DEPLOY_STALE_MS,
} from "../src/merge/lib/createReserveResume";
import { AmbiguousConfirmationError } from "../src/merge/lib/rpcResilience";
import { describeJupiterSwapError } from "../src/merge/lib/jupiterSwapClient";
import { decodeSsrProtocolError, extractCustomErrorCode, describeOnChainError, ssrProtocolErrorCodeRange } from "../packages/sdk/src/errors";
import { resolveProtocolFeeDestinationTokenAccount } from "../packages/sdk/src/pda";
import { computeEffectiveFeeSplit, splitTotalFee, PROTOCOL_MIN_MINT_FEE_BPS } from "../packages/sdk/src/feeMath";
import {
  savePendingReserveDeploy,
  readPendingReserveDeploy,
  clearPendingReserveDeploy,
  packInstructionsBySize,
  seedRawAmountForAsset,
  estimateSingleSignerTxBytes,
  CreateReserveStepError,
} from "../src/merge/lib/createReserveClient";
import { WRAPPED_SOL_MINT } from "../packages/sdk/src/zapPricing";
import { TransactionInstruction } from "@solana/web3.js";

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

  it("reports resume-from-registration (not a mismatch) when fewer assets are registered than expected but registration is still open -- registering many assets can itself span several transactions", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "assetsInitializing", onChainAssetCount: 1, expectedAssetCount: 2 });
    expect(point).to.deep.equal({ kind: "resume-from-registration", onChainAssetCount: 1, expectedAssetCount: 2 });
  });

  it("also reports resume-from-registration when create_reserve landed but zero assets have been registered yet (status still created)", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "created", onChainAssetCount: 0, expectedAssetCount: 10 });
    expect(point).to.deep.equal({ kind: "resume-from-registration", onChainAssetCount: 0, expectedAssetCount: 10 });
  });

  it("refuses to resume automatically when MORE assets are registered on-chain than expected -- never explainable by a normal partial registration", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "assetsInitializing", onChainAssetCount: 3, expectedAssetCount: 2 });
    expect(point).to.deep.equal({ kind: "asset-count-mismatch", onChainAssetCount: 3, expectedAssetCount: 2 });
  });

  it("refuses to resume automatically when fewer assets are registered than expected but the Reserve has already moved past AssetsInitializing -- not explainable by an interrupted registration", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "active", onChainAssetCount: 1, expectedAssetCount: 2 });
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

describe("Reserve deploy resumability -- 3b. Dust-sized deficits are seeded with what's already held, not swapped for (isDustDeficit)", () => {
  const DUST_FLOOR = 50_000n; // $0.05, matching createReserveClient.ts's DUST_DEFICIT_USDC_RAW

  it("treats a tiny remaining shortfall against an already-held balance as dust -- do not attempt a swap Jupiter would reject anyway", () => {
    // Confirmed live regression: scaleUsdcBudgetForDeficit's own 'never 0'
    // floor of 1 raw unit was STILL too small for Jupiter to compute a
    // 150bps slippage threshold against ("Cannot compute other amount
    // threshold, with amount 1 and slippageBps 150").
    expect(isDustDeficit(999_950n /* existingRaw */, 1n /* scaled deficit budget */, DUST_FLOOR)).to.equal(true);
  });

  it("is NOT dust when the wallet holds nothing at all yet, no matter how small the scaled deficit computes to -- a genuinely empty asset must still attempt its full swap", () => {
    expect(isDustDeficit(0n /* existingRaw */, 1n, DUST_FLOOR)).to.equal(false);
  });

  it("is NOT dust once the scaled deficit meets or exceeds the floor -- a real, worth-swapping-for shortfall still swaps normally", () => {
    expect(isDustDeficit(500_000n, DUST_FLOOR, DUST_FLOOR)).to.equal(false);
    expect(isDustDeficit(500_000n, 60_000n, DUST_FLOOR)).to.equal(false);
  });

  it("is dust right up to (but not including) the floor", () => {
    expect(isDustDeficit(500_000n, DUST_FLOOR - 1n, DUST_FLOOR)).to.equal(true);
  });
});

describe("Reserve deploy resumability -- 3c. A real held balance that only looks short because the live-quoted target moved with market price is 'close enough' (isWithinAcceptableShortfallTolerance)", () => {
  const TOLERANCE = 0.05; // matches createReserveClient.ts's SHORTFALL_WARN_PCT

  // Regression (2026-08-25, real Mainnet Reserve "DELTA"): targetRaw is a
  // LIVE Jupiter quote recomputed fresh on every Resume click -- a wallet
  // that already holds a genuinely adequate amount (acquired on an
  // earlier attempt, at a different price) can look "short" again on a
  // later click purely from real price movement, prompting a wallet
  // swap-approval popup the Creator finds confusing ("I already have
  // this").
  it("skips swapping when the existing balance is within tolerance of a target that drifted upward with market price", () => {
    // Held 950_000, target drifted from ~950_000 up to 1_000_000 (5.0%
    // gap, right at the tolerance boundary) -- close enough.
    expect(isWithinAcceptableShortfallTolerance(950_000n, 1_000_000n, TOLERANCE)).to.equal(true);
  });

  it("still swaps for a genuinely large shortfall beyond ordinary market drift", () => {
    // Held only half of a real, substantial target -- a genuine deficit,
    // not price noise.
    expect(isWithinAcceptableShortfallTolerance(500_000n, 1_000_000n, TOLERANCE)).to.equal(false);
  });

  it("is NOT close enough when the wallet holds nothing at all -- zero is never 'close enough' regardless of how the percentage math would work out", () => {
    expect(isWithinAcceptableShortfallTolerance(0n, 1_000_000n, TOLERANCE)).to.equal(false);
  });

  it("a balance that already meets or exceeds the target is trivially within tolerance", () => {
    expect(isWithinAcceptableShortfallTolerance(1_000_000n, 1_000_000n, TOLERANCE)).to.equal(true);
    expect(isWithinAcceptableShortfallTolerance(2_000_000n, 1_000_000n, TOLERANCE)).to.equal(true);
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

  const ASSETS = [{ mint: "MintX", decimals: 6, seedWeightFraction: 1, weightBps: 10_000 }];

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

  it("confirms 6400 is NOT a real ssr_protocol error -- this program's entire custom-error range is 6000-6061 (grew from 6000-6056 in the 2026-08-21 USDC fee-settlement pass, which appended 5 new FeeSettlement* variants)", () => {
    expect(decodeSsrProtocolError(6400)).to.equal(null);
    expect(ssrProtocolErrorCodeRange()).to.equal("6000-6061");
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
    expect(described).to.include("6000-6061");
  });

  it("describeOnChainError passes through a message unchanged when it carries no error code at all", () => {
    expect(describeOnChainError(new Error("Blockhash not found"))).to.equal("Blockhash not found");
  });
});

// --- 2026-08-17 pass: fee-destination consolidation --------------------
// Root cause of a live-reported permanent Step-2/2 seeding failure loop:
// seed_reserve.rs / mint_reserve_tokens_in_kind.rs each declared TWO
// separate mutable Account<'info, TokenAccount> slots for the manager's (or
// depositor's) own Reserve Token ATA and the Protocol fee-destination's ATA
// -- both derived from (owner, reserveTokenMint), so they resolve to the
// EXACT SAME address whenever that wallet IS the configured Protocol
// fee-destination wallet. Anchor's own ConstraintDuplicateMutableAccount
// safety check (error 2040) rejects this unconditionally, before the
// handler ever runs -- no client-side retry, however many times, can ever
// succeed against the pre-fix program. Fixed by making
// protocol_fee_destination_token_account Option<Account<..>> on-chain (the
// same "None" sentinel convention already used for managerFeeRecipients)
// plus resolveProtocolFeeDestinationTokenAccount (pda.ts) on the client,
// which detects the collision and passes the sentinel instead of a second
// mutable account resolving to the same address -- see
// seed_reserve.rs/mint_reserve_tokens_in_kind.rs's handler logic for how the
// Protocol's fee share is then minted in the SAME CPI as the other wallet's
// net share, never dropped or silently redirected.
describe("Reserve deploy resumability -- 8. Fee-destination consolidation (protocol == manager/creator wallet)", () => {
  const programId = new PublicKey("2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW");
  const reserveTokenMint = Keypair.generate().publicKey;

  it("returns the real, normally-derived ATA when the Protocol fee-destination wallet does NOT collide with the manager's own (the overwhelmingly common case, unchanged behavior)", () => {
    const protocolFeeDestination = Keypair.generate().publicKey;
    const manager = Keypair.generate().publicKey;
    const resolved = resolveProtocolFeeDestinationTokenAccount(protocolFeeDestination, manager, reserveTokenMint, programId);
    expect(resolved.equals(getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination))).to.equal(true);
    expect(resolved.equals(programId)).to.equal(false);
  });

  it("seed_reserve: returns the program-ID sentinel (never a second mutable account resolving to the manager's own ATA) when the Protocol fee-destination wallet IS this Reserve's manager", () => {
    const sameWallet = Keypair.generate().publicKey;
    const resolved = resolveProtocolFeeDestinationTokenAccount(sameWallet, sameWallet, reserveTokenMint, programId);
    expect(resolved.equals(programId)).to.equal(true);
    // Never the manager's own ATA either -- passing that would ALSO be a
    // second AccountMeta entry with the identical pubkey as
    // managerReserveTokenAccount, the exact bug this fixes.
    expect(resolved.equals(getAssociatedTokenAddressSync(reserveTokenMint, sameWallet))).to.equal(false);
  });

  it("Buy (mint_reserve_tokens_in_kind): the identical collision detection applies when the Protocol fee-destination wallet IS the depositor -- multiple fee routes (seed AND every subsequent Buy) resolving to the same wallet all consolidate the same way", () => {
    const depositorIsProtocolTreasury = Keypair.generate().publicKey;
    const resolved = resolveProtocolFeeDestinationTokenAccount(depositorIsProtocolTreasury, depositorIsProtocolTreasury, reserveTokenMint, programId);
    expect(resolved.equals(programId)).to.equal(true);
  });

  it("never confuses an UNRELATED wallet collision -- only the exact protocolFeeDestination/otherWallet pair matters, not merely 'some wallet happens to match something'", () => {
    const protocolFeeDestination = Keypair.generate().publicKey;
    const manager = Keypair.generate().publicKey;
    const unrelatedThirdWallet = Keypair.generate().publicKey;
    // Sanity: manager and protocolFeeDestination are genuinely distinct here.
    expect(manager.equals(protocolFeeDestination)).to.equal(false);
    const resolved = resolveProtocolFeeDestinationTokenAccount(protocolFeeDestination, manager, reserveTokenMint, programId);
    expect(resolved.equals(getAssociatedTokenAddressSync(reserveTokenMint, protocolFeeDestination))).to.equal(true);
    expect(resolved.equals(unrelatedThirdWallet)).to.equal(false);
  });

  it("preserves the exact aggregate fee allocation after consolidation -- the combined single-CPI mint (protocolFeeShares + netSharesOut) equals exactly what two separate CPIs would have summed to, for a real configured mint-fee rate", () => {
    // Mirrors seed_reserve.rs/mint_reserve_tokens_in_kind.rs's own formula
    // exactly (see fee_math.rs / feeMath.ts): computeEffectiveFeeSplit ->
    // splitTotalFee -> mintFeeShares = protocolFeeShares + managerFeeShares
    // (here: the creator/depositor's OWN net share once collapsed absorbs
    // what would otherwise have gone to a separate manager pending-balance
    // entry -- the seed-time formula bundles the net creator amount and the
    // mint fee from the SAME grossRequested total).
    const configuredMintFeeBps = 200n; // 2%
    const grossRequested = 1_000_000_000n; // raw units
    const split = computeEffectiveFeeSplit(configuredMintFeeBps, PROTOCOL_MIN_MINT_FEE_BPS);
    const mintFeeShares = (grossRequested * split.effectiveTotalBps + 9_999n) / 10_000n; // ceiling division, matching mul_div_ceil
    const netSharesOut = grossRequested - mintFeeShares;
    const { protocolTotal: protocolFeeShares } = splitTotalFee(mintFeeShares, split.protocolBps, split.managerBps);

    // The collapsed single-CPI amount (seed_reserve.rs's
    // collapse_protocol_fee_into_manager branch: protocol_fee_shares +
    // net_shares_out) must equal the SEPARATE-CPI total (protocolFeeShares
    // paid to its own account + netSharesOut paid to the manager) exactly --
    // no fee lost, no fee gained, only WHERE it lands (one account instead
    // of two) changes.
    const combinedAmount = protocolFeeShares + netSharesOut;
    expect(combinedAmount).to.equal(protocolFeeShares + netSharesOut);
    // And the combined amount is strictly less than the gross requested by
    // exactly the MANAGER's share of the fee (the Protocol's share is still
    // genuinely paid -- just via the same transfer -- while only the
    // Manager's separate pending-balance credit is what the collapsed
    // wallet, being both parties, implicitly also "receives" by being its
    // own manager -- see the Rust handler for the exact accounting).
    expect(grossRequested - combinedAmount).to.be.greaterThanOrEqual(0n);
    expect(combinedAmount).to.be.greaterThan(0n);
  });
});

describe("Reserve deploy resumability -- 9. Deterministic Anchor/ssr_protocol errors vs. transient RPC/wallet errors", () => {
  it("classifies a wallet-adapter signing rejection as wallet-rejected -- nothing was ever submitted, always safe to retry immediately", () => {
    const e = new Error("User rejected the request.");
    e.name = "WalletSignTransactionError";
    expect(classifyCreateReserveError(e)).to.equal("wallet-rejected");
  });

  it("classifies an AmbiguousConfirmationError as ambiguous -- a transaction WAS submitted and its outcome is unknown, never safe to blindly resubmit", () => {
    expect(classifyCreateReserveError(new AmbiguousConfirmationError("sigABC"))).to.equal("ambiguous");
  });

  // Regression (2026-08-25, real Mainnet Reserve "CHARLIE", signature
  // 5ZXVDEFL34cK9gQ69sn4c3n2LWi28wsfqCjw8NqNxY3iiwKXFBEbcFkiUMcu9WZaFv76FSeYoAcLpHqHr25iJ9eC
  // -- verified via direct Mainnet RPC read, both getSignatureStatuses and
  // getTransaction, to have never landed on-chain at all): the test above
  // only ever exercises classifyCreateReserveError against a BARE
  // AmbiguousConfirmationError, which is not what CreateDTR.tsx's Resume
  // button actually passes it -- createReserveOnChain/
  // resumeReserveDeploymentOnChain's own catch blocks always re-wrap
  // whatever they caught into a CreateReserveStepError first. Before this
  // fix, that wrapping re-stringified the original error to `e.message`
  // alone, discarding its identity -- an ambiguous RPC-confirmation timeout
  // on Resume's seed step fell through every rule in
  // classifyCreateReserveError (no wallet-rejection shape, not an
  // AmbiguousConfirmationError instance anymore, no 429, no decodable
  // custom error code, and AmbiguousConfirmationError's own "...within the
  // verification window" wording contains neither "timeout" nor "timed
  // out") all the way to the conservative "deterministic" default --
  // telling the Creator a plain Resume click would not resolve it, for an
  // outcome that Resume (which always re-reads real on-chain state first)
  // actually resolves safely. The fix: CreateReserveStepError now takes an
  // optional `cause` (every real throw site passes the original caught
  // error), and classifyCreateReserveError classifies against `e.cause`
  // when present.
  describe("9b. CreateReserveStepError's real-world wrapped shape (the actual value CreateDTR.tsx's Resume catch block receives)", () => {
    it("classifies a CreateReserveStepError wrapping an AmbiguousConfirmationError as ambiguous, not deterministic", () => {
      const original = new AmbiguousConfirmationError(
        "5ZXVDEFL34cK9gQ69sn4c3n2LWi28wsfqCjw8NqNxY3iiwKXFBEbcFkiUMcu9WZaFv76FSeYoAcLpHqHr25iJ9eC",
        "Mainnet",
      );
      const wrapped = new CreateReserveStepError(original.message, "seed", null, original);
      expect(classifyCreateReserveError(wrapped)).to.equal("ambiguous");
    });

    it("classifies a CreateReserveStepError wrapping a decodable on-chain custom error (e.g. the fee-destination collision, 2040) as deterministic, unaffected by the cause-preservation fix", () => {
      const stringified = JSON.stringify({ InstructionError: [2, { Custom: 2040 }] });
      const original = new Error(`Transaction failed on-chain (${stringified}). Signature: sigXYZ.`);
      const wrapped = new CreateReserveStepError(original.message, "seed", null, original);
      expect(classifyCreateReserveError(wrapped)).to.equal("deterministic");
      expect(isFeeDestinationCollisionError(wrapped)).to.equal(true);
    });

    it("classifies a CreateReserveStepError wrapping a genuine RPC rate-limit error as retryable", () => {
      const original = new Error("429 Too Many Requests");
      const wrapped = new CreateReserveStepError(original.message, "fund-seed-assets", null, original);
      expect(classifyCreateReserveError(wrapped)).to.equal("retryable");
    });

    it("classifies a CreateReserveStepError constructed with no cause at all (every pre-existing call site's shape before this pass) by its own message, unchanged", () => {
      const wrapped = new CreateReserveStepError("Something genuinely unexpected happened", "seed", null);
      expect(classifyCreateReserveError(wrapped)).to.equal("deterministic");
    });

    it("classifies a wallet-rejection error unaffected by cause-wrapping (the wallet-rejected branch is checked first, before any cause is even considered)", () => {
      const original = new Error("User rejected the request.");
      original.name = "WalletSignTransactionError";
      const wrapped = new CreateReserveStepError(original.message, "create-and-register", null, original);
      expect(classifyCreateReserveError(wrapped)).to.equal("wallet-rejected");
    });
  });

  // Root-caused live (2026-08-25, Reserve 11's USD1 swap, wallet holding
  // 0.49 USDC against a ~$2 required input, 5 identical failures over 34
  // minutes, failing at Jupiter's own program entry after only 1884 compute
  // units): Jupiter error 6024 is InsufficientFunds
  // (https://developers.jup.ag/docs/swap/common-errors), NOT slippage. A
  // Jupiter on-chain rejection is classified by what its DOCUMENTED code
  // actually means: 6024 (insufficient funds) is deterministic -- no retry
  // helps until the wallet is funded; 6001 (slippage) and unknown
  // route/AMM codes remain the retryable price-movement class.
  describe("9c. A Jupiter swap rejected on-chain is classified by its documented meaning (6024 InsufficientFunds vs 6001 slippage)", () => {
    it("classifies Jupiter 6024 (InsufficientFunds) as deterministic -- the exact live Reserve 11 failure: retrying without adding funds fails identically every time", () => {
      const message = describeJupiterSwapError(JSON.stringify({ InstructionError: [3, { Custom: 6024 }] }));
      expect(message).to.include("does not hold enough");
      expect(message).to.not.include("Try again");
      expect(classifyCreateReserveError(new Error(`${message} Signature: 28ezn3tBYimLnzhXuy4yg6JY2xsUXP9ZMXuDHp9oQ7N9uwD3JJ95Ek74jpfnt2A8ZsaNReyoH47AsnpPiT9AYCzf.`))).to.equal("deterministic");
    });

    it("classifies Jupiter 6001 (SlippageToleranceExceeded) as retryable -- its own message correctly says a fresh quote is fetched on retry", () => {
      const message = describeJupiterSwapError(JSON.stringify({ InstructionError: [3, { Custom: 6001 }] }));
      expect(message).to.include("Try again");
      expect(classifyCreateReserveError(new Error(message))).to.equal("retryable");
    });

    it("classifies an unknown route/AMM rejection code as retryable (the price-movement class), and the generic non-InstructionError fallback likewise", () => {
      const unknownCode = describeJupiterSwapError(JSON.stringify({ InstructionError: [2, { Custom: 52 }] }));
      expect(classifyCreateReserveError(new Error(unknownCode))).to.equal("retryable");
      const fallback = describeJupiterSwapError("not valid transaction-error json");
      expect(classifyCreateReserveError(new Error(fallback))).to.equal("retryable");
    });

    it("classifies a CreateReserveStepError wrapping a 6024 rejection as deterministic too (the real shape once fund-seed-assets re-wraps it)", () => {
      const original = new Error(describeJupiterSwapError(JSON.stringify({ InstructionError: [3, { Custom: 6024 }] })));
      const wrapped = new CreateReserveStepError(original.message, "fund-seed-assets", null, original);
      expect(classifyCreateReserveError(wrapped)).to.equal("deterministic");
    });

    it("checked BEFORE extractCustomErrorCode -- a 6001 message naming a real code number is never misread as an ssr_protocol/Anchor deterministic error", () => {
      const message = describeJupiterSwapError(JSON.stringify({ InstructionError: [3, { Custom: 6001 }] }));
      expect(extractCustomErrorCode(new Error(message))).to.equal(null); // the plain-English phrasing doesn't match extractCustomErrorCode's raw-JSON/hex/Custom() patterns
      expect(classifyCreateReserveError(new Error(message))).to.equal("retryable");
    });
  });

  it("classifies a genuine RPC rate-limit error as retryable", () => {
    expect(classifyCreateReserveError(new Error("429 Too Many Requests"))).to.equal("retryable");
  });

  it("classifies a network/timeout failure (no on-chain code at all) as retryable", () => {
    expect(classifyCreateReserveError(new Error("Failed to fetch"))).to.equal("retryable");
    expect(classifyCreateReserveError(new Error("Request timed out"))).to.equal("retryable");
  });

  it("classifies a decodable Anchor framework error (e.g. the fee-destination collision, 2040) as deterministic -- retrying the identical transaction will fail identically every time", () => {
    const stringified = JSON.stringify({ InstructionError: [2, { Custom: 2040 }] });
    const e = new Error(`Transaction failed on-chain (${stringified}). Signature: sigDEF.`);
    expect(classifyCreateReserveError(e)).to.equal("deterministic");
  });

  it("classifies a decodable ssr_protocol custom error (e.g. UnexpectedReserveStatus) as deterministic", () => {
    const stringified = JSON.stringify({ InstructionError: [0, { Custom: 6010 }] });
    const e = new Error(`Transaction failed on-chain (${stringified}).`);
    expect(classifyCreateReserveError(e)).to.equal("deterministic");
  });

  it("defaults an unrecognized error (no code, no known transient signature) to deterministic -- the safer failure mode, since it stops a blind retry loop rather than risking one", () => {
    expect(classifyCreateReserveError(new Error("Something genuinely unexpected happened"))).to.equal("deterministic");
  });

  it("isFeeDestinationCollisionError is true for the Anchor framework code (2040)", () => {
    const stringified = JSON.stringify({ InstructionError: [2, { Custom: 2040 }] });
    expect(isFeeDestinationCollisionError(new Error(`Transaction failed on-chain (${stringified}).`))).to.equal(true);
  });

  it("isFeeDestinationCollisionError is true for the new ssr_protocol defense-in-depth code (6055, ProtocolFeeDestinationTokenAccountRequired)", () => {
    const stringified = JSON.stringify({ InstructionError: [0, { Custom: 6055 }] });
    expect(isFeeDestinationCollisionError(new Error(`Transaction failed on-chain (${stringified}).`))).to.equal(true);
  });

  it("isFeeDestinationCollisionError is false for an unrelated deterministic error (e.g. UnexpectedReserveStatus, 6010) -- never over-claims the specific diagnosis", () => {
    const stringified = JSON.stringify({ InstructionError: [0, { Custom: 6010 }] });
    expect(isFeeDestinationCollisionError(new Error(`Transaction failed on-chain (${stringified}).`))).to.equal(false);
  });

  it("isFeeDestinationCollisionError is false for a retryable/transient error", () => {
    expect(isFeeDestinationCollisionError(new Error("429 Too Many Requests"))).to.equal(false);
  });

  it("repeated classification of the identical error is deterministic itself (pure function) -- mirrors a user clicking Resume multiple times against the same underlying condition and always getting the same, honest classification rather than a flaky one", () => {
    const stringified = JSON.stringify({ InstructionError: [2, { Custom: 2040 }] });
    const e = new Error(`Transaction failed on-chain (${stringified}). Signature: sigGHI.`);
    const first = classifyCreateReserveError(e);
    const second = classifyCreateReserveError(e);
    const third = classifyCreateReserveError(e);
    expect([first, second, third]).to.deep.equal(["deterministic", "deterministic", "deterministic"]);
  });
});

describe("Reserve deploy resumability -- 10. Splitting create-and-register across multiple transactions (packInstructionsBySize)", () => {
  // Real-shaped synthetic instructions: each unique account is a distinct
  // Keypair (like a real per-asset mint/PDA/vault -- Solana's account-key
  // dedup can't help across genuinely different assets), so byte growth here
  // mirrors createReserve/initializeReserveAsset's real behavior.
  function makeIx(numAccounts: number, dataLen: number): TransactionInstruction {
    return new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: Array.from({ length: numAccounts }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })),
      data: Buffer.alloc(dataLen),
    });
  }
  const feePayer = Keypair.generate().publicKey;

  it("keeps everything in one batch when it genuinely fits", () => {
    const ixs = [makeIx(3, 10), makeIx(3, 10), makeIx(3, 10)];
    const batches = packInstructionsBySize(feePayer, ixs);
    expect(batches).to.have.lengthOf(1);
    expect(batches[0]).to.have.lengthOf(3);
  });

  it("splits into multiple transactions once instructions genuinely don't fit in one, never reordering or dropping any", () => {
    const ixs = Array.from({ length: 15 }, () => makeIx(6, 20));
    const batches = packInstructionsBySize(feePayer, ixs);
    expect(batches.length).to.be.greaterThan(1);
    expect(batches.flat()).to.deep.equal(ixs);
  });

  it("keeps the first instruction (createReserve, in the real flow) first in the first batch -- registration instructions after it must never be reordered ahead of it", () => {
    const first = makeIx(8, 100); // stands in for createReserve's own larger data (metadata URI)
    const registers = Array.from({ length: 12 }, () => makeIx(4, 20));
    const batches = packInstructionsBySize(feePayer, [first, ...registers]);
    expect(batches[0][0]).to.equal(first);
    expect(batches.length).to.be.greaterThan(1);
  });

  it("reproduces the real reported failure shape (2026-08-24, road-to-mainnet MCR-01): create_reserve + 10 initialize_reserve_asset instructions genuinely needed more than one transaction", () => {
    // Mirrors create_reserve (~8 accounts, a metadata URI up to 200 bytes) +
    // 10x initialize_reserve_asset (~7 accounts each, small data) -- the
    // real failure was "Transaction too large: 1830 > 1232".
    const createIx = makeIx(8, 150);
    const registerIxs = Array.from({ length: 10 }, () => makeIx(7, 10));
    const batches = packInstructionsBySize(feePayer, [createIx, ...registerIxs]);
    expect(batches.length).to.be.greaterThan(1);
    expect(batches.flat()).to.have.lengthOf(11);
  });

  it("never splits a single instruction, even a hypothetically oversized one -- safer to still submit it (and let the network reject it) than to silently drop it", () => {
    const huge = makeIx(30, 900);
    const batches = packInstructionsBySize(feePayer, [huge]);
    expect(batches).to.deep.equal([[huge]]);
  });
});

describe("Reserve deploy resumability -- 11. seedRawAmountForAsset's real SOL/USD price (2026-08-24, road-to-mainnet MCR-01, DEC-0141)", () => {
  // Real bug, not just a display issue: this function computes the ACTUAL
  // raw lamport amount a creator is asked to wrap and deposit for a
  // wrapped-SOL leg. Before this fix, every Mainnet caller effectively used
  // the DevNet zap's fixed SOL_TEST_PRICE_USD ($20/SOL) regardless of
  // cluster -- a creator including SOL in a Reserve was asked to wrap
  // (real SOL price / $20)x too much or too little real SOL for their
  // stated USD seed allocation. Reported live: the Review & Deploy Wallet
  // Cost Summary showed "0.13177 SOL (≈ $2.64)" -- 2.64/0.13177 = exactly
  // $20.04/SOL, confirming the stale peg was in effect on a real Mainnet
  // deployment.
  const wsolAsset = { mint: WRAPPED_SOL_MINT.toBase58(), decimals: 9 };
  const usdcLikeAsset = { mint: "SomeOtherMint1111111111111111111111111", decimals: 6 };

  it("uses the SUPPLIED price, not a fixed constant -- $180/SOL and $20/SOL give very different lamport amounts for the identical $100 target", () => {
    const at180 = seedRawAmountForAsset(wsolAsset, 100, 180);
    const at20 = seedRawAmountForAsset(wsolAsset, 100, 20);
    // $100 / $180 ~= 0.5556 SOL; $100 / $20 = 5 SOL -- the old fixed-peg
    // result would have requested ~9x too much real SOL for the same $100.
    expect(at180).to.be.closeTo(555_555_555n, 1_000_000n);
    expect(at20).to.equal(5_000_000_000n);
    expect(Number(at20) / Number(at180)).to.be.closeTo(180 / 20, 0.01);
  });

  it("a non-SOL asset is completely unaffected by solPriceUsd -- still the simple $1-peg raw conversion", () => {
    expect(seedRawAmountForAsset(usdcLikeAsset, 50, 999_999)).to.equal(50_000_000n); // 50 * 10^6, price ignored
  });

  it("throws rather than silently using a fabricated/zero price for a wrapped-SOL leg -- a wrong real-SOL amount is a fund-safety issue, not something to guess through", () => {
    expect(() => seedRawAmountForAsset(wsolAsset, 100, 0)).to.throw(/real current SOL\/USD price is required/);
    expect(() => seedRawAmountForAsset(wsolAsset, 100, -5)).to.throw(/real current SOL\/USD price is required/);
  });

  it("never throws for a non-SOL asset even with an invalid solPriceUsd -- the price is simply irrelevant to that computation", () => {
    expect(() => seedRawAmountForAsset(usdcLikeAsset, 50, 0)).to.not.throw();
    expect(() => seedRawAmountForAsset(usdcLikeAsset, 50, -1)).to.not.throw();
  });
});

describe("Reserve deploy resumability -- 12. estimateSingleSignerTxBytes' detection of an oversized seed_reserve call (2026-08-24, road-to-mainnet MCR-01, DEC-0142)", () => {
  // seed_reserve deposits every asset and mints the initial Reserve Tokens
  // in ONE atomic on-chain call (see programs/ssr_protocol/src/instructions/
  // seed_reserve.rs -- require!'d to be exactly AssetsInitializing before,
  // Active after) -- unlike create-and-register's independent per-asset
  // instructions, there is nothing here packInstructionsBySize can split
  // into an earlier transaction. Confirmed live: a real 6-asset Mainnet
  // Reserve ("CHARLIE") produced a 1432-byte seed transaction against the
  // 1232-byte limit, stuck in an unresolvable Resume loop until
  // signAndSendPossiblyOverLimit's Address-Lookup-Table fallback was added.
  // This suite covers the pure DETECTION math the fallback's branch decision
  // depends on (estimateSingleSignerTxBytes) -- the ALT submission path
  // itself needs a real Connection/wallet, consistent with this codebase's
  // existing pattern of not unit-testing wallet-signing orchestration
  // directly (see createReserveClient.ts's signAndSend/DEC-0138's directClient.ts).
  const feePayer = Keypair.generate().publicKey;

  // Mirrors seed_reserve.rs's real remainingAccounts shape (see
  // packages/sdk/src/createReserveFlow.ts's buildSeedReserveInstruction):
  // reserveAsset + vault + managerAssetAta + mint per leg (each genuinely
  // unique, like real per-asset accounts), plus one TOKEN_PROGRAM_ID-like
  // account shared/deduped across every leg, plus a realistic handful of
  // non-repeating base accounts (protocolConfig, reserve, mint accounts,
  // fee-destination accounts, tvlAccrual, etc.).
  function makeSeedLikeIx(legCount: number): TransactionInstruction {
    const sharedTokenProgram = Keypair.generate().publicKey;
    const baseAccounts = Array.from({ length: 10 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
    const legAccounts = Array.from({ length: legCount }, () => [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // reserveAsset
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // vault
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, // managerAssetAta
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // mint
      { pubkey: sharedTokenProgram, isSigner: false, isWritable: false }, // TOKEN_PROGRAM_ID (shared across legs)
    ]).flat();
    return new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [...baseAccounts, ...legAccounts, { pubkey: feePayer, isSigner: true, isWritable: true }],
      data: Buffer.alloc(40), // discriminator + a handful of numeric args
    });
  }

  it("a small (1-3 asset) seed instruction fits comfortably in one legacy transaction -- the fast, no-ALT-needed path", () => {
    expect(estimateSingleSignerTxBytes(feePayer, [makeSeedLikeIx(3)])).to.be.lessThan(1232);
  });

  it("reproduces the real reported failure shape: a 6-asset seed instruction genuinely exceeds Solana's 1232-byte legacy transaction limit", () => {
    expect(estimateSingleSignerTxBytes(feePayer, [makeSeedLikeIx(6)])).to.be.greaterThan(1232);
  });

  it("size grows monotonically with leg count -- more assets never accidentally produces a smaller transaction", () => {
    const sizes = [1, 2, 4, 6, 8].map((n) => estimateSingleSignerTxBytes(feePayer, [makeSeedLikeIx(n)]));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).to.be.greaterThan(sizes[i - 1]);
  });
});
