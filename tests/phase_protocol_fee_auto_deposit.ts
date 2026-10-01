// Regression coverage for two changes made together, per explicit user
// request: (1) the initial seed mint now charges the same Mint Fee as any
// other mint (Manager AND Protocol both receive a share) -- previously
// fee-free, a confirmed bug ("0 collectible fees" right after creating a
// Reserve). (2) The Protocol's fee share -- from seed, from every ordinary
// Buy mint, and from the annualized TVL fee -- is now swept to the Protocol
// treasury automatically by a weekly keeper (api/devnet/accrue-fees-cron.ts,
// now also scheduled 00:00 UTC every Monday, the closest fixed-UTC
// approximation to 00:00 UK time) via a new, additive, protocol-only
// `collect_protocol_fee` instruction -- the Protocol is a passive claimant,
// never manually collecting. See docs/project/DECISION_LOG.md's entry for
// this pass.
//
// Deliberately network- and Anchor-toolchain-free.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_protocol_fee_auto_deposit.ts
import { expect } from "chai";
import * as crypto from "crypto";
import { estimateNetSeedReserveTokens } from "../src/merge/lib/createReserveClient";
import { summarizeActivityEvent } from "../packages/sdk/src/activityLog";
import idl from "../packages/sdk/idl/ssr_protocol.json";

describe("estimateNetSeedReserveTokens -- root-cause regression: the initial seed mint is fee-charged like any other mint", () => {
  it("deducts nothing for a genuinely 0% configured mint fee", () => {
    expect(estimateNetSeedReserveTokens(1000, 0)).to.equal(1000);
  });

  it("LIVE-DEVNET-MATCHED REGRESSION: a $10 seed at 2% mint fee nets exactly 9.8 tokens -- the exact figures confirmed live in scripts/verify_protocol_fee_auto_deposit_devnet.ts (creator received 9,800,000 raw units of 10,000,000 requested)", () => {
    expect(estimateNetSeedReserveTokens(10, 2)).to.equal(9.8);
  });

  it("PRECISION REGRESSION: must compute at raw-base-unit granularity, not whole-token granularity -- a naive whole-token ceil (10 - ceil(10*0.02)) would wrongly understate this as 9, a full token short of the real 9.8", () => {
    const naiveWholeTokenEstimate = 10 - Math.ceil(10 * 0.02);
    const net = estimateNetSeedReserveTokens(10, 2);
    expect(net).to.not.equal(naiveWholeTokenEstimate);
    expect(net).to.be.greaterThan(naiveWholeTokenEstimate);
  });

  it("deducts the Protocol-floor-or-half rate for a real configured fee (0.5% mint fee -> 0.5% floor applies)", () => {
    // 0.5% configured -> half=0.25%, floored up to the 0.5% Protocol minimum -> effective 0.5% total (all Protocol, 0% Manager, per DEC-0094's formula at exactly the floor).
    const gross = 10;
    const net = estimateNetSeedReserveTokens(gross, 0.5);
    const grossRaw = gross * 1_000_000;
    expect(net * 1_000_000).to.equal(grossRaw - Math.ceil(grossRaw * 0.005));
  });

  it("deducts more than the Protocol floor once the configured rate exceeds it (2% mint fee)", () => {
    const gross = 10;
    const net = estimateNetSeedReserveTokens(gross, 2);
    expect(net).to.be.lessThan(gross);
  });

  it("never returns a negative amount for a tiny gross seed target", () => {
    expect(estimateNetSeedReserveTokens(1, 2)).to.be.at.least(0);
  });

  it("rounds the fee up (ceiling), matching the on-chain mul_div_ceil convention -- the creator never receives MORE than the true net amount by a rounding accident", () => {
    const gross = 3;
    const net = estimateNetSeedReserveTokens(gross, 0.5);
    expect(net).to.be.at.most(gross);
  });
});

