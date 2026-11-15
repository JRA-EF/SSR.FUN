import { expect } from "chai";
import { readFileSync } from "node:fs";

// 2026-11-15: ssr.fun/feedback served the old standalone form (feedback.html),
// separate from the in-app flow people actually use. Both addresses now send
// people to the in-app #/feedback page.
describe("ssr.fun/feedback opens the in-app feedback flow", () => {
  const cfg = JSON.parse(readFileSync("vercel.json", "utf8"));
  for (const source of ["/feedback", "/feedback.html"]) {
    it(`redirects ${source} to /#/feedback`, () => {
      const r = cfg.redirects.find((x: { source: string }) => x.source === source);
      expect(r).to.deep.include({ destination: "/#/feedback", permanent: false });
    });
  }
  it("no longer rewrites /feedback to the standalone form", () => {
    expect(cfg.rewrites.some((x: { source: string }) => x.source === "/feedback")).to.equal(false);
  });
});
