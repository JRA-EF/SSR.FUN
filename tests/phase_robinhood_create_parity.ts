// Launching a Reserve on Robinhood Chain asks for the same identity fields
// as on Solana, stores them the same way, and the chain choice is the first
// field of step 1 -- not chrome standing above every step (DEC-0216).
//
// Three layers, all offline:
//   1. lib/reserve-metadata/payload.ts -- the shared metadata store now
//      carries the header image and the creator's YouTube links.
//   2. src/merge/lib/evmReserveMeta.ts -- a reserve's on-chain `mandate` is
//      recognised as (and only as) this app's metadata URL.
//   3. Source contracts -- the picker lives in step 1 of both wizards, the
//      Robinhood form has every Solana identity field, the API routes and
//      middleware allowlist exist, and the mandate is what gets deployed.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_robinhood_create_parity.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateReserveMetadataPayload, computeMetadataId, MAX_IMAGE_URL_BYTES } from "../lib/reserve-metadata/payload";
import { metadataIdFromMandate, mandateForMetadataId, parseEvmReserveMeta, ROBINHOOD_METADATA_PATH } from "../src/merge/lib/evmReserveMeta";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const BASE = { name: "Strategic Tech", ticker: "TECH", description: "Big tech, in kind.", category: "Tech", buyTaxPct: 0, sellTaxPct: 0 };
const IMG = "https://ssr.fun/api/robinhood/reserve-image?id=0123456789abcdef";

