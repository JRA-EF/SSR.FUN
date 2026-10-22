// Every scheduled cron must be exempt from the site-wide password gate.
// Vercel's cron runner carries no session cookie, so a cron path missing from
// middleware.ts's CRON_PATHS gets the gate's 401 on every run and its handler
// (which checks CRON_SECRET itself) never executes. Both the DEX volume cron
// (DEC-0254) and the Robinhood catalogue cron were scheduled without it.
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("cron paths vs the site gate", () => {
  it("every vercel.json cron path is listed in middleware CRON_PATHS", () => {
    const mw = read("middleware.ts");
    const list = mw.slice(mw.indexOf("const CRON_PATHS"), mw.indexOf("const SITE_LOGIN_PATH"));
    const crons: { path: string }[] = JSON.parse(read("vercel.json")).crons;
    expect(crons.length).to.be.greaterThan(0);
    const missing = crons.map((c) => c.path).filter((p) => !list.includes(`'${p}'`));
    expect(missing).to.deep.equal([]);
  });
});