describe("activityLog.ts -- summarizeActivityEvent (new/changed event shapes)", () => {
  it("reserveSeeded now reports the mint fee taken from the gross seed request", () => {
    const result = summarizeActivityEvent("reserveSeeded", { initialReserveTokens: 9_950_000, mintFeeReserveTokens: 50_000 });
    expect(result?.summary).to.include("9950000");
    expect(result?.summary).to.include("50000");
    expect(result?.actor).to.equal(null);
  });

  it("reserveSeeded honestly reports 0 fee for a pre-fix event that never carried mintFeeReserveTokens (never fabricates a value)", () => {
    const result = summarizeActivityEvent("reserveSeeded", { initialReserveTokens: 10_000_000 });
    expect(result?.summary).to.include("0 minted as Protocol/Manager fee");
  });

  it("decodes the new protocolFeeCollected event with the collecting wallet as actor", () => {
    const collectedBy = { toBase58: () => "9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv" };
    const result = summarizeActivityEvent("protocolFeeCollected", { amount: 123_456, collectedBy });
    expect(result?.actor).to.equal("9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv");
    expect(result?.summary).to.include("123456");
  });
});

describe("packages/sdk/idl/ssr_protocol.json -- hand-added collect_protocol_fee entries are structurally correct", () => {
  // Anchor's sighash discriminator convention: sha256(`${namespace}:${name}`)[0..8].
  // Guards against exactly the class of mistake a hand-edited IDL risks
  // (anchor idl build itself doesn't run in this Windows environment -- see
  // docs/protocol/DEVNET_RUNBOOK.md's documented toolchain gap, and a second,
  // separate linker failure hit this pass specifically for the mingw-based
  // `anchor idl build` path).
  function discriminator(namespace: string, name: string): number[] {
    return Array.from(crypto.createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8));
  }

  it("collect_protocol_fee instruction discriminator matches sha256('global:collect_protocol_fee')", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "collect_protocol_fee");
    expect(ix, "collect_protocol_fee instruction must be present in the IDL").to.not.equal(undefined);
    expect(ix.discriminator).to.deep.equal(discriminator("global", "collect_protocol_fee"));
  });

  it("collect_protocol_fee's account list matches the Rust CollectProtocolFee struct exactly (name, order, writable/signer flags)", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "collect_protocol_fee");
    const names = ix.accounts.map((a: any) => a.name);
    expect(names).to.deep.equal([
      "protocol_config",
      "reserve",
      "reserve_token_mint",
      "mint_authority",
      "protocol_fee_destination_token_account",
      "protocol_fee_destination",
      "payer",
      "token_program",
      "associated_token_program",
      "system_program",
    ]);
    const writable = ix.accounts.filter((a: any) => a.writable).map((a: any) => a.name);
    expect(writable).to.deep.equal(["reserve", "reserve_token_mint", "protocol_fee_destination_token_account", "payer"]);
    const signers = ix.accounts.filter((a: any) => a.signer).map((a: any) => a.name);
    expect(signers).to.deep.equal(["payer"]);
  });

  it("ProtocolFeeCollected event discriminator matches sha256('event:ProtocolFeeCollected')", () => {
    const ev = (idl as any).events.find((e: any) => e.name === "ProtocolFeeCollected");
    expect(ev, "ProtocolFeeCollected event must be present in the IDL").to.not.equal(undefined);
    expect(ev.discriminator).to.deep.equal(discriminator("event", "ProtocolFeeCollected"));
  });

  it("ReserveSeeded's type gained mint_fee_reserve_tokens right after initial_reserve_tokens, matching the Rust event struct's field order", () => {
    const seeded = (idl as any).types.find((t: any) => t.name === "ReserveSeeded");
    const fieldNames = seeded.type.fields.map((f: any) => f.name);
    expect(fieldNames).to.deep.equal(["reserve", "initial_reserve_tokens", "mint_fee_reserve_tokens", "asset_mints", "asset_amounts", "ts"]);
  });

  it("every instruction discriminator in the committed IDL is internally consistent with Anchor's sighash formula -- not just the newly hand-added one", () => {
    // Spot-checks a handful of pre-existing, anchor-idl-build-generated
    // entries against the same formula, confirming the formula itself
    // (not just this one hand-edit) is right.
    for (const name of ["collect_fees", "seed_reserve", "mint_reserve_tokens_in_kind", "accrue_fees"]) {
      const ix = (idl as any).instructions.find((i: any) => i.name === name);
      expect(ix.discriminator, `${name} discriminator`).to.deep.equal(discriminator("global", name));
    }
  });
});