describe("reserve metadata payload -- header image and creator links", () => {
  it("stores headerImageUrl / youtubeChannelUrl / youtubeFeaturedVideoUrl when given as HTTPS", () => {
    const p = validateReserveMetadataPayload({
      ...BASE,
      imageUrl: IMG,
      headerImageUrl: IMG,
      youtubeChannelUrl: "https://www.youtube.com/@ssrfun",
      youtubeFeaturedVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(p.headerImageUrl).to.equal(IMG);
    expect(p.youtubeChannelUrl).to.equal("https://www.youtube.com/@ssrfun");
    expect(p.youtubeFeaturedVideoUrl).to.equal("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("OMITS each link when absent or blank -- a payload minted before these fields existed keeps its exact bytes and id", () => {
    const before = computeMetadataId({ ...BASE });
    const p = validateReserveMetadataPayload({ ...BASE, headerImageUrl: "", youtubeChannelUrl: "   ", youtubeFeaturedVideoUrl: undefined });
    expect(p).to.not.have.property("headerImageUrl");
    expect(p).to.not.have.property("youtubeChannelUrl");
    expect(p).to.not.have.property("youtubeFeaturedVideoUrl");
    expect(computeMetadataId(p)).to.equal(before);
  });

  it("serialises the new keys in one fixed order after imageUrl, so the content-addressed id is caller-independent", () => {
    const a = validateReserveMetadataPayload({ ...BASE, youtubeFeaturedVideoUrl: "https://youtu.be/dQw4w9WgXcQ", headerImageUrl: IMG, imageUrl: IMG, youtubeChannelUrl: "https://www.youtube.com/@x" });
    const b = validateReserveMetadataPayload({ youtubeChannelUrl: "https://www.youtube.com/@x", imageUrl: IMG, ...BASE, headerImageUrl: IMG, youtubeFeaturedVideoUrl: "https://youtu.be/dQw4w9WgXcQ" });
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
    expect(Object.keys(a).slice(-4)).to.deep.equal(["imageUrl", "headerImageUrl", "youtubeChannelUrl", "youtubeFeaturedVideoUrl"]);
  });

  it("rejects a non-HTTPS link for any of the three, naming the field in plain words", () => {
    expect(() => validateReserveMetadataPayload({ ...BASE, headerImageUrl: "data:image/png;base64,AAAA" })).to.throw(/header image link must be a permanent HTTPS URL/);
    expect(() => validateReserveMetadataPayload({ ...BASE, youtubeChannelUrl: "javascript:alert(1)" })).to.throw(/YouTube channel link must be a permanent HTTPS URL/);
    expect(() => validateReserveMetadataPayload({ ...BASE, youtubeFeaturedVideoUrl: "http://youtube.com/watch?v=x" })).to.throw(/featured video link must be a permanent HTTPS URL/);
  });

  it("bounds each link the same way as imageUrl", () => {
    const long = `https://ssr.fun/${"a".repeat(MAX_IMAGE_URL_BYTES)}`;
    expect(() => validateReserveMetadataPayload({ ...BASE, headerImageUrl: long })).to.throw(/exceeds the/);
  });
});

describe("evmReserveMeta -- the on-chain mandate as the metadata pointer", () => {
  it("recognises this app's metadata URL on any host, lower-casing the id", () => {
    expect(metadataIdFromMandate("https://ssr.fun/api/robinhood/reserve-metadata?id=0123456789ABCDEF")).to.equal("0123456789abcdef");
    expect(metadataIdFromMandate("https://strategic-super-reserve.fun/api/robinhood/reserve-metadata?id=0123456789abcdef")).to.equal("0123456789abcdef");
    expect(metadataIdFromMandate("  https://ssr.fun/api/robinhood/reserve-metadata?id=0123456789abcdef  ")).to.equal("0123456789abcdef");
  });

  it("returns null for a plain-sentence mandate, a Solana-cluster path, a malformed id, or a non-HTTPS scheme", () => {
    expect(metadataIdFromMandate("Strategic Equity Reserve")).to.equal(null);
    expect(metadataIdFromMandate("https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef")).to.equal(null);
    expect(metadataIdFromMandate("https://ssr.fun/api/robinhood/reserve-metadata?id=zz")).to.equal(null);
    expect(metadataIdFromMandate("http://ssr.fun/api/robinhood/reserve-metadata?id=0123456789abcdef")).to.equal(null);
    expect(metadataIdFromMandate("")).to.equal(null);
    expect(metadataIdFromMandate(null)).to.equal(null);
  });

  it("round-trips: the mandate the Create form writes is the one loadReserve recognises", () => {
    const m = mandateForMetadataId("https://ssr.fun", "0123456789abcdef");
    expect(m).to.equal(`https://ssr.fun${ROBINHOOD_METADATA_PATH}?id=0123456789abcdef`);
    expect(metadataIdFromMandate(m)).to.equal("0123456789abcdef");
  });

  it("parses a served payload (app keys or the wallet-facing symbol/image spellings) and keeps only HTTPS links", () => {
    const meta = parseEvmReserveMeta({
      name: "Strategic Tech",
      symbol: "TECH",
      description: "Big tech.",
      category: "Tech",
      image: IMG,
      headerImageUrl: "javascript:alert(1)",
      youtubeChannelUrl: "https://www.youtube.com/@ssrfun",
      youtubeFeaturedVideoUrl: "data:text/html,x",
    });
    expect(meta).to.not.equal(null);
    expect(meta!.ticker).to.equal("TECH");
    expect(meta!.imageUrl).to.equal(IMG);
    expect(meta!).to.not.have.property("headerImageUrl");
    expect(meta!.youtube).to.deep.equal({ channelUrl: "https://www.youtube.com/@ssrfun" });
  });

  it("refuses a document without a name or ticker, and non-objects", () => {
    expect(parseEvmReserveMeta({ description: "x" })).to.equal(null);
    expect(parseEvmReserveMeta("nope")).to.equal(null);
    expect(parseEvmReserveMeta(null)).to.equal(null);
  });
});

describe("the chain choice is the first field of step 1, not page chrome", () => {
  it("LaunchShell no longer renders a picker slot", () => {
    const shell = read("src/merge/components/LaunchHero.tsx");
    expect(shell).to.not.include("chainPicker");
  });

  it("both wizards render the picker inside the Identity card content", () => {
    for (const path of ["src/merge/pages/CreateDTR.tsx", "src/merge/components/robinhood/RobinhoodCreateForm.tsx"]) {
      const src = read(path);
      const identity = src.indexOf("Reserve Identity");
      expect(identity, `${path} has the Identity step`).to.be.greaterThan(-1);
      const slot = src.indexOf("{chainPicker && ", identity);
      expect(slot, `${path} renders the picker after the Identity heading`).to.be.greaterThan(identity);
      // ...and before the first identity field.
      expect(slot).to.be.lessThan(src.indexOf("Profile Picture (optional)", identity));
      expect(src.slice(identity, slot)).to.include("<CardContent");
      // Not passed to the shell any more.
      expect(src).to.not.match(/<LaunchShell[^>]*chainPicker=/);
    }
  });

  it("the Solana wallet gate keeps a (centred) chooser so a visitor without a Solana wallet can still reach Robinhood Chain", () => {
    const src = read("src/merge/pages/CreateDTR.tsx");
    const gate = src.indexOf("Connect Wallet<br />to Deploy");
    expect(src.indexOf("gateChainPicker &&", gate)).to.be.greaterThan(gate);
    expect(read("src/merge/pages/CreateReserve.tsx")).to.include("gateChainPicker={gatePicker}");
  });
});

describe("the Robinhood form asks for every Solana identity field and stores the profile the same way", () => {
  const form = read("src/merge/components/robinhood/RobinhoodCreateForm.tsx");

  it("has the same identity fields, in the same order", () => {
    const labels = ["Profile Picture (optional)", "Reserve Name", ">Ticker<", ">Category<", ">Description<", "YouTube channel", "Featured video link", "Header image"];
    let last = form.indexOf("Reserve Identity");
    for (const label of labels) {
      const at = form.indexOf(label, last);
      expect(at, `${label} present, in order`).to.be.greaterThan(last);
      last = at;
    }
    expect(form, "the same ticker rule as Solana").to.include("TICKER_MAX_LENGTH");
    expect(form, "the same category list as Solana").to.include("RESERVE_CATEGORIES");
  });

  it("uploads pictures and the payload to the Robinhood store routes, and deploys with the payload URL as the mandate", () => {
    expect(form).to.include('uploadReserveImage(origin, profileImageDataUrl, "robinhood")');
    expect(form).to.include('"robinhood")');
    expect(form).to.include("fitHeaderImageDataUrl(headerImage)");
    expect(form).to.include('uploadReserveMetadata(origin, input, "robinhood")');
    expect(form).to.include("owner: ownerAddr, mandate }");
    const evm = read("src/merge/lib/evmReserve.ts");
    expect(evm).to.include("mandate: input.mandate,");
    expect(evm).to.not.include("mandate: input.name,");
    expect(read("src/merge/lib/evmChain.ts")).to.include('name: "mandate"');
  });

  it("the store routes exist as the same generic store, and their GETs are public reads", () => {
    const meta = read("api/robinhood/reserve-metadata.ts");
    expect(meta).to.include("../../lib/reserve-metadata/payload");
    expect(meta).to.include("../../lib/reserve-metadata/db");
    expect(meta).to.include("insert into reserve_metadata");
    const img = read("api/robinhood/reserve-image.ts");
    expect(img).to.include("../../lib/reserve-image/payload");
    expect(img).to.include("insert into reserve_image");
    expect(img).to.not.include("/api/mainnet/");
    const mw = read("middleware.ts");
    const allow = mw.slice(mw.indexOf("const PUBLIC_READ_API_PATHS"), mw.indexOf("function isPublicReadApi"));
    expect(allow).to.include("'/api/robinhood/reserve-metadata'");
    expect(allow).to.include("'/api/robinhood/reserve-image'");
  });

  it("the directory and the reserve page read the profile back (description, category, pictures, videos)", () => {
    const dir = read("src/merge/lib/directoryEntry.ts");
    expect(dir).to.include("avatarImageUrl: meta?.imageUrl");
    expect(dir).to.include("normalizeReserveCategory(meta?.category)");
    const page = read("src/merge/components/robinhood/RobinhoodReserveDetail.tsx");
    expect(page).to.include("meta?.headerImageUrl");
    expect(page).to.include("meta?.imageUrl");
    expect(page).to.include("From the Creator");
    expect(read("src/merge/pages/Discover.tsx"), "Robinhood categories are filterable").to.include("r.meta?.category");
  });
});
