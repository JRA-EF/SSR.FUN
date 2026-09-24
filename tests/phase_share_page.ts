// The crawlable Reserve share page (DEC-0200).
//
// QA 2026-09-11 asked for human-readable Reserve URLs, Reserve-specific social
// cards, and SEO. The blocking fact found while planning: the app is a HASH
// router, so a crawler asking for ssr.fun/#/dtr/mainnet-beta-24 sends the
// server only "/" -- a fragment never leaves the browser. Renaming that URL
// could never have produced a card. /r/<address> is a real path the server
// sees, and the Creator's call was to key it by the pool address rather than a
// name-derived slug, which removes slugs, collisions and backfill entirely.
import { expect } from "chai";
import {
  buildSharePageData,
  clamp,
  escapeHtml,
  isPlausibleAddress,
  renderSharePage,
  renderShareNotFound,
  resolveShareAddress,
  type ShareSnapshot,
} from "../lib/share/resolveReserve";

const POOL = "C6xZ6bPFqYknZawZexW1kBfAehL5qCXQJHmFkBNQWedP"; // Reserve 24, live
const MINT = "AypyRkHVNBF37xvZvnS51P7j3FtUYjEDnEmLbMbH6wMC"; // its Reserve Token
const ORIGIN = "https://ssr.fun";

const snapshot: ShareSnapshot = {
  reserves: [
    { reserveId: "24", reserve: POOL, reserveTokenMint: MINT, status: "active" },
    { reserveId: "23", reserve: "HMHUP6e1iY83UJp1CN9gCMh4JXgQF2y3RSZUgfHw36jk", reserveTokenMint: "9ndfzaE5zZ9Uz222oW4Fm73CJ6cq8JxDzZ5qg1KTbZEw" },
  ],
  metadataByReserve: {
    "24": {
      name: "Strategic Solana Reserve",
      ticker: "SOLSSR",
      description: "A Solana ecosystem reserve.",
      imageUrl: "https://ssr.fun/api/mainnet/reserve-image?id=65efa2d6c39b11f4",
    },
  },
};

describe("share address resolution", () => {
  it("resolves the POOL address as canonical", () => {
    const r = resolveShareAddress(snapshot, POOL);
    expect(r.kind).to.equal("canonical");
    if (r.kind === "canonical") expect(r.reserve.reserveId).to.equal("24");
  });

  it("resolves the Reserve Token MINT by redirecting to the pool address -- either address a user copied works", () => {
    const r = resolveShareAddress(snapshot, MINT);
    expect(r.kind).to.equal("redirect");
    if (r.kind === "redirect") expect(r.to).to.equal(POOL);
  });

  it("refuses an address that matches no Reserve -- we never render a card for a stranger's account", () => {
    expect(resolveShareAddress(snapshot, "So11111111111111111111111111111111111111112").kind).to.equal("not-found");
  });

  it("refuses anything that is not a plausible base58 address, without touching the snapshot", () => {
    for (const bad of ["", "../../etc/passwd", "<script>", "0OIl", "short", "mainnet-beta-24", `${POOL}${POOL}`]) {
      expect(isPlausibleAddress(bad), bad).to.equal(false);
      expect(resolveShareAddress(snapshot, bad).kind, bad).to.equal("not-found");
    }
    expect(isPlausibleAddress(POOL)).to.equal(true);
  });
});

describe("share page data", () => {
  it("titles the card with the Reserve's real name and ticker, and points canonical at the pool address", () => {
    const d = buildSharePageData(ORIGIN, snapshot.reserves![0], snapshot.metadataByReserve!["24"]);
    expect(d.title).to.equal("Strategic Solana Reserve (SOLSSR)");
    expect(d.canonicalUrl).to.equal(`${ORIGIN}/r/${POOL}`);
    expect(d.appUrl).to.equal(`${ORIGIN}/#/dtr/24`);
    expect(d.mint).to.equal(MINT);
    expect(d.imageUrl).to.contain("reserve-image");
  });

  it("stays specific when metadata has not resolved -- the Reserve id and mint, never a generic app-wide title", () => {
    const d = buildSharePageData(ORIGIN, snapshot.reserves![1], null);
    expect(d.title).to.equal("Reserve 23");
    expect(d.description).to.contain("9ndfzaE5zZ9Uz222oW4Fm73CJ6cq8JxDzZ5qg1KTbZEw");
    expect(d.imageUrl).to.equal(null);
  });

  it("refuses a non-https image URL rather than emitting it into og:image", () => {
    const d = buildSharePageData(ORIGIN, snapshot.reserves![0], { name: "X", ticker: "X", imageUrl: "javascript:alert(1)" });
    expect(d.imageUrl).to.equal(null);
  });

  it("clamps a long description instead of pasting an essay into a meta tag", () => {
    const long = "word ".repeat(200);
    const d = buildSharePageData(ORIGIN, snapshot.reserves![0], { name: "X", ticker: "X", description: long });
    expect(d.description.length).to.be.at.most(200);
    expect(d.description.endsWith("...")).to.equal(true);
    expect(clamp("  a   b  ", 50)).to.equal("a b");
  });
});

describe("share page HTML", () => {
  const html = renderSharePage(buildSharePageData(ORIGIN, snapshot.reserves![0], snapshot.metadataByReserve!["24"]));

  it("emits the Reserve's own title, description, url and image as OpenGraph and Twitter tags", () => {
    expect(html).to.contain('<meta property="og:title" content="Strategic Solana Reserve (SOLSSR)"');
    expect(html).to.contain('<meta property="og:description" content="A Solana ecosystem reserve."');
    expect(html).to.contain(`<meta property="og:url" content="${ORIGIN}/r/${POOL}"`);
    expect(html).to.contain('<meta property="og:image"');
    expect(html).to.contain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).to.contain(`<link rel="canonical" href="${ORIGIN}/r/${POOL}"`);
  });

  it("sends a human onward into the hash app, so an existing deep link still lands where it pointed", () => {
    expect(html).to.contain(`url=${ORIGIN}/#/dtr/24`);
    expect(html).to.contain(`window.location.replace("${ORIGIN}/#/dtr/24")`);
  });

  it("falls back to a summary card when the Reserve has no picture", () => {
    const noImage = renderSharePage(buildSharePageData(ORIGIN, snapshot.reserves![1], null));
    expect(noImage).to.contain('<meta name="twitter:card" content="summary"');
    expect(noImage).to.not.contain("og:image");
  });

  it("escapes metadata into the markup -- a Reserve named with a tag can never inject one", () => {
    const evil = renderSharePage(
      buildSharePageData(ORIGIN, snapshot.reserves![0], { name: '</title><script>alert(1)</script>', ticker: '"onload="x' }),
    );
    expect(evil).to.not.contain("<script>alert(1)</script>");
    expect(evil).to.contain("&lt;script&gt;");
    expect(evil).to.not.contain('"onload="x');
    expect(escapeHtml(`<>&"'`)).to.equal("&lt;&gt;&amp;&quot;&#39;");
  });

  it("the not-found page is noindex and carries no Reserve claim at all", () => {
    const nf = renderShareNotFound(ORIGIN);
    expect(nf).to.contain('name="robots" content="noindex"');
    expect(nf).to.not.contain("og:image");
    expect(nf).to.not.contain(POOL);
  });
});
