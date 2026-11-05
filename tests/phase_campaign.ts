// Beta Campaign rules (DEC-0279): lib/campaign/rules.ts is pure, and
// api/mainnet/campaign-entry.ts's signature check is plain Node crypto.
//   npx ts-mocha -p ./tests/tsconfig.json tests/phase_campaign.ts
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { createPrivateKey, sign } from "node:crypto";
import { campaignConfig, campaignPhase, entryMessage, isEligibleReserve, normalizeHandle, pnlPct, rank, signupMessage, traderVolume, volumeByReserve } from "../lib/campaign/rules";
import { verifyWalletSignature } from "../api/mainnet/campaign-entry";

function signAs(kp: Keypair, message: string): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]);
  return sign(null, Buffer.from(message), createPrivateKey({ key: der, format: "der", type: "pkcs8" })).toString("base64");
}

describe("Beta Campaign (DEC-0279)", () => {
  it("reads the window and always excludes the protocol wallet", () => {
    const cfg = campaignConfig({ SSR_CAMPAIGN_START: "2026-11-05T00:00:00Z", SSR_CAMPAIGN_END: "2026-11-19T23:59:59Z", SSR_CAMPAIGN_EXCLUDE_WALLETS: "AAA, BBB" });
    expect(cfg.startTs).to.equal(Date.parse("2026-11-05T00:00:00Z") / 1000);
    expect(cfg.excludedWallets.has("CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8")).to.equal(true);
    expect(cfg.excludedWallets.has("BBB")).to.equal(true);
    expect(campaignPhase(cfg, cfg.startTs! - 1)).to.equal("upcoming");
    expect(campaignPhase(cfg, cfg.startTs!)).to.equal("live");
    expect(campaignPhase(cfg, cfg.endTs! + 1)).to.equal("closed");
    expect(campaignPhase(campaignConfig({}), 0)).to.equal("unscheduled");
  });

  it("counts only new Reserves by non-team wallets", () => {
    const cfg = campaignConfig({ SSR_CAMPAIGN_START: "2026-11-05T00:00:00Z", SSR_CAMPAIGN_END: "2026-11-19T00:00:00Z" });
    expect(isEligibleReserve(cfg.startTs!, "SomeCreator", cfg)).to.equal(true);
    expect(isEligibleReserve(cfg.startTs! - 1, "SomeCreator", cfg)).to.equal(false);
    expect(isEligibleReserve(null, "SomeCreator", cfg)).to.equal(false);
    expect(isEligibleReserve(cfg.startTs! + 10, "6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen", cfg)).to.equal(false);
    expect(isEligibleReserve(cfg.startTs! + 10, "CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8", cfg)).to.equal(false);
  });

  it("normalizes X handles", () => {
    expect(normalizeHandle("@SSR_fun")).to.equal("SSR_fun");
    expect(normalizeHandle("https://x.com/foo_bar?s=1")).to.equal("foo_bar");
    expect(normalizeHandle("two words")).to.equal(null);
    expect(normalizeHandle("waytoolonghandle123")).to.equal(null);
  });

  it("counts the creator's own trades in Reserve volume (DEC-0287)", () => {
    const v = volumeByReserve([
      { reserve: "A", actor: "M", usd: 50 },
      { reserve: "A", actor: "X", usd: 20 },
      { reserve: "A", actor: null, usd: 5 },
      { reserve: "B", actor: "X", usd: 99 },
    ], new Map([["A", "M"]]));
    expect([...v]).to.deep.equal([["A", 75]]);
  });

  it("measures PnL from launch to the last NAV at or before close", () => {
    const pts = [{ t: 1, nav: 1 }, { t: 5, nav: 1.2 }, { t: 9, nav: 2 }];
    expect(pnlPct(pts, null)).to.be.closeTo(100, 1e-9);
    expect(pnlPct(pts, 6)).to.be.closeTo(20, 1e-9);
    expect(pnlPct([{ t: 1, nav: 1 }], null)).to.equal(null);
  });

  it("ranks highest first and breaks ties by earlier entry", () => {
    const r = rank([
      { id: "a", value: 5, enteredAt: "2026-11-06" },
      { id: "b", value: 5, enteredAt: "2026-11-05" },
      { id: "c", value: null, enteredAt: "2026-11-01" },
      { id: "d", value: 9, enteredAt: "2026-11-07" },
    ]);
    expect(r.map(x => x.id)).to.deep.equal(["d", "b", "a"]);
  });

  it("accepts only the wallet's own signature over the exact message", () => {
    const kp = Keypair.generate(), other = Keypair.generate();
    const msg = entryMessage({ reserve: "R", wallet: kp.publicKey.toBase58(), handle: "abc", issuedAt: "2026-11-05T00:00:00.000Z" });
    const sig = signAs(kp, msg);
    expect(verifyWalletSignature(kp.publicKey.toBase58(), msg, sig)).to.equal(true);
    expect(verifyWalletSignature(kp.publicKey.toBase58(), msg.replace("@abc", "@xyz"), sig)).to.equal(false);
    expect(verifyWalletSignature(other.publicKey.toBase58(), msg, sig)).to.equal(false);
    expect(verifyWalletSignature(kp.publicKey.toBase58(), msg, "bad")).to.equal(false);
  });

  it("ranks only signed-up traders, counting a creator's trades on their own Reserve (DEC-0287)", () => {
    const rows = [
      { wallet: "M", reserve: "A", usd: 500, trades: 5 }, // creator of A trading A: counts
      { wallet: "M", reserve: "B", usd: 30, trades: 1 },  // creator of A trading B: counts
      { wallet: "T", reserve: "A", usd: 40, trades: 2 },
      { wallet: "U", reserve: "A", usd: 999, trades: 9 }, // not signed up
      { wallet: "CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8", reserve: "A", usd: 999, trades: 1 },
    ];
    const out = traderVolume(rows, campaignConfig({}).excludedWallets, new Set(["M", "T", "CgHFxD4XHZzmSGEomnMXipGo75ejqhVd5aNY4GHg4Rw8"]));
    expect(out).to.deep.equal([{ wallet: "M", usd: 530, trades: 6 }, { wallet: "T", usd: 40, trades: 2 }]);
  });

  it("verifies a trader's signed sign-up", () => {
    const kp = Keypair.generate();
    const msg = signupMessage({ wallet: kp.publicKey.toBase58(), handle: "trader1", issuedAt: "2026-11-05T00:00:00.000Z" });
    expect(verifyWalletSignature(kp.publicKey.toBase58(), msg, signAs(kp, msg))).to.equal(true);
    expect(verifyWalletSignature(kp.publicKey.toBase58(), msg.replace("@trader1", "@other"), signAs(kp, msg))).to.equal(false);
  });
});
