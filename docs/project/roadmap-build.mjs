// Builds the publishable copy of docs/project/ROADMAP.html by inlining the two
// brand images it references (the seal and the eagle hero art) as data URIs, so
// the page is self-contained when published as a Claude Artifact.
//
//   node docs/project/roadmap-build.mjs [outFile]
//
// Default output: docs/project/ROADMAP.built.html (git-ignored -- it is ~500 KB
// of base64; the editable source stays small).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "ROADMAP.html");
const out = process.argv[2] ?? path.join(here, "ROADMAP.built.html");

const inline = (rel, mime) => `data:${mime};base64,${fs.readFileSync(path.join(here, rel)).toString("base64")}`;

let html = fs.readFileSync(src, "utf8");
const swaps = [
  ["../../public/pnl/eagle-bull.jpg", inline("../../public/pnl/eagle-bull.jpg", "image/jpeg")],
  ["../../public/apple-touch-seal.png", inline("../../public/apple-touch-seal.png", "image/png")],
];
for (const [needle, dataUri] of swaps) {
  if (!html.includes(needle)) throw new Error(`ROADMAP.html no longer references ${needle}`);
  html = html.split(needle).join(dataUri);
}
html = html.replace(/^<!--[\s\S]*?-->\s*/, "");
fs.writeFileSync(out, html, "utf8");
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
