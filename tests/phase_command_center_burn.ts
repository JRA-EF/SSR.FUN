// Command center burn rate: costs typed on the cards become USD per month,
// Vercel's cycle spend is projected to the whole cycle, and wallet fee spend
// counts only balance drops (a top-up is not negative spend).
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import ts from "typescript";

// lib/command-center is an ES module folder this CommonJS runner cannot require;
// model.ts has no imports, so transpile it and load it directly.
type Model = typeof import("../lib/command-center/model");
const model = (() => {
  const src = readFileSync(join(__dirname, "..", "lib/command-center/model.ts"), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} as Model };
  new Function("exports", "module", js)(mod.exports, mod);
  return mod.exports;
})();
const { parseMonthlyCost, projectToMonth, solBurnPerDay, creditTone, formatCredits } = model;

const H = 3_600_000;
const D = 24 * H;

describe("command center burn rate", () => {
  it("reads typed costs as USD per month", () => {
    expect(parseMonthlyCost("$25/month")).to.equal(25);
    expect(parseMonthlyCost("$25/mo")).to.equal(25);
    expect(parseMonthlyCost("$300/year")).to.equal(25);
    expect(parseMonthlyCost("$12 / yr")).to.equal(1);
    expect(parseMonthlyCost("$1,200 annually")).to.equal(100);
    expect(parseMonthlyCost("Free")).to.equal(0);
    expect(parseMonthlyCost("free tier")).to.equal(0);
    expect(parseMonthlyCost("usage based")).to.equal(null);
    expect(parseMonthlyCost(undefined)).to.equal(null);
  });

  it("projects a cycle's spend to the whole cycle, but not in its first hours", () => {
    const start = 0, end = 30 * D;
    expect(projectToMonth(10, start, end, 10 * D)).to.equal(30);
    expect(projectToMonth(10, start, end, 6 * H)).to.equal(null);
    expect(projectToMonth(30, start, end, 40 * D)).to.equal(30);
  });

  it("Helius credits warn at 80% or when the pace runs out before the reset, down once used up", () => {
    expect(creditTone(5e6, 10e6, 9e6, 0)).to.equal("ok");
    expect(creditTone(8e6, 10e6, null, 0)).to.equal("warn");
    expect(creditTone(4e6, 10e6, 12e6, 0)).to.equal("warn");
    expect(creditTone(10e6, 10e6, null, 0)).to.equal("down");
    expect(creditTone(10e6, 10e6, null, 500_000)).to.equal("warn");
    expect(creditTone(1, 0, null, 0)).to.equal("unknown");
    expect([formatCredits(950), formatCredits(1_500), formatCredits(42_000), formatCredits(1_234_567), formatCredits(12_300_000)]).to.deep.equal(["950", "1.5k", "42k", "1.23M", "12.3M"]);
  });

  it("the Helius usage probe sends the key in a header, never in the URL or a metric", () => {
    const probes = readFileSync(join(__dirname, "..", "lib/command-center/probes.ts"), "utf8");
    const probe = probes.slice(probes.indexOf("async function probeHeliusUsage"), probes.indexOf("async function probeSite"));
    expect(probe).to.include("headers: { 'X-Api-Key': key }");
    expect(probe).not.to.match(/api-key=${key}/);
  });

  it("counts only balance drops, per day, once samples span six hours", () => {
    expect(solBurnPerDay([{ at: 0, sol: 1 }, { at: 2 * H, sol: 0.9 }])).to.equal(null);
    const b = solBurnPerDay([
      { at: 0, sol: 1.0 },
      { at: 12 * H, sol: 0.9 },
      { at: 24 * H, sol: 1.9 }, // top-up: ignored
      { at: 48 * H, sol: 1.7 },
    ])!;
    expect(b.spanDays).to.equal(2);
    expect(b.solPerDay).to.be.closeTo(0.15, 1e-9);
  });

  it("the keeper's balance sample can never stop or stall settlement", () => {
    const cron = readFileSync(join(__dirname, "..", "api/mainnet/fee-settlement-cron.ts"), "utf8");
    expect(cron).to.match(/Promise\.resolve\(\)\.then\(\(\) => getSql\(\)`INSERT INTO command_center_balances[^;]*\.catch\(\(\) => undefined\)/);
    // lib/command-center is an ES module folder; the CommonJS keeper cannot load it.
    expect(cron).not.to.match(/from\s+["'][^"']*lib\/command-center/);
    expect(cron).to.match(/await Promise\.race\(\[sample, new Promise\(\(resolve\) => setTimeout\(resolve, 3_000\)\)\]\)/);
  });
});
