// Which Token-2022 mints this protocol can hold (DEC-0205).
//
// Opening the picker to Token-2022 (DEC-0201) was half a fix: the program
// accepts Token-2022 but rejects five extensions at registration, and without
// a matching client filter the picker offered mints that cannot be registered.
// A user then paid for a Reserve-creation transaction to find out -- live
// 2026-09-11 with PUMP (transfer hook), signature
// k4LFCn13SJoMuj2r13toJ7JeAk81FLXXkm8K7qzHbzdEC3qSCxbTZP6oB4gDLHqZYR29EZWx7cfJ3gtdpUsvKLr.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { ExtensionType } from "@solana/spl-token";
import { REJECTED_MINT_EXTENSIONS, SUPPORTED, assessExtensions, describeIncompatibleAsset } from "../packages/sdk/src/mintExtensions";

describe("rejected extensions mirror the program exactly", () => {
  it("the client list matches validate_asset_mint_extensions' REJECTED array -- a drift here silently re-opens the bug", () => {
    const rust = fs.readFileSync(path.join(__dirname, "..", "programs/ssr_protocol/src/instructions/common.rs"), "utf8");
    const block = rust.slice(rust.indexOf("const REJECTED"), rust.indexOf("];", rust.indexOf("const REJECTED")));
    for (const name of ["TransferFeeConfig", "TransferHook", "PermanentDelegate", "NonTransferable", "ConfidentialTransferMint"]) {
      expect(block, `program rejects ${name}`).to.include(name);
    }
    expect(REJECTED_MINT_EXTENSIONS).to.have.length(5);
    expect(REJECTED_MINT_EXTENSIONS).to.include(ExtensionType.TransferHook);
    expect(REJECTED_MINT_EXTENSIONS).to.include(ExtensionType.TransferFeeConfig);
    expect(REJECTED_MINT_EXTENSIONS).to.include(ExtensionType.PermanentDelegate);
    expect(REJECTED_MINT_EXTENSIONS).to.include(ExtensionType.NonTransferable);
    expect(REJECTED_MINT_EXTENSIONS).to.include(ExtensionType.ConfidentialTransferMint);
  });
});

describe("assessExtensions", () => {
  it("THE PUMP CASE: a transfer hook is refused, and the reason names it", () => {
    const out = assessExtensions([ExtensionType.TransferHook, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
    expect(out.supported).to.equal(false);
    expect(out.reason).to.contain("transfer hook");
  });

  it("harmless extensions are fine -- metadata on a mint is not a reason to refuse it", () => {
    expect(assessExtensions([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata])).to.deep.equal(SUPPORTED);
    expect(assessExtensions([])).to.deep.equal(SUPPORTED);
  });

  it("lists every offending extension, not just the first, so the user sees the whole problem", () => {
    const out = assessExtensions([ExtensionType.PermanentDelegate, ExtensionType.TransferFeeConfig, ExtensionType.TransferHook]);
    expect(out.rejected).to.have.length(3);
    expect(out.reason).to.contain("permanent delegate");
    expect(out.reason).to.contain("transfer fee");
    expect(out.reason).to.contain("transfer hook");
    expect(out.reason).to.contain(" and "); // reads as a sentence, not a dump
  });

  it("each of the five is refused on its own", () => {
    for (const ext of REJECTED_MINT_EXTENSIONS) {
      expect(assessExtensions([ext]).supported, String(ext)).to.equal(false);
    }
  });

  it("the user-facing sentence names the asset and says what to do", () => {
    const msg = describeIncompatibleAsset("PUMP", assessExtensions([ExtensionType.TransferHook]));
    expect(msg).to.contain("PUMP");
    expect(msg).to.contain("transfer hook");
    expect(msg).to.contain("Remove it from the basket");
  });
});
