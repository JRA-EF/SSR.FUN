// Guard tests for the Reserve name/ticker/description profanity filter
// (packages/sdk/src/profanity.ts), shown inline by the Create forms and
// enforced by lib/reserve-metadata/payload.ts on every metadata write.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_profanity_filter.ts
import { expect } from "chai";
import { containsProfanity, findProfaneReserveField, PROFANITY_MESSAGE } from "../packages/sdk/src/profanity";
import { validateReserveMetadataPayload } from "../lib/reserve-metadata/payload";

describe("profanity filter -- blocks", () => {
  const blocked = [
    "fuck", "FUCK", "Fück Reserve", "f u c k", "F.U.C.K", "fuckcoin", "MotherFuckerReserve", "ph4ck you phuck",
    "shit", "Sh1t Basket", "bullshit index", "bitch", "a55", "ass", "dumbass fund", "cunt",
    "hatejews", "Hate Jews", "hate-jews", "h4te j3ws", "Kill the Jews", "heil hitler", "Sieg Heil", "white power",
    "1488", "KKK", "nazi reserve", "nigger", "n1gga", "faggot", "retard", "rape",
  ];
  for (const text of blocked) {
    it(`blocks ${JSON.stringify(text)}`, () => {
      expect(containsProfanity(text)).to.equal(true);
    });
  }
});

describe("profanity filter -- lets ordinary names through", () => {
  const clean = [
    "", "Solana Blue Chips", "Strategic Super Reserve", "BLUE", "Bass Reserve", "Class Act", "Digital Assets 2026",
    "Scunthorpe United Fund", "Raccoon Coins", "Tycoon Index", "Spicy Memes", "Grape Basket", "Saltwater Yield",
    "Therapeutic Biotech", "Cockpit Aviation", "Shiitake DAO", "Jewish Heritage Fund", "Jewel Box", "Analysis Reserve",
    "Essex Property", "Titan Index", "Cumulative Yield", "Compass", "Embassy Row", "Top 88", "rub itch",
    "Describe the strategy and focus of this reserve: large-cap SOL ecosystem tokens, rebalanced monthly.",
  ];
  for (const text of clean) {
    it(`allows ${JSON.stringify(text)}`, () => {
      expect(containsProfanity(text)).to.equal(false);
    });
  }
});

describe("findProfaneReserveField", () => {
  it("names the first failing field", () => {
    expect(findProfaneReserveField({ name: "Good Fund", ticker: "SHIT", description: "" })).to.equal("ticker");
    expect(findProfaneReserveField({ name: "Good Fund", ticker: "GOOD", description: "we hate jews" })).to.equal("description");
    expect(findProfaneReserveField({ name: "Good Fund", ticker: "GOOD", description: "blue chips" })).to.equal(null);
  });
});

describe("validateReserveMetadataPayload -- refuses profanity on write", () => {
  it("rejects a profane name, ticker or description with the user-facing message", () => {
    for (const body of [
      { name: "Fuck Fund", ticker: "GOOD", description: "", category: "" },
      { name: "Good Fund", ticker: "SHIT", description: "", category: "" },
      { name: "Good Fund", ticker: "GOOD", description: "hate jews", category: "" },
    ]) {
      expect(() => validateReserveMetadataPayload(body)).to.throw(PROFANITY_MESSAGE);
    }
  });

  it("still accepts a clean payload unchanged", () => {
    const p = validateReserveMetadataPayload({ name: "Solana Blue Chips", ticker: "BLUE", description: "Large caps.", category: "DeFi" });
    expect(p).to.deep.equal({ name: "Solana Blue Chips", ticker: "BLUE", description: "Large caps.", category: "DeFi" });
  });
});
