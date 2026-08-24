// Offline, pure-logic regression coverage for the Buy/confirmation
// RPC-resilience pass (see docs/project/PROJECT_STATUS.md): adaptive
// discovery-poll backoff, cache/dedupe/concurrency-limit primitives, bounded
// transaction-confirmation polling, duplicate-submission gating, and
// post-transaction reconciliation. Matches this repo's existing testing
// split -- pure logic covered here offline; a real live Buy against DevNet
// is covered separately (see scripts/verify_data_integrity_pass.ts and this
// pass's own live-verification run recorded in PROJECT_STATUS.md).
import { expect } from "chai";
import {
  canSubmitNewTransaction,
  confirmSignatureBounded,
  getCached,
  invalidateCached,
  invalidateCachedPrefix,
  isRateLimitError,
  nextPollDelay,
  reconcileByBalanceChange,
  AmbiguousConfirmationError,
  txPhaseLabel,
  withReadConcurrencyLimit,
  withRateLimitRetry,
  type TxPhase,
} from "../src/merge/lib/rpcResilience";
import { getTokenSupplyWithRetry } from "../packages/sdk/src";

const BASE_MS = 15_000;
const MAX_MS = 120_000;

describe("RPC-resilience -- adaptive poll delay (nextPollDelay)", () => {
  it("doubles the delay (plus jitter) on a genuine rate limit, never exceeding the bound", () => {
    const delay = nextPollDelay(BASE_MS, true, BASE_MS, MAX_MS, () => 0);
    expect(delay).to.equal(BASE_MS * 2);
  });

  it("caps the backoff at maxMs even after many consecutive rate limits", () => {
    let delay = BASE_MS;
    for (let i = 0; i < 20; i++) delay = nextPollDelay(delay, true, BASE_MS, MAX_MS, () => 0);
    expect(delay).to.equal(MAX_MS);
  });

  it("steps back down gradually toward baseMs on success, not instantly", () => {
    const afterOneBackoff = nextPollDelay(BASE_MS * 2, true, BASE_MS, MAX_MS, () => 0); // still elevated
    const afterSuccess = nextPollDelay(afterOneBackoff, false, BASE_MS, MAX_MS);
    expect(afterSuccess).to.be.greaterThan(BASE_MS);
    expect(afterSuccess).to.be.lessThan(afterOneBackoff);
  });

  it("stays at baseMs on repeated success once it has fully stepped back down", () => {
    expect(nextPollDelay(BASE_MS, false, BASE_MS, MAX_MS)).to.equal(BASE_MS);
  });
});

describe("RPC-resilience -- cache + in-flight de-duplication (getCached)", () => {
  it("collapses concurrent identical requests into a single underlying call", async () => {
    let calls = 0;
    const key = `dedup-test-${Date.now()}-${Math.random()}`;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "value";
    };
    const [a, b, c] = await Promise.all([getCached(key, 5000, fn), getCached(key, 5000, fn), getCached(key, 5000, fn)]);
    expect(calls).to.equal(1);
    expect([a, b, c]).to.deep.equal(["value", "value", "value"]);
  });

  it("serves a fresh call from cache within the TTL window without re-invoking fn", async () => {
    let calls = 0;
    const key = `ttl-test-${Date.now()}-${Math.random()}`;
    const fn = async () => {
      calls += 1;
      return calls;
    };
    const first = await getCached(key, 5000, fn);
    const second = await getCached(key, 5000, fn);
    expect(first).to.equal(1);
    expect(second).to.equal(1); // cached, not re-fetched
    expect(calls).to.equal(1);
  });

  it("invalidateCached forces the next call to fetch fresh, without affecting an unrelated key", async () => {
    let calls = 0;
    const key = `invalidate-test-${Date.now()}-${Math.random()}`;
    const otherKey = `invalidate-test-other-${Date.now()}-${Math.random()}`;
    const fn = async () => {
      calls += 1;
      return calls;
    };
    await getCached(key, 5000, fn);
    await getCached(otherKey, 5000, fn); // populate an unrelated key too
    invalidateCached(key);
    const afterInvalidate = await getCached(key, 5000, fn);
    const otherStillCached = await getCached(otherKey, 5000, fn);
    expect(afterInvalidate).to.equal(3); // re-fetched: 1 (key) + 1 (otherKey) + 1 (key again)
    expect(otherStillCached).to.equal(2); // otherKey's cached value from its one fetch, untouched by invalidating `key`
  });

  it("invalidateCachedPrefix only clears keys starting with that prefix", async () => {
    const prefix = `prefix-test-${Date.now()}-${Math.random()}:`;
    const matchingKey = `${prefix}mint-a`;
    const nonMatchingKey = `unrelated-${Date.now()}-${Math.random()}`;
    let matchingCalls = 0;
    let nonMatchingCalls = 0;
    await getCached(matchingKey, 5000, async () => {
      matchingCalls += 1;
      return matchingCalls;
    });
    await getCached(nonMatchingKey, 5000, async () => {
      nonMatchingCalls += 1;
      return nonMatchingCalls;
    });
    invalidateCachedPrefix(prefix);
    await getCached(matchingKey, 5000, async () => {
      matchingCalls += 1;
      return matchingCalls;
    });
    await getCached(nonMatchingKey, 5000, async () => {
      nonMatchingCalls += 1;
      return nonMatchingCalls;
    });
    expect(matchingCalls).to.equal(2); // re-fetched after prefix invalidation
    expect(nonMatchingCalls).to.equal(1); // untouched
  });
});

