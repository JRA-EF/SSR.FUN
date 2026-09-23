// The client's view of which Token-2022 mints a Reserve can hold must match
// the program's, or a user pays for a Reserve-creation transaction to find out
// it cannot (live 2026-09-11 with PUMP).
//
// The rules judge an extension's CONFIGURATION, not its presence. Judging by
// presence refused all 1,025 xStocks equities for a TransferHook with no hook
// program and a ConfidentialTransferMint that does not auto-approve.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_mint_extensions.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionType } from "@solana/spl-token";
import { APPROVED_PERMANENT_DELEGATES, describeIncompatibleAsset } from "../packages/sdk/src/mintExtensions";

const rust = readFileSync(join(__dirname, "..", "programs/ssr_protocol/src/instructions/common.rs"), "utf8");
const validator = rust.slice(rust.indexOf("const APPROVED_PERMANENT_DELEGATES"), rust.indexOf("\n}", rust.indexOf("pub fn validate_asset_mint_extensions")));

describe("client mirrors the program's mint rules", () => {
  it("approves the SAME issuer delegates the program does -- a drift re-opens the bug in one direction or the other", () => {
    const inRust = [...validator.matchAll(/Pubkey::from_str_const\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/g)].map((m) => m[1]);
    expect(inRust, "the program must approve at least one issuer").to.not.be.empty;
    expect([...APPROVED_PERMANENT_DELEGATES].sort()).to.deep.equal([...inRust].sort());
  });

  it("judges configuration, not presence -- the program reads each extension's value", () => {
    // If these reads disappear the program is back to blanket-rejecting types.
    expect(validator, "hook program id").to.include("hook.program_id");
    expect(validator, "fee basis points").to.include("transfer_fee_basis_points");
    expect(validator, "delegate pubkey").to.include("pd.delegate");
    expect(validator, "confidential auto-approve").to.include("auto_approve_new_accounts");
  });

  it("keeps NonTransferable unconditional -- a vault could never pay a redemption", () => {
    expect(validator).to.match(/ExtensionType::NonTransferable[\s\S]{0,120}UnsupportedMintExtension/);
  });

  it("rejects a scheduled fee, not just the current one (a newer fee activates on its own epoch)", () => {
    expect(validator).to.include("older_transfer_fee");
    expect(validator).to.include("newer_transfer_fee");
  });
});

describe("the user-facing sentence", () => {
  it("names the asset and says what to do", () => {
    const msg = describeIncompatibleAsset("PUMP", {
      supported: false,
      rejected: [ExtensionType.TransferHook],
      reason: "runs a transfer hook, which can block or alter every transfer",
    });
    expect(msg).to.include("PUMP");
    expect(msg).to.include("transfer hook");
    expect(msg).to.include("Remove it from the basket");
  });
});
