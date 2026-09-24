// The EVM (Robinhood Chain) surface must be reachable ONLY when this build
// was made with VITE_ENABLE_EVM=true.
//
// These read the source because the flag is a build-time constant: Vite
// inlines it and eliminates the dead branches, so there is nothing to observe
// at runtime in a test. What can be protected is the invariant -- every
// visitor-reachable entry point is behind EVM_ENABLED -- and that is exactly
// what a later edit is likely to break by adding a new one.
//
// This complements phase_robinhood_ui_contract.ts rather than replacing it:
// that file asserts the integration is still WIRED into the shared surfaces,
// this one asserts it is still GATED. Both must hold -- the feature is hidden,
// not deleted.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_evm_feature_flag.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainFromPath } from "../src/merge/lib/chainChoice";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("the EVM surface is off unless the build asks for it", () => {
  it("defaults to off: only the exact string 'true' enables it", () => {
    const flag = read("src/merge/lib/evmFeature.ts");
    expect(flag).to.include("VITE_ENABLE_EVM");
    // An absent env var, "1", "yes" or "TRUE" must all leave it off.
    expect(flag, "must compare against the literal true").to.match(/===\s*"true"/);
  });

  it("every visitor-reachable entry point is behind the flag", () => {
    const gated: [string, string][] = [
      ["src/components/Shell.tsx", "the header wallet chip"],
      ["src/App.tsx", "the /evm and /dtr/rh- routes"],
      ["src/merge/pages/Discover.tsx", "the chain filter and Robinhood banners"],
      ["src/merge/pages/CreateReserve.tsx", "the chain picker and Robinhood form"],
      ["src/merge/pages/Portfolio.tsx", "the Robinhood holdings section"],
      ["src/merge/hooks/useRobinhoodReserves.ts", "the Robinhood RPC fetch"],
    ];
    for (const [path, what] of gated) {
      expect(read(path), `${path} must gate ${what}`).to.include("EVM_ENABLED");
    }
  });

  it("makes no Robinhood RPC call at all while hidden -- the data choke point, so Home and Discover need no guard of their own", () => {
    const hook = read("src/merge/hooks/useRobinhoodReserves.ts");
    const load = hook.slice(hook.indexOf("async function load()"));
    const guard = load.indexOf("if (!EVM_ENABLED) return;");
    const fetchStart = load.indexOf('import("@/lib/evmChain")');
    expect(guard, "load() must check the flag").to.be.greaterThan(-1);
    expect(fetchStart, "load() must be the thing that imports the EVM stack").to.be.greaterThan(-1);
    expect(guard, "the flag check must come BEFORE anything is fetched").to.be.lessThan(fetchStart);
  });

  it("an old ?chain=robinhood bookmark lands on the Solana form instead of a blank page", () => {
    expect(chainFromPath("/create?chain=robinhood", false)).to.equal("solana");
    expect(chainFromPath("/create", false)).to.equal("solana");
    // ...and still works normally once the surface is enabled.
    expect(chainFromPath("/create?chain=robinhood", true)).to.equal("robinhood");
    expect(chainFromPath("/create", true)).to.equal("solana");
    expect(chainFromPath("/create?chain=ethereum", true)).to.equal("solana");
  });

  it("is hidden, not deleted -- the EVM modules are still present and buildable", () => {
    for (const p of [
      "src/merge/lib/evmChain.ts",
      "src/merge/lib/evmReserve.ts",
      "src/merge/components/robinhood/RobinhoodCreateForm.tsx",
      "src/merge/components/robinhood/RobinhoodReserveDetail.tsx",
    ]) {
      expect(read(p).length, `${p} must still exist`).to.be.greaterThan(0);
    }
  });
});
