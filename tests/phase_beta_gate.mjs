// Pure-logic coverage for the closed-beta site gate (DEC-0187):
// lib/site/session.ts -- the key list, key matching, and the signed,
// key-tagged, 30-day session cookie that middleware.ts and api/site/login.ts
// share. Network-free; the middleware's rewrite and the login handler's rate
// limiting are exercised live against the deployment instead.
//
// Plain ESM mocha (not ts-mocha): lib/site/session.ts is an ES module (root
// package.json "type": "module") imported by the Edge middleware, so it must
// NOT get the CommonJS-scoping package.json the other lib/* test targets use
// -- tsconfig.node.json's verbatimModuleSyntax would reject its exports.
// Node 24 strips the file's (erasable-only) type syntax natively, so:
//
//   npx mocha tests/phase_beta_gate.mjs
import { expect } from "chai";
import {
  betaKeyTag,
  buildSiteSetCookie,
  configuredAccessKeys,
  configuredBetaKeys,
  configuredTeamKeys,
  createSiteSessionCookieValue,
  matchBetaKey,
  sessionTtlForKey,
  siteGateMode,
  SITE_SESSION_COOKIE_NAME,
  SITE_SESSION_TTL_MS,
  siteSessionSecret,
  TEAM_SESSION_TTL_MS,
  verifySiteSessionCookie,
} from "../lib/site/session.ts";

const SECRET = "site-password-and-signing-secret";
const ENV = { SSR_BETA_KEYS: " SSR-BETA-AAAA-1111 ,SSR-BETA-BBBB-2222,, ", SSR_TEAM_KEYS: "SSR-TEAM-CCCC-3333, SSR-TEAM-DDDD-4444 ", SSR_SITE_PASSWORD: SECRET };

describe("Closed-beta gate -- team keys (SSR_TEAM_KEYS, 400-day sessions)", () => {
  it("parses the team list separately and the access list is beta + password + team", () => {
    expect(configuredTeamKeys(ENV)).to.deep.equal(["SSR-TEAM-CCCC-3333", "SSR-TEAM-DDDD-4444"]);
    expect(configuredAccessKeys(ENV)).to.deep.equal(["SSR-BETA-AAAA-1111", "SSR-BETA-BBBB-2222", SECRET, "SSR-TEAM-CCCC-3333", "SSR-TEAM-DDDD-4444"]);
    expect(configuredAccessKeys({})).to.deep.equal([]);
  });
  it("a team key opens a 400-day session; a beta key or the password opens a 30-day one", () => {
    expect(TEAM_SESSION_TTL_MS).to.equal(400 * 24 * 60 * 60 * 1000);
    expect(sessionTtlForKey("SSR-TEAM-DDDD-4444", ENV)).to.equal(TEAM_SESSION_TTL_MS);
    expect(sessionTtlForKey("SSR-BETA-AAAA-1111", ENV)).to.equal(SITE_SESSION_TTL_MS);
    expect(sessionTtlForKey(SECRET, ENV)).to.equal(SITE_SESSION_TTL_MS);
    expect(sessionTtlForKey("SSR-TEAM-DDDD-4444", { SSR_BETA_KEYS: "SSR-TEAM-DDDD-4444" })).to.equal(SITE_SESSION_TTL_MS);
  });
  it("a team key matches through the access list, its cookie verifies against the access list, and removing it revokes the session", async () => {
    const keys = configuredAccessKeys(ENV);
    expect(matchBetaKey("SSR-TEAM-CCCC-3333", keys)).to.equal("SSR-TEAM-CCCC-3333");
    const value = await createSiteSessionCookieValue(SECRET, "SSR-TEAM-CCCC-3333", sessionTtlForKey("SSR-TEAM-CCCC-3333", ENV));
    const expiresAt = Number(value.split(".")[0]);
    expect(expiresAt - Date.now()).to.be.greaterThan(399 * 24 * 60 * 60 * 1000);
    expect(await verifySiteSessionCookie(value, SECRET, keys)).to.equal(true);
    expect(await verifySiteSessionCookie(value, SECRET, configuredBetaKeys(ENV))).to.equal(false);
    expect(await verifySiteSessionCookie(value, SECRET, configuredAccessKeys({ ...ENV, SSR_TEAM_KEYS: "SSR-TEAM-DDDD-4444" }))).to.equal(false);
  });
});

describe("Closed-beta gate -- configuredBetaKeys / siteSessionSecret", () => {
  it("parses the comma-separated list, trims entries, drops empties, and appends SSR_SITE_PASSWORD as a key", () => {
    expect(configuredBetaKeys(ENV)).to.deep.equal(["SSR-BETA-AAAA-1111", "SSR-BETA-BBBB-2222", SECRET]);
  });
  it("with no SSR_BETA_KEYS, the site password alone still opens the site (existing holders keep working)", () => {
    expect(configuredBetaKeys({ SSR_SITE_PASSWORD: SECRET })).to.deep.equal([SECRET]);
  });
  it("with nothing configured there are no keys and no secret -- sign-in is impossible, never open", () => {
    expect(configuredBetaKeys({})).to.deep.equal([]);
    expect(siteSessionSecret({})).to.equal("");
  });
  it("the signing secret is SSR_SITE_PASSWORD regardless of which key is redeemed", () => {
    expect(siteSessionSecret(ENV)).to.equal(SECRET);
  });
});

