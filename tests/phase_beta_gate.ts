// Pure-logic coverage for the closed-beta site gate (DEC-0187):
// lib/site/session.ts -- the key list, key matching, and the signed,
// key-tagged, 30-day session cookie that middleware.ts and api/site/login.ts
// share. Network-free; the middleware's rewrite and the login handler's
// rate limiting are exercised live against the deployment instead.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_beta_gate.ts
import { expect } from "chai";
import {
  betaKeyTag,
  buildSiteSetCookie,
  configuredBetaKeys,
  createSiteSessionCookieValue,
  matchBetaKey,
  SITE_SESSION_COOKIE_NAME,
  SITE_SESSION_TTL_MS,
  siteSessionSecret,
  verifySiteSessionCookie,
} from "../lib/site/session";

const SECRET = "site-password-and-signing-secret";
const ENV = { SSR_BETA_KEYS: " SSR-BETA-AAAA-1111 ,SSR-BETA-BBBB-2222,, ", SSR_SITE_PASSWORD: SECRET };

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