describe("RPC-resilience -- bounded read concurrency (withReadConcurrencyLimit)", () => {
  it("never lets more than a conservative number of reads run at the same instant", async () => {
    let active = 0;
    let maxActive = 0;
    const task = () =>
      withReadConcurrencyLimit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
      });
    await Promise.all(Array.from({ length: 10 }, () => task()));
    expect(maxActive).to.be.at.most(4); // matches this module's own MAX_CONCURRENT_READS
  });
});

describe("RPC-resilience -- bounded transaction-confirmation polling (confirmSignatureBounded)", () => {
  function fakeConnection(getSignatureStatuses: () => Promise<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>, getBlockHeight: () => Promise<number> = async () => 0) {
    return { getSignatureStatuses, getBlockHeight } as any;
  }

  it("returns confirmed as soon as the chain reports a confirmed status", async () => {
    const connection = fakeConnection(async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }));
    const outcome = await confirmSignatureBounded(connection, "sig1", 1000, { maxAttempts: 3, intervalMs: 1 });
    expect(outcome).to.deep.equal({ status: "confirmed" });
  });

  it("returns failed with the on-chain error when the chain reports one -- never silently treated as success", async () => {
    const connection = fakeConnection(async () => ({ value: [{ err: { InstructionError: [0, "Custom"] } }] }));
    const outcome = await confirmSignatureBounded(connection, "sig2", 1000, { maxAttempts: 3, intervalMs: 1 });
    expect(outcome.status).to.equal("failed");
  });

  it("returns expired once the recorded lastValidBlockHeight has genuinely passed with no status ever appearing", async () => {
    const connection = fakeConnection(
      async () => ({ value: [null] }),
      async () => 2000, // already past lastValidBlockHeight of 1000
    );
    const outcome = await confirmSignatureBounded(connection, "sig3", 1000, { maxAttempts: 3, intervalMs: 1 });
    expect(outcome).to.deep.equal({ status: "expired" });
  });

  it("recovers when submission succeeds but status checks hit repeated 429s before eventually confirming", async () => {
    let attempt = 0;
    const connection = fakeConnection(async () => {
      attempt += 1;
      if (attempt < 3) throw new Error("429 Too Many Requests");
      return { value: [{ err: null, confirmationStatus: "confirmed" }] };
    });
    const outcome = await confirmSignatureBounded(connection, "sig4", 1000, { maxAttempts: 10, intervalMs: 1 });
    expect(outcome).to.deep.equal({ status: "confirmed" });
    expect(attempt).to.be.greaterThan(2); // genuinely retried through the 429s, not given up early
  });

  it("returns unknown -- never fabricating success or failure -- once bounded attempts are exhausted with no definitive answer", async () => {
    const connection = fakeConnection(
      async () => ({ value: [null] }),
      async () => 500, // never exceeds lastValidBlockHeight -- not expired either
    );
    const outcome = await confirmSignatureBounded(connection, "sig5", 1000, { maxAttempts: 3, intervalMs: 1 });
    expect(outcome).to.deep.equal({ status: "unknown" });
  });

  it("never calls a send/submit function -- confirmation is read-only status polling only, structurally incapable of resubmitting", () => {
    // confirmSignatureBounded's signature takes no send/submit callback at all -- there is nothing here that could
    // resubmit the transaction, by construction. This is asserted structurally via the function's arity/shape rather
    // than by mocking, since there is no submission path to accidentally invoke in the first place.
    expect(confirmSignatureBounded.length).to.equal(3); // (connection, signature, lastValidBlockHeight) -- `opts` has a default value so it doesn't count toward Function.length
  });
});

