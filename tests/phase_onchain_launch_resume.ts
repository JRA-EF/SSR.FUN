// DEC-0296: finishing an unfinished Reserve launch from Manage Reserve, from
// on-chain data alone, and cancelling (hiding) one. Pure logic only:
//   npx ts-mocha -p ./tests/tsconfig.json tests/phase_onchain_launch_resume.ts
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createPrivateKey, sign } from "node:crypto";
import { RESERVE_ASSET_RESERVE_OFFSET, RESERVE_MANAGER_OFFSET, TOKEN_2022_PROGRAM_ID, isUnfinishedReserveStatus, toUnfinishedLaunch, type UnfinishedLaunch } from "../packages/sdk/src";
import { LAUNCH_PRICE_LOCK_MS, MAX_ASSETS_PER_NEW_RESERVE, type PendingReserveDeploy } from "../src/merge/lib/createReserveClient";
import { assessUnfinishedLaunch, buildPendingDeployFromLaunch, describeVerdict, fallbackReserveName, seedAmountProblem, splitCancelledLaunches } from "../src/merge/lib/onChainLaunchResume";
import { LAUNCH_CANCEL_MAX_AGE_MS, checkLaunchCancelOnChain, checkLaunchCancelShape, launchCancelMessage } from "../lib/launch-cancel/rules";
import { verifyWalletSignature } from "../api/mainnet/campaign-entry";
import * as fs from "fs";
import * as path from "path";

const CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const RESERVE = Keypair.generate().publicKey.toBase58();
const MINT_A = Keypair.generate().publicKey.toBase58();
const MINT_B = Keypair.generate().publicKey.toBase58();
const MINT_C = Keypair.generate().publicKey.toBase58();

const pk = (s: string) => ({ toBase58: () => s });
const bn = (n: number | string) => ({ toString: () => String(n) });

function decodedReserve(over: Partial<{ manager: string; status: object; assetCount: number }> = {}) {
  return {
    reserveId: bn(43),
    manager: pk(over.manager ?? WALLET),
    status: over.status ?? { assetsInitializing: {} },
    assetCount: over.assetCount ?? 3,
    totalTargetWeightBps: 10_000,
    createdAt: bn(1_760_500_000),
    metadataUri: "https://ssr.fun/api/mainnet/reserve-metadata?id=abc",
    feeConfig: { mintFeeBps: 50 },
  };
}
const decodedAssets = [
  { assetMint: pk(MINT_B), decimals: 9, targetWeightBps: 3000, tokenProgram: { splToken: {} }, orderIndex: 1 },
  { assetMint: pk(MINT_A), decimals: 6, targetWeightBps: 5000, tokenProgram: { splToken: {} }, orderIndex: 0 },
  { assetMint: pk(MINT_C), decimals: 8, targetWeightBps: 2000, tokenProgram: { token2022: {} }, orderIndex: 2 },
];

function launch(over: Partial<UnfinishedLaunch> = {}): UnfinishedLaunch {
  return { ...toUnfinishedLaunch(WALLET, RESERVE, decodedReserve(), decodedAssets)!, ...over };
}

function signAs(kp: Keypair, message: string): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]);
  return sign(null, Buffer.from(message), createPrivateKey({ key: der, format: "der", type: "pkcs8" })).toString("base64");
}

