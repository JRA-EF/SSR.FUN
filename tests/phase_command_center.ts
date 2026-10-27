// /internal/commandcenter (DEC-0264): the page is internal-only and its data
// is ssr.fun production only. Pins the wiring so a later edit cannot quietly
// publish the page, expose the endpoint, or let the test site probe itself.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("command center wiring", () => {
  const mw = read("middleware.ts");
  const handler = read("api/dashboard/commandcenter.ts");

  it("the page sits behind the internal dashboard password", () => {
    const pages = mw.slice(mw.indexOf("const INTERNAL_PAGE_PATHS"), mw.indexOf("export default async function middleware"));
    expect(pages).to.include("'/internal/commandcenter'");
    expect(pages).to.include("'/internal-commandcenter.html'");
    const rewrites: { source: string; destination: string }[] = JSON.parse(read("vercel.json")).rewrites;
    expect(rewrites.find((r) => r.source === "/internal/commandcenter")?.destination).to.equal("/internal-commandcenter.html");
  });

  it("the endpoint bypasses the beta gate only because the handler checks the session or the bearer itself", () => {
    const cron = mw.slice(mw.indexOf("const CRON_PATHS"), mw.indexOf("const SITE_LOGIN_PATH"));
    expect(cron).to.include("'/api/dashboard/commandcenter'");
    expect(handler).to.match(/verifySessionCookie\(/);
    expect(handler).to.match(/timingSafeEqual\(/);
    expect(handler).to.match(/status\(401\)/);
  });

  it("only ssr.fun production probes; every other deployment forwards to ssr.fun", () => {
    expect(handler).to.include("process.env.VERCEL_PROJECT_PRODUCTION_URL === 'ssr.fun'");
    expect(handler).to.include("const PRODUCTION_ORIGIN = 'https://ssr.fun'");
    expect(handler).to.match(/if \(!isProductionSsrFun\(\) && process\.env\.COMMAND_CENTER_LOCAL !== '1'\) \{/);
    expect(handler).to.match(/await forward\(req, res, query\)/);
    // A forwarded request never forwards again (no loop if ssr.fun misreads itself).
    expect(handler).to.include("x-command-center-forwarded");
  });

  it("the protocol wallet total leaves out the second admin's own wallet", () => {
    const probes = read("lib/command-center/probes.ts");
    const totals = probes.slice(probes.indexOf("const walletIds"), probes.indexOf("const walletIds") + 120);
    expect(totals).to.include("'treasury'");
    expect(totals).not.to.include("'admin-2'");
  });

  it("only decision-log and team items can be dismissed; live problems clear when fixed", () => {
    const model = read("lib/command-center/model.ts");
    expect(model).to.include(String.raw`/^(team:\d+|dec:DEC-\d{4}:[0-9a-f]{10})$/`);
  });

  it("probes report keys by name and age, never by value", () => {
    const probes = read("lib/command-center/probes.ts");
    expect(probes).to.include("decrypt=false");
    expect(probes).not.to.match(/value:\s*process\.env\./);
  });
});
