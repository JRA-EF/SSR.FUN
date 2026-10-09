// Co-manager permission containment (9111fd0, 2026-09-02; ported with
// DEC-0229). The program-side rule (a co-manager may grant only permissions it
// holds, and never edit its own record) is unit-tested in Rust
// (common.rs::permission_containment_tests, exhaustive over the v1 flag
// space). This guards the client-visible half: the two errors exist, are
// appended after every earlier code, and their messages use the approved
// "co-manager" wording (CLAUDE.md: "Delegate" never appears in user copy).
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import idl from "../packages/sdk/idl/ssr_protocol.json";

const errors = (idl as unknown as { errors: { code: number; name: string; msg: string }[] }).errors;

describe("Co-manager permission containment -- IDL and wiring", () => {
  it("appends DelegatePermissionEscalation (6066) and DelegateSelfModification (6067) after the transfer-fee errors", () => {
    const byName = new Map(errors.map((e) => [e.name, e]));
    expect(byName.get("TransferFeeTreasuryMismatch")!.code).to.equal(6065);
    expect(byName.get("DelegatePermissionEscalation")!.code).to.equal(6066);
    expect(byName.get("DelegateSelfModification")!.code).to.equal(6067);
    for (const name of ["DelegatePermissionEscalation", "DelegateSelfModification"]) {
      expect(byName.get(name)!.msg).to.match(/co-manager/);
      expect(byName.get(name)!.msg).to.not.match(/delegate/i);
    }
  });

  it("add_delegate and update_delegate_permissions both call the containment guard", () => {
    for (const f of ["add_delegate.rs", "update_delegate_permissions.rs"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "..", "programs/ssr_protocol/src/instructions", f), "utf8");
      expect(src, f).to.include("require_grantable_permissions(");
    }
  });
});