describe("DEC-0296: on-chain launch resume -- discovery", () => {
  it("memcmp offsets match the Reserve / ReserveAsset layouts in state/*.rs", () => {
    // discriminator 8 + schema_version u8 + reserve_id u64
    expect(RESERVE_MANAGER_OFFSET).to.equal(17);
    expect(RESERVE_ASSET_RESERVE_OFFSET).to.equal(8);
    const rs = fs.readFileSync(path.resolve(__dirname, "../programs/ssr_protocol/src/state/reserve.rs"), "utf8");
    const struct = rs.slice(rs.indexOf("pub struct Reserve {"));
    expect(struct.indexOf("pub schema_version: u8")).to.be.lessThan(struct.indexOf("pub reserve_id: u64"));
    expect(struct.indexOf("pub reserve_id: u64")).to.be.lessThan(struct.indexOf("pub manager: Pubkey"));
    const between = struct.slice(0, struct.indexOf("pub manager: Pubkey")).match(/pub \w+:/g) ?? [];
    expect(between).to.deep.equal(["pub schema_version:", "pub reserve_id:"]);
    const ra = fs.readFileSync(path.resolve(__dirname, "../programs/ssr_protocol/src/state/reserve_asset.rs"), "utf8");
    expect(ra.slice(ra.indexOf("pub struct ReserveAsset {")).match(/pub \w+:/)![0]).to.equal("pub reserve:");
  });

  it("only created/assetsInitializing count as unfinished", () => {
    expect(isUnfinishedReserveStatus("created")).to.equal(true);
    expect(isUnfinishedReserveStatus("assetsInitializing")).to.equal(true);
    for (const s of ["active", "paused", "windDown", "closed", "", null, undefined]) expect(isUnfinishedReserveStatus(s as string)).to.equal(false);
  });

  it("maps a decoded Reserve to an UnfinishedLaunch, assets in registration order with their token program", () => {
    const l = toUnfinishedLaunch(WALLET, RESERVE, decodedReserve(), decodedAssets)!;
    expect(l.reserveId).to.equal("43");
    expect(l.status).to.equal("assetsInitializing");
    expect(l.createdAt).to.equal(1_760_500_000);
    expect(l.mintFeeBps).to.equal(50);
    expect(l.assets.map((a) => a.mint)).to.deep.equal([MINT_A, MINT_B, MINT_C]);
    expect(l.assets[0].tokenProgram).to.equal(CLASSIC);
    expect(l.assets[2].tokenProgram).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("drops a Reserve of another manager, and one that is already live", () => {
    expect(toUnfinishedLaunch(WALLET, RESERVE, decodedReserve({ manager: OTHER }), decodedAssets)).to.equal(null);
    expect(toUnfinishedLaunch(WALLET, RESERVE, decodedReserve({ status: { active: {} } }), decodedAssets)).to.equal(null);
    expect(toUnfinishedLaunch(WALLET, RESERVE, decodedReserve({ status: { paused: {} } }), decodedAssets)).to.equal(null);
    expect(toUnfinishedLaunch(WALLET, RESERVE, decodedReserve({ status: { created: {} }, assetCount: 0 }), [])!.status).to.equal("created");
  });
});

describe("DEC-0296: on-chain launch resume -- guards", () => {
  it("a fully registered, unseeded Reserve is ready to finish", () => {
    expect(assessUnfinishedLaunch(launch())).to.deep.equal({ kind: "ready" });
    expect(describeVerdict({ kind: "ready" })).to.equal(null);
  });

  it("refuses more assets than the app can seed (#69 has 12)", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, weightBps: 833, tokenProgram: CLASSIC, orderIndex: i }));
    const v = assessUnfinishedLaunch({ status: "assetsInitializing", assetCount: 12, assets: twelve });
    expect(v).to.deep.equal({ kind: "too-many-assets", assetCount: 12, max: MAX_ASSETS_PER_NEW_RESERVE });
    expect(describeVerdict(v)).to.match(/12 reserve assets, more than the 10/);
    expect(assessUnfinishedLaunch({ status: "assetsInitializing", assetCount: 10, assets: twelve.slice(0, 10) }).kind).to.equal("ready");
  });

  it("never guesses: missing asset reads, no registered assets, already live, or more found than registered", () => {
    expect(assessUnfinishedLaunch({ status: "assetsInitializing", assetCount: 3, assets: launch().assets.slice(0, 2) })).to.deep.equal({ kind: "assets-unreadable", found: 2, expected: 3 });
    expect(assessUnfinishedLaunch({ status: "created", assetCount: 0, assets: [] }).kind).to.equal("no-assets");
    expect(assessUnfinishedLaunch({ status: "active", assetCount: 3, assets: launch().assets }).kind).to.equal("already-complete");
    expect(assessUnfinishedLaunch({ status: "assetsInitializing", assetCount: 2, assets: launch().assets }).kind).to.equal("asset-count-mismatch");
    for (const v of [assessUnfinishedLaunch({ status: "created", assetCount: 0, assets: [] }), assessUnfinishedLaunch({ status: "assetsInitializing", assetCount: 2, assets: launch().assets })]) {
      expect(describeVerdict(v)).to.be.a("string").and.not.match(/update_|initialize_|seed_reserve/);
    }
  });

  it("seed amount: same $1 floor as the Launch page, plus the routable-share minimum when known", () => {
    expect(seedAmountProblem("")).to.match(/Enter/);
    expect(seedAmountProblem("0")).to.match(/Enter/);
    expect(seedAmountProblem("0.5")).to.match(/at least \$1/);
    expect(seedAmountProblem("10")).to.equal(null);
    expect(seedAmountProblem("10", 12.5)).to.match(/at least \$12\.50/);
  });

  it("falls back to 'Reserve #N' without metadata", () => {
    expect(fallbackReserveName("45")).to.equal("Reserve #45");
  });
});

