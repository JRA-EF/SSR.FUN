// DEC-0261: ops alerts -- what is reported, how repeats group, what a
// Telegram message shows (never a full wallet), and where the app, keeper and
// Helius webhook are wired in.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import {
  fingerprint, formatAlert, isTransientRpcError, isUserCancel, normalizeMessage, parseClientReport, parseHeliusFailures, KEEPER_LOW_SOL, type AlertEvent,
} from "../lib/ops-alerts/alertsPure";

const W = "CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8";
const R = "HNkMLZJW27HTf3uc67Ak7GwzDQB7pETu8QU3GhWgpyLP";

describe("DEC-0261 ops alerts: rules", () => {
  it("wallet cancellations are never alerts", () => {
    for (const m of ["User rejected the request.", "Transaction cancelled", "Approval denied by user"]) expect(isUserCancel(m), m).to.equal(true);
    expect(isUserCancel("Simulation failed: custom program error: 0x1")).to.equal(false);
  });
  it("one-off RPC hiccups are not alerted; program errors are (DEC-0262)", () => {
    for (const m of ["failed to get block time for slot 461745941: Block not available for slot 461745941", "429 Too Many Requests", "TypeError: fetch failed", "Blockhash not found"]) expect(isTransientRpcError(m), m).to.equal(true);
    for (const m of ["custom program error: 0x7d6", "Error Number: 6429. Error Message: x", "distribute_fee_usdc: simulation failed"]) expect(isTransientRpcError(m), m).to.equal(false);
  });
  it("the same failure with different amounts, addresses or signatures groups as one", () => {
    const a: AlertEvent = { source: "app", step: "mint", message: `Swap of 12.5 USDC for ${W} failed at slot 461726335` };
    const b: AlertEvent = { source: "app", step: "mint", message: `Swap of 3 USDC for ${R} failed at slot 461726999` };
    expect(fingerprint(a)).to.equal(fingerprint(b));
    expect(fingerprint(a)).to.not.equal(fingerprint({ ...a, step: "redeem" }));
    expect(normalizeMessage("custom program error: 0x1771")).to.equal("custom program error: 0x1771");
    expect(fingerprint({ source: "chain", step: "on-chain", message: "custom program error: 0x1771" }))
      .to.not.equal(fingerprint({ source: "chain", step: "on-chain", message: "custom program error: 0x1772" }));
  });
  it("messages show wallets and signatures by their last characters only, escaped, with a Solscan link", () => {
    const html = formatAlert({ source: "app", step: "mint", message: "Bad <thing> & more", reserve: R, ticker: "ALPHA", wallet: W, signature: "5kiZGGGUUNFpu2iUZDJneeJZB7MZZ7uqzT5XxT1RkACpYr3Ng8DygyjpEGiWyFb5XoiirPa8CwS2jqiRCFzrcowp" }, { site: "ssr.fun", repeats: 3 });
    expect(html).to.include("Mint failed").and.include("×3").and.include("ssr.fun").and.include("ALPHA …WgpyLP").and.include("…Hg4Rw8");
    expect(html).to.include("Bad &lt;thing&gt; &amp; more").and.include("https://solscan.io/tx/5kiZ");
    expect(html).to.not.include(W);
    // DEC-0263: browser reports are labelled and their free-text fields cannot become links.
    expect(html).to.include("Unverified report from a browser").and.include("<code>ALPHA …WgpyLP</code>");
    expect(formatAlert({ source: "chain", step: "on-chain", message: "x" }, { site: "s", repeats: 1 })).to.not.include("Unverified");
  });
  it("client reports accept only known steps and real addresses", () => {
    expect(parseClientReport({ step: "drop-table", message: "x" }).ok).to.equal(false);
    expect(parseClientReport({ step: "mint" }).ok).to.equal(false);
    const r = parseClientReport({ step: "redeem", message: "boom", wallet: "not-a-key", reserve: R, ticker: "ALPHA" });
    expect(r.ok).to.equal(true);
    if (r.ok) expect([r.value.wallet, r.value.reserve, r.value.source]).to.deep.equal([null, R, "app"]);
  });
  it("Helius raw payloads yield one event per failed transaction with the instruction and Anchor error", () => {
    const events = parseHeliusFailures([
      { meta: { err: null, logMessages: [] }, transaction: { signatures: ["ok"], message: { accountKeys: [W] } } },
      { meta: { err: { InstructionError: [2, { Custom: 6073 }] }, logMessages: ["Program log: Instruction: RedeemReserveTokensInKind", "Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6073. Error Message: Slippage exceeded."] }, transaction: { signatures: ["sig1"], message: { accountKeys: [W] } } },
    ]);
    expect(events).to.have.length(1);
    expect(events[0]).to.include({ source: "chain", step: "on-chain", wallet: W, signature: "sig1" });
    expect(events[0].message).to.match(/^RedeemReserveTokensInKind: AnchorError .*SlippageExceeded/);
    expect(parseHeliusFailures({ not: "an array" })).to.deep.equal([]);
  });
});

