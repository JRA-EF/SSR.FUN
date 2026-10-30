// /internal/commandcenter (DEC-0264): the page is internal-only and its data
// is ssr.fun production only. Pins the wiring so a later edit cannot quietly
// publish the page, expose the endpoint, or let the test site probe itself.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import ts from "typescript";

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

describe("command center Resolve buttons (feedback rows and ops alerts)", () => {
  // lib/command-center is an ES module folder this CommonJS runner cannot require; model.ts has no imports, so transpile it.
  const { parseAction } = (() => {
    const js = ts.transpileModule(read("lib/command-center/model.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const mod = { exports: {} as typeof import("../lib/command-center/model") };
    new Function("exports", "module", js)(mod.exports, mod);
    return mod.exports;
  })();
  // Same as probes.ts alertKey (that module has imports, so it is pinned by source below).
  const alertKey = (fp: string) => createHash("sha256").update(fp).digest("hex").slice(0, 20);

  it("accepts a feedback status only for a real row, a parseable Received time and a known status", () => {
    const ok = parseAction({ action: "feedback-status", row: 7, at: "2026-10-30T10:00:00.000Z", status: "Resolved" }, []);
    expect(ok).to.deep.equal({ ok: true, action: { kind: "feedback-status", row: 7, at: "2026-10-30T10:00:00.000Z", status: "Resolved" } });
    expect(parseAction({ action: "feedback-status", row: 1, at: "2026-10-30T10:00:00Z", status: "Resolved" }, []).ok).to.equal(false);
    expect(parseAction({ action: "feedback-status", row: 7, at: "nope", status: "Resolved" }, []).ok).to.equal(false);
    expect(parseAction({ action: "feedback-status", row: 7, at: "2026-10-30T10:00:00Z", status: "Open" }, []).ok).to.equal(false);
  });

  it("marks an alert by a hashed key with a known outcome; the raw fingerprint never reaches the page", () => {
    const key = alertKey("keeper|settle|some message");
    expect(key).to.match(/^[0-9a-f]{20}$/);
    expect(read("lib/command-center/probes.ts")).to.include("createHash('sha256').update(fingerprint).digest('hex').slice(0, 20)");
    expect(parseAction({ action: "alert-review", key, outcome: "fixed" }, [])).to.deep.equal({ ok: true, action: { kind: "alert-review", key, outcome: "fixed" } });
    expect(parseAction({ action: "alert-review", key: "keeper|settle|x", outcome: "fixed" }, []).ok).to.equal(false);
    expect(parseAction({ action: "alert-review", key, outcome: "whatever" }, []).ok).to.equal(false);
  });

  it("the drawer renders the buttons and the handler routes both actions", () => {
    const page = read("public/internal-commandcenter.html");
    expect(page).to.include("function resolveButtons(r)");
    expect(page).to.include("action: 'feedback-status'");
    expect(page).to.include("action: 'alert-review'");
    const h = read("api/dashboard/commandcenter.ts");
    expect(h).to.include("await setFeedbackStatus(a.row, a.at, a.status)");
    expect(h).to.include("await reviewAlert(a.key, a.outcome)");
    expect(read("tools/feedback-sheet/Code.gs")).to.include("status: status, row: i + 2");
  });
});