describe("DEC-0296: on-chain launch resume -- the pending record", () => {
  const now = 1_763_900_000_000;

  it("rebuilds the Launch page's PendingReserveDeploy from chain data + the chosen seed", () => {
    const p = buildPendingDeployFromLaunch(launch(), { name: "Gold Basket", ticker: "gold", seedTotalUsd: 25, now });
    expect(p.wallet).to.equal(WALLET);
    expect(p.reserve).to.equal(RESERVE);
    expect(p.reserveId).to.equal("43");
    expect(p.ticker).to.equal("GOLD");
    expect(p.startedAt).to.equal(now);
    expect(p.seedTotalUsd).to.equal(25);
    expect(p.assets.map((a) => a.mint)).to.deep.equal([MINT_A, MINT_B, MINT_C]);
    expect(p.assets.map((a) => a.weightBps)).to.deep.equal([5000, 3000, 2000]);
    expect(p.assets.map((a) => a.seedWeightFraction)).to.deep.equal([0.5, 0.3, 0.2]);
    expect(p.assets.map((a) => a.decimals)).to.deep.equal([6, 9, 8]);
    // Classic assets carry no tokenProgram (same as records the Launch page writes); Token-2022 does.
    expect(p.assets[0].tokenProgram).to.equal(undefined);
    expect(p.assets[2].tokenProgram).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(p.assetFunding).to.equal(undefined);
  });

  it("normalises seed shares over what is registered (a 99.96% basket still splits the whole seed)", () => {
    const l = launch({ assets: [{ mint: MINT_A, decimals: 6, weightBps: 4998, tokenProgram: CLASSIC, orderIndex: 0 }, { mint: MINT_B, decimals: 6, weightBps: 4998, tokenProgram: CLASSIC, orderIndex: 1 }] });
    const p = buildPendingDeployFromLaunch(l, { name: "x", ticker: "x", seedTotalUsd: 10, now });
    expect(p.assets.reduce((s, a) => s + a.seedWeightFraction, 0)).to.be.closeTo(1, 1e-12);
  });

  it("keeps this browser's funding progress and, inside the price lock with the same seed, its start time", () => {
    const existing: PendingReserveDeploy = {
      ...buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 25, now: now - 60_000 }),
      assetFunding: { [MINT_B]: { mint: MINT_B, status: "ready_to_seed", verifiedBalanceRaw: "123" } as never },
    };
    const same = buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 25, now, existing });
    expect(same.startedAt).to.equal(now - 60_000);
    expect(same.assetFunding).to.deep.equal(existing.assetFunding);
    const newSeed = buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 30, now, existing });
    expect(newSeed.startedAt).to.equal(now);
    expect(newSeed.assetFunding).to.deep.equal(existing.assetFunding);
    const expired = buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 25, now: now - 60_000 + LAUNCH_PRICE_LOCK_MS + 1, existing });
    expect(expired.startedAt).to.not.equal(existing.startedAt);
  });

  it("ignores a local record for a different Reserve or wallet", () => {
    const other: PendingReserveDeploy = { ...buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 25, now: now - 1000 }), reserve: Keypair.generate().publicKey.toBase58(), assetFunding: {} };
    const p = buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 25, now, existing: other });
    expect(p.startedAt).to.equal(now);
    expect(p.assetFunding).to.equal(undefined);
    const otherWallet = { ...other, reserve: RESERVE, wallet: OTHER };
    expect(buildPendingDeployFromLaunch(launch(), { name: "x", ticker: "x", seedTotalUsd: 25, now, existing: otherWallet }).assetFunding).to.equal(undefined);
  });
});

