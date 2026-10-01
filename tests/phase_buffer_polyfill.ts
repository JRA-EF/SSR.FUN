// The app's Buffer/global polyfill must run before ANY module script: when
// the bundler splits @solana/web3.js (and borsh, which reads the Buffer
// global at load) into a chunk shared with a lazy page, that chunk is
// evaluated before main's own body, so a polyfill line inside main.tsx is
// too late and the whole app dies with a blank page (2026-10-01, DEC-0220).
// index.html therefore carries the polyfill as classic scripts, and the
// polyfill file is the `buffer` package built as an IIFE under a known name.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_buffer_polyfill.ts
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("Buffer polyfill boots before the app bundle", () => {
  it("index.html loads public/assets/polyfill-buffer.js and assigns window.Buffer as classic scripts, before the module entry", () => {
    const html = read("index.html");
    const poly = html.indexOf('<script src="/assets/polyfill-buffer.js"></script>');
    const assign = html.indexOf("window.Buffer = window.Buffer || SSRBufferPolyfill.Buffer;");
    const entry = html.indexOf('<script type="module" src="/src/main.tsx"></script>');
    expect(poly, "polyfill script present").to.be.greaterThan(-1);
    expect(assign, "assignment present").to.be.greaterThan(poly);
    expect(entry, "module entry present").to.be.greaterThan(assign);
    expect(html.slice(poly, entry)).to.not.include('type="module"');
    expect(html).to.include("window.global = window.global || window;");
  });

  it("public/assets/polyfill-buffer.js is a self-contained IIFE exposing SSRBufferPolyfill.Buffer that behaves like Buffer", () => {
    const src = read("public/assets/polyfill-buffer.js");
    expect(src).to.not.match(/\bimport\s*[({"']|\brequire\(/);
    const ctx: Record<string, unknown> = {};
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const B = (ctx.SSRBufferPolyfill as { Buffer: { from: (s: string) => { toString: (e: string) => string }; alloc: (n: number) => { length: number } } }).Buffer;
    expect(typeof B).to.equal("function");
    expect(B.from("hi").toString("hex")).to.equal("6869");
    expect(B.alloc(4).length).to.equal(4);
  });

  it("src/polyfills.ts still exists for dev and tests, and stays the first import of main.tsx", () => {
    expect(read("src/main.tsx").split(/\r?\n/)[0]).to.equal("import './polyfills'");
    expect(read("src/polyfills.ts")).to.include('from "buffer"');
  });
});