describe("Closed-beta gate -- matchBetaKey", () => {
  const keys = configuredBetaKeys(ENV);
  it("returns the exact configured key for a valid submission", () => {
    expect(matchBetaKey("SSR-BETA-BBBB-2222", keys)).to.equal("SSR-BETA-BBBB-2222");
    expect(matchBetaKey(SECRET, keys)).to.equal(SECRET);
  });
  it("rejects near-misses, prefixes, case changes, and the empty string", () => {
    expect(matchBetaKey("SSR-BETA-BBBB-2223", keys)).to.equal(null);
    expect(matchBetaKey("SSR-BETA-BBBB", keys)).to.equal(null);
    expect(matchBetaKey("ssr-beta-bbbb-2222", keys)).to.equal(null);
    expect(matchBetaKey("", keys)).to.equal(null);
  });
});

describe("Closed-beta gate -- session cookie", () => {
  const keys = configuredBetaKeys(ENV);

  it("is valid for 30 days", () => {
    expect(SITE_SESSION_TTL_MS).to.equal(30 * 24 * 60 * 60 * 1000);
  });

  it("a cookie minted for a configured key verifies against the same secret and key list", async () => {
    const value = await createSiteSessionCookieValue(SECRET, "SSR-BETA-AAAA-1111");
    expect(value.split(".")).to.have.lengthOf(3);
    expect(await verifySiteSessionCookie(value, SECRET, keys)).to.equal(true);
  });

  it("records WHICH key was redeemed: removing that key from the list revokes the session, other keys' sessions survive", async () => {
    const a = await createSiteSessionCookieValue(SECRET, "SSR-BETA-AAAA-1111");
    const b = await createSiteSessionCookieValue(SECRET, "SSR-BETA-BBBB-2222");
    const withoutA = configuredBetaKeys({ SSR_BETA_KEYS: "SSR-BETA-BBBB-2222", SSR_SITE_PASSWORD: SECRET });
    expect(await verifySiteSessionCookie(a, SECRET, withoutA)).to.equal(false);
    expect(await verifySiteSessionCookie(b, SECRET, withoutA)).to.equal(true);
  });

  it("the key tag is a 12-hex digest, never the key itself", async () => {
    const tag = await betaKeyTag("SSR-BETA-AAAA-1111");
    expect(tag).to.match(/^[0-9a-f]{12}$/);
    expect(tag).to.not.include("AAAA");
    const value = await createSiteSessionCookieValue(SECRET, "SSR-BETA-AAAA-1111");
    expect(value).to.not.include("SSR-BETA");
  });

  it("rejects a cookie signed with a different secret (rotating SSR_SITE_PASSWORD logs everyone out)", async () => {
    const value = await createSiteSessionCookieValue("other-secret", "SSR-BETA-AAAA-1111");
    expect(await verifySiteSessionCookie(value, SECRET, keys)).to.equal(false);
  });

  it("rejects a tampered expiry (signature covers expiresAt and keyTag)", async () => {
    const value = await createSiteSessionCookieValue(SECRET, "SSR-BETA-AAAA-1111");
    const [exp, tag, sig] = value.split(".");
    expect(await verifySiteSessionCookie(`${Number(exp) + 1}.${tag}.${sig}`, SECRET, keys)).to.equal(false);
  });

  it("rejects an expired cookie", async () => {
    const value = await createSiteSessionCookieValue(SECRET, "SSR-BETA-AAAA-1111", -1000);
    expect(await verifySiteSessionCookie(value, SECRET, keys)).to.equal(false);
  });

  it("rejects the pre-DEC-0187 two-part cookie shape, garbage, undefined, and an empty key list (fails closed)", async () => {
    expect(await verifySiteSessionCookie(`${Date.now() + 60000}.deadbeef`, SECRET, keys)).to.equal(false);
    expect(await verifySiteSessionCookie("not-a-cookie", SECRET, keys)).to.equal(false);
    expect(await verifySiteSessionCookie(undefined, SECRET, keys)).to.equal(false);
    const value = await createSiteSessionCookieValue(SECRET, "SSR-BETA-AAAA-1111");
    expect(await verifySiteSessionCookie(value, SECRET, [])).to.equal(false);
    expect(await verifySiteSessionCookie(value, "", keys)).to.equal(false);
  });

  it("Set-Cookie carries the ssr_site_session name, HttpOnly, SameSite=Strict, a 30-day Max-Age, and Secure only when asked", () => {
    const header = buildSiteSetCookie("v", { maxAgeSeconds: SITE_SESSION_TTL_MS / 1000, secure: true });
    expect(header.startsWith(`${SITE_SESSION_COOKIE_NAME}=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`)).to.equal(true);
    expect(header).to.include("Secure");
    expect(buildSiteSetCookie("v", { maxAgeSeconds: 1, secure: false })).to.not.include("Secure");
  });
});