describe("DEC-0296: cancel (hide) an unfinished launch", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const issuedAt = new Date(now).toISOString();

  it("the signed text names the action, the Reserve, the wallet and the time", () => {
    const m = launchCancelMessage({ action: "cancel", reserve: RESERVE, wallet, issuedAt });
    expect(m).to.contain(RESERVE).and.contain(wallet).and.contain(issuedAt).and.contain("Nothing changes on-chain");
    expect(launchCancelMessage({ action: "undo", reserve: RESERVE, wallet, issuedAt })).to.not.equal(m);
  });

  it("verifies the manager's ed25519 signature over that exact text only", () => {
    const m = launchCancelMessage({ action: "cancel", reserve: RESERVE, wallet, issuedAt });
    const sig = signAs(kp, m);
    expect(verifyWalletSignature(wallet, m, sig)).to.equal(true);
    expect(verifyWalletSignature(wallet, launchCancelMessage({ action: "undo", reserve: RESERVE, wallet, issuedAt }), sig)).to.equal(false);
    expect(verifyWalletSignature(Keypair.generate().publicKey.toBase58(), m, sig)).to.equal(false);
  });

  it("rejects a bad shape or a stale/future signature", () => {
    const ok = { action: "cancel", reserve: RESERVE, wallet, issuedAt, signature: "AAAA" };
    expect(checkLaunchCancelShape(ok, now).ok).to.equal(true);
    expect(checkLaunchCancelShape({ ...ok, action: "delete" }, now)).to.include({ ok: false, status: 400 });
    expect(checkLaunchCancelShape({ ...ok, reserve: "nope" }, now)).to.include({ ok: false, status: 400 });
    expect(checkLaunchCancelShape({ ...ok, signature: "" }, now)).to.include({ ok: false, status: 400 });
    expect(checkLaunchCancelShape({ ...ok, issuedAt: new Date(now - LAUNCH_CANCEL_MAX_AGE_MS - 1).toISOString() }, now)).to.include({ ok: false, status: 400 });
    expect(checkLaunchCancelShape({ ...ok, issuedAt: new Date(now + LAUNCH_CANCEL_MAX_AGE_MS + 1).toISOString() }, now)).to.include({ ok: false, status: 400 });
  });

  it("only the on-chain manager may cancel, and only while the launch is unfinished; undo needs only the manager", () => {
    expect(checkLaunchCancelOnChain("cancel", wallet, { manager: wallet, status: "assetsInitializing" })).to.deep.equal({ ok: true });
    expect(checkLaunchCancelOnChain("cancel", wallet, { manager: wallet, status: "created" })).to.deep.equal({ ok: true });
    expect(checkLaunchCancelOnChain("cancel", wallet, { manager: OTHER, status: "assetsInitializing" })).to.include({ ok: false, status: 403 });
    expect(checkLaunchCancelOnChain("cancel", wallet, { manager: wallet, status: "active" })).to.include({ ok: false, status: 409 });
    expect(checkLaunchCancelOnChain("cancel", wallet, null)).to.include({ ok: false, status: 404 });
    expect(checkLaunchCancelOnChain("undo", wallet, { manager: wallet, status: "active" })).to.deep.equal({ ok: true });
    expect(checkLaunchCancelOnChain("undo", wallet, { manager: OTHER, status: "assetsInitializing" })).to.include({ ok: false, status: 403 });
  });

  it("hides cancelled launches and shows them again after undo", () => {
    const a = launch();
    const b = launch({ reserve: new PublicKey(Keypair.generate().publicKey).toBase58(), reserveId: "44" });
    const c = launch({ reserve: Keypair.generate().publicKey.toBase58(), reserveId: "45" });
    const hidden = splitCancelledLaunches([a, b, c], [b.reserve]);
    expect(hidden.visible.map((l) => l.reserveId)).to.deep.equal(["43", "45"]);
    expect(hidden.cancelled.map((l) => l.reserveId)).to.deep.equal(["44"]);
    const undone = splitCancelledLaunches([a, b, c], []);
    expect(undone.visible).to.have.length(3);
    expect(undone.cancelled).to.have.length(0);
    // A cancellation row for a Reserve that is no longer unfinished hides nothing.
    expect(splitCancelledLaunches([a], [Keypair.generate().publicKey.toBase58()]).visible).to.have.length(1);
  });
});