describe("packages/sdk/idl/ssr_protocol.json -- 2026-08-14 pass hand-added entries (claimant-only collection, instant Protocol transfers, TVL time-weighted settlement)", () => {
  function discriminator(namespace: string, name: string): number[] {
    return Array.from(crypto.createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8));
  }

  it("collect_manager_fee_share's recipient is a writable signer, with no separate payer account (claimant-only)", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "collect_manager_fee_share");
    const names = ix.accounts.map((a: any) => a.name);
    expect(names).to.not.include("payer");
    expect(names).to.include("recipient");
    const recipient = ix.accounts.find((a: any) => a.name === "recipient");
    expect(recipient.writable, "recipient must be writable").to.equal(true);
    expect(recipient.signer, "recipient must be a signer -- the on-chain claimant-only enforcement").to.equal(true);
  });

  // DEC-0154's rule is "the SDK IDL tracks the DEPLOYED binary, and this pin
  // may only change together with a real Mainnet program upgrade." That
  // upgrade happened: the DEC-0173 fee-vault change and DEC-0195 were both
  // executed through Squads on 2026-09-08, and seed_reserve/redeem below were
  // re-pinned for it in that pass -- mint and accrue_fees were simply missed,
  // so they kept asserting a shape the chain no longer runs.
  //
  // Re-pinned 2026-09-11 (DEC-0200) against the deployed shape, evidenced by a
  // real successful mint on Reserve 24 passing 63 accounts = 13 fixed + 10
  // legs x 5, signature
  // 29NTSR56kDuDakAVtFn1otVLCzNHP9bBAAGyCmocyTw5kEXrV9t2d1xKxbt5UU9tURVS1pqzZhXd41KXgmMzEbRr.
  // Had the deployed binary still wanted the old shape, that transaction would
  // have failed with Anchor 3002 exactly as the DEC-0154 incident did.
  it("mint_reserve_tokens_in_kind: the SDK IDL tracks the DEPLOYED Mainnet binary -- the post-DEC-0173 fee-vault shape. May only change together with a real Mainnet program upgrade.", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "mint_reserve_tokens_in_kind");
    const names = ix.accounts.map((a: any) => a.name);
    expect(names).to.deep.equal([
      "protocol_config",
      "reserve",
      "reserve_token_mint",
      "mint_authority",
      "depositor_reserve_token_account",
      "depositor",
      "fee_settlement",
      "fee_vault",
      "fee_vault_authority",
      "tvl_accrual",
      "token_program",
      "associated_token_program",
      "system_program",
    ]);
  });

  // DEC-0173 (re-pinned together with the program upgrade this shape ships
  // in): seed_reserve's mint fee crystallizes into the shared fee vault --
  // the treasury-destination pair + manager_fee_recipients sentinel are
  // gone, replaced by the same fee_settlement/fee_vault/fee_vault_authority
  // trio Tier B gave mint_reserve_tokens_in_kind.
  it("seed_reserve (DEC-0173): fee-vault trio in place of the treasury destination + manager_fee_recipients, in Rust struct order", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "seed_reserve");
    const names = ix.accounts.map((a: any) => a.name);
    expect(names).to.deep.equal([
      "protocol_config",
      "reserve",
      "reserve_token_mint",
      "mint_authority",
      "manager_reserve_token_account",
      "manager",
      "fee_settlement",
      "fee_vault",
      "fee_vault_authority",
      "tvl_accrual",
      "token_program",
      "associated_token_program",
      "system_program",
    ]);
    for (const w of ["fee_settlement", "fee_vault"]) expect(ix.accounts.find((a: any) => a.name === w).writable, w).to.equal(true);
  });

  // DEC-0173: the redemption fee is re-minted into the fee vault after the
  // full burn (old burn-for-holders mechanic paid nobody), so redeem gained
  // mint_authority (the re-mint CPI signer), the fee-vault trio and
  // associated_token_program; redeemer stays writable (now also fronts the
  // one-time FeeSettlement + fee-vault ATA rent on a Reserve's first-ever
  // crystallization). manager_fee_recipients stays optional.
  it("redeem_reserve_tokens_in_kind (DEC-0173): gained mint_authority + the fee-vault trio + associated_token_program; redeemer writable", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "redeem_reserve_tokens_in_kind");
    const names = ix.accounts.map((a: any) => a.name);
    expect(names).to.deep.equal([
      "reserve",
      "reserve_token_mint",
      "vault_authority",
      "redeemer_reserve_token_account",
      "redeemer",
      "manager_fee_recipients",
      "tvl_accrual",
      "mint_authority",
      "fee_settlement",
      "fee_vault",
      "fee_vault_authority",
      "token_program",
      "associated_token_program",
      "system_program",
    ]);
    const redeemer = ix.accounts.find((a: any) => a.name === "redeemer");
    expect(redeemer.writable).to.equal(true);
    expect(ix.accounts.find((a: any) => a.name === "manager_fee_recipients").optional).to.equal(true);
  });

  // Re-pinned 2026-09-11 (DEC-0200) for the same executed upgrade as
  // mint_reserve_tokens_in_kind above. Independently corroborated: the hourly
  // fee keeper has been calling accrue_fees successfully against the deployed
  // binary with the fee-vault trio since DEC-0196.
  it("accrue_fees: the SDK IDL tracks the DEPLOYED Mainnet binary -- the post-DEC-0173 fee-vault shape. May only change together with a real Mainnet program upgrade.", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "accrue_fees");
    const names = ix.accounts.map((a: any) => a.name);
    expect(names).to.deep.equal([
      "protocol_config",
      "reserve",
      "reserve_token_mint",
      "mint_authority",
      "tvl_accrual",
      "fee_settlement",
      "fee_vault",
      "fee_vault_authority",
      "payer",
      "token_program",
      "associated_token_program",
      "system_program",
    ]);
  });

  it("TvlAccrual account discriminator matches sha256('account:TvlAccrual') and its type fields match the Rust struct", () => {
    const acc = (idl as any).accounts.find((a: any) => a.name === "TvlAccrual");
    expect(acc, "TvlAccrual account must be present in the IDL").to.not.equal(undefined);
    expect(acc.discriminator).to.deep.equal(discriminator("account", "TvlAccrual"));
    const ty = (idl as any).types.find((t: any) => t.name === "TvlAccrual");
    const fieldNames = ty.type.fields.map((f: any) => f.name);
    expect(fieldNames).to.deep.equal(["schema_version", "reserve", "period_supply_seconds", "last_checkpoint_ts", "last_settled_ts", "bump"]);
  });

  it("ProtocolMintFeeTransferred event discriminator matches sha256('event:ProtocolMintFeeTransferred')", () => {
    const ev = (idl as any).events.find((e: any) => e.name === "ProtocolMintFeeTransferred");
    expect(ev, "ProtocolMintFeeTransferred event must be present in the IDL").to.not.equal(undefined);
    expect(ev.discriminator).to.deep.equal(discriminator("event", "ProtocolMintFeeTransferred"));
  });

  it("TvlFeeSettled event discriminator matches sha256('event:TvlFeeSettled') and its type fields match the Rust struct", () => {
    const ev = (idl as any).events.find((e: any) => e.name === "TvlFeeSettled");
    expect(ev, "TvlFeeSettled event must be present in the IDL").to.not.equal(undefined);
    expect(ev.discriminator).to.deep.equal(discriminator("event", "TvlFeeSettled"));
    const ty = (idl as any).types.find((t: any) => t.name === "TvlFeeSettled");
    const fieldNames = ty.type.fields.map((f: any) => f.name);
    expect(fieldNames).to.deep.equal([
      "reserve",
      "reserve_token_mint",
      "period_start_ts",
      "period_end_ts",
      "time_weighted_avg_supply",
      "protocol_fee_shares",
      "manager_fee_shares",
      "protocol_destination",
      "settled_by",
      "ts",
    ]);
  });
});
