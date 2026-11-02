// DEC-0276: self-serve ISSUED beta keys (lib/site/session.ts) and the claim
// input rules (lib/site/claimPure.ts). Network-free, plain ESM mocha like
// tests/phase_beta_gate.mjs:
//
//   npx mocha tests/phase_beta_claim.mjs
import { expect } from "chai";
import {
  configuredAccessKeys,
  createSiteSessionCookieValue,
  generateIssuedKey,
  issuedSessionAnchor,
  matchBetaKey,
  normalizeIssuedKey,
  sessionTtlForKey,
  sessionVerificationKeys,
  SITE_SESSION_TTL_MS,
  verifyIssuedKey,
  verifySiteSessionCookie,
} from "../lib/site/session.ts";
import { normalizeHandle, parseBetaClaim, sheetSafe } from "../lib/site/claimPure.ts";

const SITE = "site-password-and-signing-secret";
const ISSUE = "issue-secret-for-tests";
const ENV = { SSR_SITE_PASSWORD: SITE, SSR_BETA_KEYS: "SSR-BETA-AAAA-1111", SSR_BETA_ISSUE_SECRET: ISSUE };

describe("Issued BETA keys (DEC-0276)", () => {
  it("generates SSR-XXXX-XXXX-XXXX-XXXX keys in Crockford base32 that verify", async () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const key = await generateIssuedKey(ISSUE);
      expect(key).to.match(/^SSR-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      expect(await verifyIssuedKey(key, ENV)).to.equal(key);
      seen.add(key);
    }
    expect(seen.size).to.equal(50);
  });

  it("forgives case, spacing, missing dashes and O/I/L look-alikes", async () => {
    const key = await generateIssuedKey(ISSUE);
    const messy = "  " + key.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l") + " ";
    expect(normalizeIssuedKey(messy)).to.equal(key);
    expect(await verifyIssuedKey(messy, ENV)).to.equal(key);
  });

  it("refuses a tampered key, a key signed by another secret, and anything when issuing is off", async () => {
    const key = await generateIssuedKey(ISSUE);
    const last = key.at(-1);
    const tampered = key.slice(0, -1) + (last === "Z" ? "Y" : "Z");
    expect(await verifyIssuedKey(tampered, ENV)).to.equal(null);
    expect(await verifyIssuedKey(await generateIssuedKey("other-secret"), ENV)).to.equal(null);
    expect(await verifyIssuedKey(key, { ...ENV, SSR_BETA_ISSUE_SECRET: "" })).to.equal(null);
    expect(await verifyIssuedKey("SSR-BETA-AAAA-1111", ENV)).to.equal(null);
    expect(normalizeIssuedKey("SSR-UUUU-0000-0000-0000")).to.equal(null); // U is not Crockford
    expect(normalizeIssuedKey("XYZ-0000-0000-0000-0000")).to.equal(null);
  });

  it("SSR_REVOKED_BETA_KEYS refuses individual keys (in any typed form)", async () => {
    const key = await generateIssuedKey(ISSUE);
    expect(await verifyIssuedKey(key, { ...ENV, SSR_REVOKED_BETA_KEYS: `foo, ${key.toLowerCase()}` })).to.equal(null);
  });

  it("the session anchor is never a login key, but opens a 30-day session the middleware accepts", async () => {
    const anchor = issuedSessionAnchor(ISSUE);
    expect(matchBetaKey(anchor, configuredAccessKeys(ENV))).to.equal(null);
    expect(sessionTtlForKey(anchor, ENV)).to.equal(SITE_SESSION_TTL_MS);
    const cookie = await createSiteSessionCookieValue(SITE, anchor, sessionTtlForKey(anchor, ENV));
    expect(await verifySiteSessionCookie(cookie, SITE, sessionVerificationKeys(ENV))).to.equal(true);
    // Rotating or removing the issue secret revokes every issued-key session.
    expect(await verifySiteSessionCookie(cookie, SITE, sessionVerificationKeys({ ...ENV, SSR_BETA_ISSUE_SECRET: "rotated" }))).to.equal(false);
    expect(await verifySiteSessionCookie(cookie, SITE, sessionVerificationKeys({ ...ENV, SSR_BETA_ISSUE_SECRET: "" }))).to.equal(false);
  });

  it("sessionVerificationKeys is the access list unchanged when issuing is off", () => {
    expect(sessionVerificationKeys({ SSR_SITE_PASSWORD: SITE })).to.deep.equal(configuredAccessKeys({ SSR_SITE_PASSWORD: SITE }));
    expect(sessionVerificationKeys(ENV)).to.deep.equal([...configuredAccessKeys(ENV), issuedSessionAnchor(ISSUE)]);
  });
});

describe("Beta claim input (DEC-0276)", () => {
  it("accepts @handle, bare handle and profile links; keys identity on the lower-cased handle", () => {
    expect(normalizeHandle("@Joao_SSR")).to.equal("Joao_SSR");
    expect(normalizeHandle("https://x.com/Joao_SSR?s=20")).to.equal("Joao_SSR");
    expect(normalizeHandle("twitter.com/joao_ssr")).to.equal("joao_ssr");
    const r = parseBetaClaim({ handle: " @Joao_SSR ", email: " Me@Example.com " });
    expect(r).to.deep.equal({ ok: true, value: { handle: "Joao_SSR", handleLower: "joao_ssr", email: "me@example.com" } });
  });

  it("requires a valid handle; email is optional but must look like one when given", () => {
    expect(parseBetaClaim({}).ok).to.equal(false);
    expect(parseBetaClaim({ handle: "@" }).ok).to.equal(false);
    expect(parseBetaClaim({ handle: "has space" }).ok).to.equal(false);
    expect(parseBetaClaim({ handle: "a".repeat(16) }).ok).to.equal(false);
    expect(parseBetaClaim({ handle: "=cmd" }).ok).to.equal(false);
    expect(parseBetaClaim({ handle: "ok", email: "nope" }).ok).to.equal(false);
    expect(parseBetaClaim({ handle: "ok", email: "" })).to.deep.equal({ ok: true, value: { handle: "ok", handleLower: "ok", email: null } });
  });

  it("sheetSafe neutralises formula prefixes", () => {
    expect(sheetSafe("@joao")).to.equal("'@joao");
    expect(sheetSafe("=1+1")).to.equal("'=1+1");
    expect(sheetSafe("joao")).to.equal("joao");
  });
});