describe("Closed-beta gate -- page mode (SSR_SITE_GATE_MODE, DEC-0189)", () => {
  it("defaults to the Coming Soon page: unset, empty, or any value other than 'password'", () => {
    expect(siteGateMode({})).to.equal("coming-soon");
    expect(siteGateMode({ SSR_SITE_GATE_MODE: "" })).to.equal("coming-soon");
    expect(siteGateMode({ SSR_SITE_GATE_MODE: "coming-soon" })).to.equal("coming-soon");
    expect(siteGateMode({ SSR_SITE_GATE_MODE: "true" })).to.equal("coming-soon");
    expect(siteGateMode({ SSR_SITE_GATE_MODE: "passwords" })).to.equal("coming-soon");
  });
  it("'password' (trimmed, any case) selects the plain sign-in form", () => {
    expect(siteGateMode({ SSR_SITE_GATE_MODE: "password" })).to.equal("password");
    expect(siteGateMode({ SSR_SITE_GATE_MODE: " Password " })).to.equal("password");
  });
});

// Gate deep links (lib/site/gateNext.ts): the destination a gated visitor
// keeps through the Coming Soon page, /beta and the key sign-in.
import { gatePathRedirect, isCampaignDestination, safeNextPath } from "../lib/site/gateNext.ts";
import { readFileSync } from "node:fs";

// public/coming-soon.html carries an inline copy of the two client helpers;
// load it so both copies run the same cases.
function inlineComingSoonHelpers() {
  const html = readFileSync(new URL("../public/coming-soon.html", import.meta.url), "utf8");
  const pick = (name) => {
    const start = html.indexOf(`function ${name}(`);
    expect(start, `coming-soon.html defines ${name}`).to.be.greaterThan(-1);
    const end = html.indexOf("\n    }\n", start);
    return html.slice(start, end + 6);
  };
  // eslint-disable-next-line no-new-func
  return new Function(`${pick("safeNextPath")}\n${pick("isCampaignDestination")}\nreturn { safeNextPath, isCampaignDestination };`)();
}

describe("Closed-beta gate -- deep-link destination (gateNext)", () => {
  const impls = [
    ["lib/site/gateNext.ts", { safeNextPath, isCampaignDestination }],
    ["public/coming-soon.html inline copy", inlineComingSoonHelpers()],
  ];
  for (const [name, h] of impls) {
    it(`${name}: keeps same-site paths with their hash and query`, () => {
      expect(h.safeNextPath("/#/campaign")).to.equal("/#/campaign");
      expect(h.safeNextPath("/#/dtr/mainnet-beta-93")).to.equal("/#/dtr/mainnet-beta-93");
      expect(h.safeNextPath("/#/legal/terms")).to.equal("/#/legal/terms");
      expect(h.safeNextPath("/leaderboard?x=1")).to.equal("/leaderboard?x=1");
    });
    it(`${name}: rejects off-site, malformed and looping destinations`, () => {
      for (const bad of [null, undefined, "", "campaign", "https://evil.example/", "//evil.example/x", "/\\evil.example", "/a\nb", "javascript:alert(1)", "/beta", "/beta/", "/beta?next=/", "/beta.html", "/coming-soon.html", "/" + "a".repeat(600)]) {
        expect(h.safeNextPath(bad), String(bad)).to.equal(null);
      }
    });
    it(`${name}: recognises the Beta Campaign destination only`, () => {
      expect(h.isCampaignDestination("/#/campaign")).to.equal(true);
      expect(h.isCampaignDestination("/#/campaign?ref=earn")).to.equal(true);
      expect(h.isCampaignDestination("/campaign")).to.equal(true);
      expect(h.isCampaignDestination("/campaign/")).to.equal(true);
      expect(h.isCampaignDestination("/#/campaigns")).to.equal(false);
      expect(h.isCampaignDestination("/#/dtr/mainnet-beta-93")).to.equal(false);
      expect(h.isCampaignDestination("/leaderboard")).to.equal(false);
      expect(h.isCampaignDestination(null)).to.equal(false);
    });
  }

  it("redirects /beta/ and /leaderboard/ to the bare path and /campaign to the hash route, keeping the query", () => {
    expect(gatePathRedirect("/beta/")).to.equal("/beta");
    expect(gatePathRedirect("/beta/", "?next=%2F%23%2Fcampaign")).to.equal("/beta?next=%2F%23%2Fcampaign");
    expect(gatePathRedirect("/leaderboard/")).to.equal("/leaderboard");
    expect(gatePathRedirect("/campaign")).to.equal("/#/campaign");
    expect(gatePathRedirect("/campaign/", "?ref=earn")).to.equal("/?ref=earn#/campaign");
    for (const p of ["/", "/beta", "/leaderboard", "/r/abc", "/campaigns", "/api/site/login"]) expect(gatePathRedirect(p), p).to.equal(null);
  });
});