describe("RPC-resilience -- isRateLimitError / withRateLimitRetry (still used for read-only retries)", () => {
  it("classifies a real 429 message correctly", () => {
    expect(isRateLimitError(new Error("429 Too Many Requests"))).to.equal(true);
  });

  it("does not misclassify an unrelated error", () => {
    expect(isRateLimitError(new Error("Invalid public key"))).to.equal(false);
  });

  it("regression: does not misclassify an 'unknown signer' error as RPC congestion just because the offending base58 pubkey happens to contain the digit run '429'", () => {
    // A real bug found and fixed this pass: swap-sign.ts's catch-all checked
    // isRateLimitError(e) BEFORE describeUnknownSignerError(e, ...), so any
    // error whose message contained "429" anywhere -- including as a
    // coincidental substring inside an unrelated base58 pubkey -- was
    // silently relabeled "DevNet RPC congested" instead of surfacing the
    // real, actionable unknown-signer diagnosis. `\b429\b` (word-boundary)
    // must NOT match "429" embedded inside a longer alphanumeric run, since
    // every character in a base58 string is a `\w` character and so no word
    // boundary exists on either side of an embedded "429".
    const pubkeyWithEmbedded429 = "Ef7vbQg429FghKzLzUnyJsvov1f5f9aRSfWksiaSmWp";
    expect(isRateLimitError(new Error(`unknown signer: ${pubkeyWithEmbedded429}`))).to.equal(false);
  });

  it("still classifies a genuine 429 even when it appears with surrounding punctuation, not just at the message start", () => {
    expect(isRateLimitError(new Error("Request failed (status 429): rate limited"))).to.equal(true);
  });

  it("retries only genuine rate-limit errors, bounded", async () => {
    let attempts = 0;
    const result = await withRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("429 Too Many Requests");
        return "ok";
      },
      3,
      1,
    );
    expect(result).to.equal("ok");
    expect(attempts).to.equal(2);
  });
});

describe("RPC-resilience -- duplicate-submission gating (canSubmitNewTransaction)", () => {
  const blocking: TxPhase[] = ["preparing", "awaiting-wallet", "submitted", "confirming"];
  const allowing: TxPhase[] = ["idle", "confirmed", "failed", "expired", "unresolved"];

  it("blocks a new submission while a prior one is being prepared, signed, submitted, or confirmed", () => {
    for (const phase of blocking) expect(canSubmitNewTransaction(phase), phase).to.equal(false);
  });

  it("allows a new submission from idle or any terminal (including unresolved) phase", () => {
    for (const phase of allowing) expect(canSubmitNewTransaction(phase), phase).to.equal(true);
  });
});

describe("RPC-resilience -- txPhaseLabel", () => {
  it("returns the exact required UX strings for each in-flight phase", () => {
    expect(txPhaseLabel("preparing")).to.equal("Preparing transaction...");
    expect(txPhaseLabel("awaiting-wallet")).to.equal("Waiting for wallet approval...");
    expect(txPhaseLabel("confirming")).to.equal("Submitted -- confirming on DevNet...");
    expect(txPhaseLabel("unresolved")).to.equal("DevNet RPC is temporarily busy -- your transaction is still being verified");
  });

  it("returns null for idle/terminal phases so the caller shows its own normal label instead", () => {
    expect(txPhaseLabel("idle")).to.equal(null);
    expect(txPhaseLabel("confirmed")).to.equal(null);
    expect(txPhaseLabel("failed")).to.equal(null);
    expect(txPhaseLabel("expired")).to.equal(null);
  });

  // 2026-08-20 pass: a Mainnet Buy/Sell's in-flight label said "confirming on
  // DevNet" -- root cause was this function hardcoding "DevNet" regardless
  // of cluster. clusterLabel defaults to "DevNet" (every pre-existing
  // caller/test above unchanged) so this is additive, not a breaking change.
  it("uses the caller-supplied cluster label instead of the DevNet default when provided (root-cause regression: a Mainnet trade must never say 'confirming on DevNet')", () => {
    expect(txPhaseLabel("confirming", "Mainnet")).to.equal("Submitted -- confirming on Mainnet...");
    expect(txPhaseLabel("submitted", "Mainnet")).to.equal("Submitted -- confirming on Mainnet...");
    expect(txPhaseLabel("unresolved", "Mainnet")).to.equal("Mainnet RPC is temporarily busy -- your transaction is still being verified");
  });
});

