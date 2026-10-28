// The API folders with {"type":"commonjs"} run as CommonJS on Vercel and can only
// load files whose nearest package.json is also CommonJS. An import into an ES module
// folder typechecks and builds, then crashes the function when it loads: on 2026-10-28
// the fee keeper imported lib/command-center and its 12:15 run never started.
import { expect } from "chai";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";

const ROOT = join(__dirname, "..");
const CJS_API_DIRS = ["api/devnet", "api/kpis", "api/ledger", "api/mainnet", "api/robinhood"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : tsFiles(p);
    return /\.ts$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
  });
}

function moduleType(file: string): string {
  for (let d = dirname(file); d.startsWith(ROOT); d = dirname(d)) {
    const pkg = join(d, "package.json");
    if (existsSync(pkg)) return JSON.parse(readFileSync(pkg, "utf8")).type ?? "commonjs";
    if (d === ROOT) break;
  }
  return "commonjs";
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

describe("CommonJS API functions import only CommonJS folders", () => {
  for (const dir of CJS_API_DIRS) {
    it(`${dir}: every relative import lands in a {"type":"commonjs"} folder`, () => {
      expect(moduleType(join(ROOT, dir, "x.ts")), `${dir} itself`).to.equal("commonjs");
      const bad: string[] = [];
      for (const file of tsFiles(join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+["'](\.[^"']+)["']/g)) {
          if (/^import\s+type\s/.test(m[0].trim())) continue;
          const target = resolveImport(file, m[1]);
          if (target && moduleType(target) !== "commonjs") bad.push(`${relative(ROOT, file)} -> ${m[1]}`);
        }
      }
      expect(bad, bad.join("\n")).to.deep.equal([]);
    });
  }
});
