// Offline regression coverage for the "DevNet swap adapter returned an
// unexpected response (HTTP 500)" production outage (see
// docs/project/DECISION_LOG.md's entry for this pass): every `api/devnet/*.ts`
// handler that imports from packages/sdk crashed on Vercel's deployed
// Node.js Function with a real platform-level FUNCTION_INVOCATION_FAILED
// (confirmed via direct HTTP calls against the live endpoint, and via its
// runtime logs: "Cannot find module '/var/task/node_modules/@ssr/sdk/src/
// index.ts'", later "SyntaxError: Unexpected token 'export'") -- entirely
// invisible to every prior "live-verified" Buy/Sell claim in this repo's
// history, all of which called the handler function directly via local
// ts-node/vite (which both transpile ESM on the fly), never via a real HTTP
// request to the deployed function.
//
// Root cause: a relative import ("../../packages/sdk/src") resolves to the
// SDK's raw .ts source (ESM export/import syntax, since packages/sdk has no
// compiled build), which a CommonJS require() in a real Node.js runtime
// cannot load. Fix: packages/sdk now has a real compiled CommonJS build
// (packages/sdk/dist/, via tsconfig.cjs.json) that package.json's "main"
// field points at, and every api/devnet/*.ts handler imports via the
// "@ssr/sdk" package name (resolved through that "main" field) instead of
// the raw relative path -- this is a static, offline-checkable invariant, so
// this test greps the actual source files rather than needing to invoke
// Vercel's own bundler (the only way the original bug was ever detected).
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const API_DEVNET_DIR = path.resolve(__dirname, "..", "api", "devnet");

function listTsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !fs.statSync(path.join(dir, f)).isDirectory())
    .map((f) => path.join(dir, f));
}

describe("api/devnet/*.ts -- never import packages/sdk via a relative path (deploy-bundling regression)", () => {
  const files = listTsFiles(API_DEVNET_DIR);

  it("found at least one api/devnet/*.ts file to check (sanity -- a config typo must not silently pass 0 checks)", () => {
    expect(files.length).to.be.greaterThan(0);
  });

  for (const file of files) {
    const rel = path.relative(path.resolve(__dirname, ".."), file);
    it(`${rel} does not import "../../packages/sdk/src" (the raw ESM source Node's require() cannot load when deployed)`, () => {
      const content = fs.readFileSync(file, "utf-8");
      // Only real import/require statements matter -- explanatory comments
      // mentioning the old broken path (added by this very fix) are fine.
      const importLines = content
        .split("\n")
        .filter((line) => /^\s*(import|}\s*from|const .* = require\()/.test(line) && !/^\s*\/\//.test(line));
      const offending = importLines.filter((line) => line.includes("packages/sdk/src"));
      expect(offending, `found relative packages/sdk import(s) in ${rel}: ${JSON.stringify(offending)}`).to.deep.equal([]);
    });
  }
});

describe("packages/sdk package.json -- resolvable by both Node's require() and a bundler", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "packages", "sdk", "package.json"), "utf-8"));

  it("\"main\" points at compiled CommonJS output under dist/, not raw .ts source", () => {
    expect(pkg.main).to.match(/^\.\/dist\//);
    expect(pkg.main).to.not.match(/\.ts$/);
  });

  it("\"module\" points at the raw ESM source, so Vite/Rollup-based bundlers (which prefer \"module\" over \"main\") still tree-shake the original TypeScript instead of the CJS-interop-heavy compiled output", () => {
    expect(pkg.module).to.equal("./src/index.ts");
  });

  it("has a real \"build\" script that produces the dist/ the \"main\" field points at", () => {
    expect(pkg.scripts?.build).to.be.a("string").and.not.empty;
  });
});

describe("root package.json build script -- builds the SDK's CommonJS output before the frontend/Vercel functions", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"));

  it("the \"build\" script builds packages/sdk before tsc -b/vite build", () => {
    const buildScript: string = pkg.scripts?.build ?? "";
    const sdkBuildIndex = buildScript.indexOf("--workspace=packages/sdk");
    const viteIndex = buildScript.indexOf("vite build");
    expect(sdkBuildIndex, `build script: ${buildScript}`).to.be.greaterThan(-1);
    expect(viteIndex, `build script: ${buildScript}`).to.be.greaterThan(-1);
    expect(sdkBuildIndex).to.be.lessThan(viteIndex);
  });
});