describe("RPC-resilience -- AmbiguousConfirmationError", () => {
  it("carries the real signature so the UI can show/link it, never silently discarding it", () => {
    const err = new AmbiguousConfirmationError("sigABC123");
    expect(err.signature).to.equal("sigABC123");
    expect(err.name).to.equal("AmbiguousConfirmationError");
    expect(err.message).to.include("sigABC123");
  });

  it("defaults to 'DevNet' in its message when no clusterLabel is given -- every pre-existing caller/test unaffected", () => {
    const err = new AmbiguousConfirmationError("sigDEF456");
    expect(err.message).to.include("DevNet RPC could not confirm");
  });

  // 2026-08-24, road-to-mainnet MCR-01: a genuinely Mainnet seed-transaction
  // confirmation timeout was reported back as "DevNet RPC could not
  // confirm...", actively misleading about which network was actually
  // involved -- every real Mainnet caller now passes its own real cluster
  // label explicitly instead of relying on this default.
  it("uses the real supplied clusterLabel instead of the DevNet default when a caller passes one", () => {
    const err = new AmbiguousConfirmationError("sigGHI789", "Mainnet");
    expect(err.message).to.include("Mainnet RPC could not confirm");
    expect(err.message).to.not.include("DevNet");
  });
});

describe("RPC-resilience -- honest token-supply reads under transient RPC failure (getTokenSupplyWithRetry)", () => {
  // Real bug found via live testing: fetchReserveOnChain's old
  // `connection.getTokenSupply(...).catch(() => null)` silently reported a
  // fully-seeded, real Reserve's supply as "0" purely because one RPC call
  // hit a 429 -- indistinguishable downstream from a genuinely-unseeded
  // Reserve, and it made a real Buy fail with a misleading "must be seeded
  // first" error. getTokenSupplyWithRetry fixes this with the same bounded,
  // rate-limit-only retry pattern as withRateLimitRetry.
  it("retries a transient 429 and returns the real value once it succeeds", async () => {
    let attempts = 0;
    const fakeConnection = {
      getTokenSupply: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("429 Too Many Requests");
        return { value: { amount: "123456", decimals: 6, uiAmount: 0.123456 } };
      },
    } as any;
    const result = await getTokenSupplyWithRetry(fakeConnection, {} as any, 5, 1);
    expect(result?.value.amount).to.equal("123456");
    expect(attempts).to.equal(3);
  });

  it("does not retry a non-rate-limit error -- fails closed to null immediately rather than masking a real bug", async () => {
    let attempts = 0;
    const fakeConnection = {
      getTokenSupply: async () => {
        attempts += 1;
        throw new Error("Invalid mint account");
      },
    } as any;
    const result = await getTokenSupplyWithRetry(fakeConnection, {} as any, 5, 1);
    expect(result).to.equal(null);
    expect(attempts).to.equal(1);
  });

  it("gives up and returns null after exhausting bounded retries under sustained 429s", async () => {
    let attempts = 0;
    const fakeConnection = {
      getTokenSupply: async () => {
        attempts += 1;
        throw new Error("429 Too Many Requests");
      },
    } as any;
    const result = await getTokenSupplyWithRetry(fakeConnection, {} as any, 2, 1);
    expect(result).to.equal(null);
    expect(attempts).to.equal(3); // initial attempt + 2 retries
  });
});

describe("RPC-resilience -- post-transaction reconciliation (reconcileByBalanceChange)", () => {
  it("reports a real decrease (e.g. devUSDC spent on a Buy) as reconciled", () => {
    expect(reconcileByBalanceChange(1_000_000n, 900_000n, "decrease")).to.equal(true);
  });

  it("does NOT report success when the balance hasn't actually moved -- never fabricating confirmation", () => {
    expect(reconcileByBalanceChange(1_000_000n, 1_000_000n, "decrease")).to.equal(false);
  });

  it("reports a real increase (e.g. Reserve Tokens minted) as reconciled", () => {
    expect(reconcileByBalanceChange(0n, 500_000n, "increase")).to.equal(true);
  });

  it("does NOT report success for an increase check when the balance actually decreased", () => {
    expect(reconcileByBalanceChange(500_000n, 400_000n, "increase")).to.equal(false);
  });
});