describe("DEC-0261 ops alerts: wiring", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("the app reports Mainnet mint, redeem, create, launch/liquidity, rebalance and manage failures", () => {
    expect(src("src/merge/pages/DTRDetail.tsx").match(/reportFailure\("(mint|redeem)"/g)).to.have.length(3);
    expect(src("src/merge/pages/CreateDTR.tsx")).to.match(/if \(IS_MAINNET\) reportFailure\("create"/).and.match(/reportFailure\("create-resume"/);
    expect(src("src/merge/components/LiquidityTransactionReview.tsx")).to.match(/reportFailure\(plan\.action==='create'\?'launch':'liquidity'/);
    expect(src("src/merge/components/LiveLiquiditySection.tsx")).to.match(/reportFailure\(action==='create'\?'launch':'liquidity'/);
    expect(src("src/merge/pages/ManageDTR.tsx").match(/if \(IS_MAINNET\) reportFailure\("(manage|rebalance)"/g)).to.have.length(4);
    expect(src("src/merge/lib/opsAlert.ts")).to.match(/if \(isWalletRejectionError\(error\)\) return;/);
  });
  it("the keeper alerts on job failures, a missing keeper role and low SOL", () => {
    const cron = src("api/mainnet/fee-settlement-cron.ts");
    expect(cron).to.match(/step: "keeper-config"/).and.match(/step: "keeper-balance"/)
      .and.match(/for \(const f of failures\) if \(!isTransientRpcError\(f\.message\)\) await recordAlert\(\{ source: "keeper", \.\.\.f \}, \{ quietMinutes: 360 \}\)/);
    // A FeeSettlement account not linked to its Reserve is skipped, not retried (and alerted) every hour.
    expect(cron).to.match(/feeSettlementInfo\.data\.subarray\(9, 41\)\.equals\(reservePk\.toBuffer\(\)\)/);
    expect(KEEPER_LOW_SOL).to.equal(0.05);
  });
  it("the Helius webhook passes the site gate and checks its own secret", () => {
    expect(src("middleware.ts")).to.include("'/api/mainnet/alert-helius'");
    expect(src("api/mainnet/alert-helius.ts")).to.match(/HELIUS_ALERT_WEBHOOK_SECRET/);
    expect(src("api/mainnet/alert-report.ts")).to.match(/checkDurableRateWindow/).and.match(/"ops-alert:global"/);
    expect(src("api/mainnet/alert-helius.ts")).to.match(/timingSafeEqual/).and.not.match(/!== secret/);
  });
  it("no alert credential is committed", () => {
    for (const f of ["lib/ops-alerts/alerts.ts", "api/mainnet/alert-helius.ts", "api/mainnet/alert-report.ts"]) expect(src(f)).to.not.match(/\d{9,}:AA[\w-]{30,}/);
  });
});
