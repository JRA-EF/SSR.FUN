// DEC-0228 (2026-10-06): mandatory Mint / Redeem / Buy / Sell terminology and
// the Buy/Sell tax hold. Spec: docs/protocol/TERMINOLOGY.md.
//
//   Mint   = getting Reserve Tokens from SSR.fun in the app.
//   Redeem = handing them back to SSR.fun in the app.
//   Buy / Sell = STRICTLY secondary-market trades between holders.
//   Buy tax / Sell tax = secondary-market only, ON HOLD, never on a mint or redemption.
//
// If this test fails because new UI copy says "Buy"/"Sell"/"purchase" for the
// in-app flow, fix the copy, not the test. Only add an allowlist entry for text
// that genuinely describes secondary markets (DEX trading), with a reason.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { TRADE_TAX_ON_HOLD } from "../lib/mainnet/tradeTaxHold";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const WORD = /(?<![-\w])(Buy|Sell|Buying|Selling|Bought|Sold|Buys|Sells|buy|sell|buying|selling|bought|sold|buys|sells|purchase|Purchase|purchases|purchased|Purchased)(?![-\w])/g;

/** Lines allowed to say buy/sell, each for a stated reason. Matched as substrings of the trimmed line. */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  { file: "src/docs/content/AddLiquidity.tsx", contains: "traders can buy on one side and sell on the other", why: "secondary market (DEX pool arbitrage)" },
  { file: "src/docs/content/AddLiquidity.tsx", contains: "Holders who buy it there", why: "secondary market (PumpSwap)" },
  { file: "src/docs/content/ReserveTokensOnDexes.tsx", contains: "bought on an exchange", why: "secondary market (DEX)" },
  { file: "src/pages/legal/Privacy.tsx", contains: "do not sell your information", why: "privacy wording, unrelated to Reserve Tokens" },
  { file: "src/merge/pages/CreateDTR.tsx", contains: "secondary-market Buys", why: "the Buy tax slider explains it is secondary-market only" },
  { file: "src/merge/pages/CreateDTR.tsx", contains: "secondary-market Sells", why: "the Sell tax slider explains it is secondary-market only" },
  { file: "src/merge/lib/multiAssetSellClient.ts", contains: "% Sell tax`", why: "label of the parked tax transaction (never built while TRADE_TAX_ON_HOLD)" },
  { file: "src/merge/pages/DTRDetail.tsx", contains: "Paying the Manager's Sell tax", why: "progress text of the parked tax step (never emitted while TRADE_TAX_ON_HOLD)" },
];

/** Every line under src/ that uses buy/sell/purchase in user-visible text (string literals, JSX text). */
function offendingLines(): string[] {
  const hits: string[] = [];
  for (const abs of walk(path.join(ROOT, "src"))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    // Blank out block comments but keep line numbers.
    const src = fs.readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    src.split(/\r?\n/).forEach((raw, i) => {
      if (/^\s*\/\//.test(raw)) return; // line comment
      const line = raw.replace(/(^|\s)\/\/.*$/, ""); // trailing comment
      // Developer-only text and runtime-matched literals are code, not copy.
      if (/console\.|\blog\(|\.includes\(|^\s*import /.test(line)) return;
      WORD.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WORD.exec(line))) {
        const pre = line[m.index - 1];
        const post = line[m.index + m[0].length];
        if ((pre === '"' && post === '"') || (pre === "'" && post === "'")) continue; // value literal, e.g. tab value "buy"
        if (/^\s*Tax/.test(line.slice(m.index + m[0].length))) continue; // "Buy Tax" / "Sell Tax" are the correct names
        const trimmed = line.trim();
        if (ALLOWED.some((a) => a.file === rel && trimmed.includes(a.contains))) break;
        hits.push(`${rel}:${i + 1}: ${trimmed.slice(0, 160)}`);
        break;
      }
    });
  }
  return hits;
}

describe("DEC-0228 terminology: the in-app flow is Mint / Redeem, never Buy / Sell", () => {
  it("no user-facing copy under src/ calls minting or redeeming buying or selling", () => {
    const hits = offendingLines();
    expect(hits, `Use "Mint"/"Redeem" (docs/protocol/TERMINOLOGY.md). Offending lines:\n${hits.join("\n")}`).to.deep.equal([]);
  });

  it("every allowlist entry still matches a real line (no stale exemptions)", () => {
    for (const a of ALLOWED) {
      expect(read(a.file), `${a.file} no longer contains "${a.contains}" -- remove the entry`).to.include(a.contains);
    }
  });

  it("the Reserve page labels its tabs and activity Mint / Redeem", () => {
    const page = read("src/merge/pages/DTRDetail.tsx");
    expect(page).to.match(/<TabsTrigger value="buy"[^>]*>\s*Mint\s*<\/TabsTrigger>/);
    expect(page).to.match(/<TabsTrigger value="sell"[^>]*>\s*Redeem\s*<\/TabsTrigger>/);
    expect(page).to.include('"Mint confirmed"');
    expect(page).to.include('"Redeem confirmed"');
    expect(page).to.not.match(/>\s*(Buy|Sell)\s*</);
  });

  it("the spec and both agent instruction files carry the rule", () => {
    const spec = read("docs/protocol/TERMINOLOGY.md");
    expect(spec).to.include("Mint = getting Reserve Tokens from SSR.fun in the app");
    expect(spec).to.include("strictly secondary-market trades");
    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      const s = read(f);
      expect(s, f).to.include("docs/protocol/TERMINOLOGY.md");
      expect(s, f).to.match(/STRICTLY secondary-market|Strictly secondary-market/);
      expect(s, f).to.include("DEC-0228");
    }
  });
});

describe("DEC-0228 Buy/Sell tax hold: never charged on a mint or a redemption", () => {
  it("the hold flag is on", () => {
    expect(TRADE_TAX_ON_HOLD).to.equal(true);
  });

  for (const endpoint of ["api/mainnet/build-buy.ts", "api/mainnet/build-sell.ts"]) {
    it(`${endpoint} gives the builder no tax lookup while the hold is on`, () => {
      const src = read(endpoint);
      expect(src).to.include("...(TRADE_TAX_ON_HOLD ? {} : { lookupTradeTax })");
      // No other way of handing the builder a tax lookup.
      expect(src).to.not.match(/^\s*lookupTradeTax,\s*$/m);
      expect(src).to.not.match(/lookupTradeTax:\s/);
    });
  }

  it("the Reserve page's Mint and Redeem panels show no Buy/Sell tax", () => {
    const page = read("src/merge/pages/DTRDetail.tsx");
    expect(page).to.not.include("managerBuyTaxPct");
    expect(page).to.not.include("managerSellTaxPct");
  });
});
