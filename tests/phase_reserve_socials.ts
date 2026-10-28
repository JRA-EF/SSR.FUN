// Creator social links (X, Telegram, YouTube) entered on Launch step 1, stored
// in the Reserve's metadata payload, and shown as icons beside the ticker on
// the Reserve page together with a DexScreener lookup of the contract address.
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { normalizeXUrl, normalizeTelegramUrl, dexScreenerSearchUrl } from "../src/merge/lib/reserveSocials";
import { validateReserveMetadataPayload, computeMetadataId } from "../lib/reserve-metadata/payload";
import { parseReserveMetadataUri } from "../packages/sdk/src/discovery";
import { parseEvmReserveMeta } from "../src/merge/lib/evmReserveMeta";

describe("Reserve social links", () => {
  it("normalizes X handles and links to https://x.com", () => {
    expect(normalizeXUrl("@ssrfun")).to.equal("https://x.com/ssrfun");
    expect(normalizeXUrl("ssrfun")).to.equal("https://x.com/ssrfun");
    expect(normalizeXUrl("twitter.com/ssrfun/")).to.equal("https://x.com/ssrfun");
    expect(normalizeXUrl("https://x.com/i/communities/123")).to.equal("https://x.com/i/communities/123");
    expect(normalizeXUrl("")).to.equal(null);
    expect(normalizeXUrl("https://evil.com/ssrfun")).to.equal(null);
    expect(normalizeXUrl("https://x.com/")).to.equal(null);
  });

  it("normalizes Telegram handles and links to https://t.me", () => {
    expect(normalizeTelegramUrl("@ssrfun")).to.equal("https://t.me/ssrfun");
    expect(normalizeTelegramUrl("t.me/ssrfun")).to.equal("https://t.me/ssrfun");
    expect(normalizeTelegramUrl("https://telegram.me/+AbCdEf")).to.equal("https://t.me/+AbCdEf");
    expect(normalizeTelegramUrl("abc")).to.equal(null);
    expect(normalizeTelegramUrl("javascript:alert(1)")).to.equal(null);
  });

  it("builds a DexScreener search for the contract address", () => {
    expect(dexScreenerSearchUrl(" So11111111111111111111111111111111111111112 ")).to.equal(
      "https://dexscreener.com/search?q=So11111111111111111111111111111111111111112",
    );
  });

  it("stores X/Telegram after the existing fields, leaving older payload ids unchanged", () => {
    const base = { name: "Alpha", ticker: "ALP", description: "d", category: "DeFi", youtubeChannelUrl: "https://www.youtube.com/@a" };
    const before = validateReserveMetadataPayload(base);
    const after = validateReserveMetadataPayload({ ...base, xUrl: "", telegramUrl: "  " });
    expect(computeMetadataId(after)).to.equal(computeMetadataId(before));
    const withLinks = validateReserveMetadataPayload({ ...base, telegramUrl: "https://t.me/a", xUrl: "https://x.com/a" });
    expect(Object.keys(withLinks).slice(-3)).to.deep.equal(["youtubeChannelUrl", "xUrl", "telegramUrl"]);
    expect(() => validateReserveMetadataPayload({ ...base, xUrl: "http://x.com/a" })).to.throw(/X link must be a permanent HTTPS URL/);
  });

  it("reads the links back on Solana and Robinhood Chain, HTTPS only", () => {
    const json = { name: "Alpha", ticker: "ALP", xUrl: "https://x.com/a", telegramUrl: "javascript:alert(1)", youtubeChannelUrl: "https://www.youtube.com/@a" };
    const sol = parseReserveMetadataUri(`data:application/json,${encodeURIComponent(JSON.stringify(json))}`)!;
    expect(sol.xUrl).to.equal("https://x.com/a");
    expect(sol.youtubeChannelUrl).to.equal("https://www.youtube.com/@a");
    expect(sol).to.not.have.property("telegramUrl");
    const evm = parseEvmReserveMeta(json)!;
    expect(evm.xUrl).to.equal("https://x.com/a");
    expect(evm).to.not.have.property("telegramUrl");
  });

  it("renders the icon row beside the ticker on both Reserve pages", () => {
    const sol = readFileSync("src/merge/pages/DTRDetail.tsx", "utf8");
    const evm = readFileSync("src/merge/components/robinhood/RobinhoodReserveDetail.tsx", "utf8");
    expect(sol).to.match(/\{dtr\.ticker\}<\/Badge>\s*<ReserveSocialLinks[\s\S]*?contractAddress=\{dtr\.onChain\?\.reserveTokenMint\}/);
    expect(evm).to.match(/\{snap\.symbol\}<\/Badge>\s*<ReserveSocialLinks[^>]*contractAddress=\{address\}/);
  });
});
