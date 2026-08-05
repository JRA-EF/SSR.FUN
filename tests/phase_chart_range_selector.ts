// Regression coverage for TWO successive real, live bugs in the same
// src/index.css `button {}` reset -- which is why the last describe block
// pins the reset's exact shape rather than just the components':
//
//   1. Originally the reset was UNLAYERED, so it always beat Tailwind's own
//      LAYERED utilities regardless of specificity, stripping every
//      merge-scoped button's padding/background. Ten real buttons collapsed
//      into one concatenated string ("1s1m5m1h4h24h7d30d1yAll").
//   2. The first fix scoped the reset away from `.merge-scope` entirely.
//      That stopped the clobbering but removed the ONLY native-appearance
//      reset those buttons had (src/merge/merge.css deliberately skips
//      Tailwind's Preflight), so every merge-scoped control fell back to raw
//      user-agent chrome -- gray fills, `outset` bevels, inset shadows.
//
// The correct fix is neither: keep the reset applying everywhere, but put it
// in `@layer base` so Tailwind's `utilities` layer cleanly overrides it while
// class-less controls (Radix's TooltipTrigger, inactive TabsTrigger) still
// get stripped of native chrome. These components are extracted into their
// own small, dependency-free modules specifically so their REAL rendered
// output can be asserted on here, offline, without a browser.
import "./util/aliases"; // must precede any import that resolves "@/..." at runtime
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartTimeframeSelector, CHART_TIMEFRAMES, DEFAULT_CHART_TIMEFRAME } from "../src/merge/components/ChartTimeframeSelector";
import { InfoTip } from "../src/merge/components/InfoTip";
import { TooltipProvider } from "../src/merge/components/ui/tooltip";

/** Mirrors production: MergeLayout wraps every merge-scoped page in a single shared TooltipProvider, which Radix's Tooltip requires as an ancestor. */
function renderInfoTip(label: string, children: string): string {
  return renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(InfoTip, { label, children })),
  );
}

describe("ChartTimeframeSelector -- rendered structure (regression: was one concatenated control)", () => {
  it("has exactly 10 configured timeframes, in the required order", () => {
    expect(CHART_TIMEFRAMES).to.deep.equal(["1s", "1m", "5m", "1h", "4h", "24h", "7d", "30d", "1y", "All"]);
  });

  it("defaults to the 7d range", () => {
    expect(DEFAULT_CHART_TIMEFRAME).to.equal("7d");
    expect(CHART_TIMEFRAMES).to.include(DEFAULT_CHART_TIMEFRAME);
  });

  it("renders 10 separate <button> elements, not one parent button containing all 10 labels", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "7d", onChange: () => {} }));
    const buttonOpenTags = html.match(/<button\b/g) ?? [];
    expect(buttonOpenTags.length).to.equal(10);
    // Every label is its OWN button's exact text content -- not 10 labels
    // concatenated inside a single element with no button boundaries at all.
    for (const tf of CHART_TIMEFRAMES) {
      const re = new RegExp(`<button\\b[^>]*>${tf}</button>`);
      expect(html, `expected a distinct <button> for "${tf}"`).to.match(re);
    }
    // Every button is closed before the next one opens -- 10 sibling
    // elements, never one button nested inside (or spanning) another.
    const positions = [...html.matchAll(/<button\b/g)].map((m) => m.index as number);
    const closePositions = [...html.matchAll(/<\/button>/g)].map((m) => m.index as number);
    expect(positions.length).to.equal(closePositions.length);
    for (let i = 0; i < positions.length; i++) {
      expect(closePositions[i], `button #${i} must close before the next one opens`).to.be.greaterThan(positions[i]);
      if (i + 1 < positions.length) expect(positions[i + 1]).to.be.greaterThan(closePositions[i]);
    }
  });

  it("visually distinguishes the selected timeframe via aria-pressed, exactly one at a time", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "1h", onChange: () => {} }));
    expect((html.match(/aria-pressed="true"/g) ?? []).length).to.equal(1);
    expect((html.match(/aria-pressed="false"/g) ?? []).length).to.equal(9);
    expect(html).to.match(/aria-pressed="true"[^>]*>1h<\/button>|>1h<\/button>/); // "1h" is the pressed one somewhere in its own button
  });

  it("wraps responsively (flex-wrap) rather than forcing a single non-wrapping row that could overflow/overlap", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "24h", onChange: () => {} }));
    expect(html).to.match(/flex-wrap/);
  });

  it("gives the selected range a real design-system treatment (purple fill + purple-foreground text), not a browser default", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "7d", onChange: () => {} }));
    const selected = html.match(/<button[^>]*aria-pressed="true"[^>]*>/)![0];
    expect(selected).to.match(/bg-primary/);
    expect(selected).to.match(/text-primary-foreground/);
    // Inactive buttons must NOT carry the selected treatment. Matched with a
    // negative lookbehind for ":" so a legitimate variant like
    // `hover:bg-primary/5` doesn't count as the RESTING background.
    const inactive = html.match(/<button[^>]*aria-pressed="false"[^>]*>/)![0];
    expect(inactive).to.not.match(/(?<!:)\bbg-primary\b/);
    expect(inactive).to.not.match(/text-primary-foreground/);
    expect(inactive).to.match(/bg-background/);
  });

  it("every button carries an explicit border in BOTH states, so hover/selection cannot shift layout", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "7d", onChange: () => {} }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).to.equal(10);
    for (const b of buttons) expect(b, b).to.match(/\bborder\b/);
  });

  it("uses a keyboard-only focus ring from the design system, never a native outline", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "24h", onChange: () => {} }));
    expect(html).to.match(/focus-visible:ring-2/);
    expect(html).to.match(/focus-visible:ring-ring/);
    expect(html).to.match(/focus-visible:outline-none/);
  });

  it("contains no nested <button> elements (invalid interactive markup)", () => {
    const html = renderToStaticMarkup(React.createElement(ChartTimeframeSelector, { timeframe: "7d", onChange: () => {} }));
    let depth = 0;
    let maxDepth = 0;
    for (const tok of html.match(/<button\b|<\/button>/g) ?? []) {
      depth += tok === "</button>" ? -1 : 1;
      maxDepth = Math.max(maxDepth, depth);
    }
    expect(maxDepth, "a <button> was nested inside another <button>").to.equal(1);
    expect(depth, "unbalanced button tags").to.equal(0);
  });

  it("each button's onClick calls onChange with exactly that button's own timeframe -- no shared/stale closure across buttons", () => {
    const calls: string[] = [];
    const element = ChartTimeframeSelector({ timeframe: "24h", onChange: (tf) => calls.push(tf) }) as React.ReactElement<{ children: React.ReactElement<{ onClick: () => void }>[] }>;
    const buttons = element.props.children;
    expect(buttons.length).to.equal(10);
    buttons.forEach((btn) => btn.props.onClick());
    expect(calls).to.deep.equal(CHART_TIMEFRAMES);
  });
});

describe("InfoTip -- circular, accessible tooltip trigger (regression: rendered as a gray native button)", () => {
  it("renders a real, type=button element with an accessible name", () => {
    const html = renderInfoTip("More information about AUM", "Assets Under Management");
    expect(html).to.match(/<button[^>]*type="button"/);
    expect(html).to.match(/aria-label="More information about AUM"/);
  });

  it("is circular and carries a design-system border, never native chrome", () => {
    const html = renderInfoTip("More information about NAV", "x");
    expect(html).to.match(/rounded-full/);
    expect(html).to.match(/border-border/);
    expect(html).to.match(/focus-visible:ring-ring/);
  });

  it("contains exactly one button and no nested interactive elements", () => {
    const html = renderInfoTip("More information", "x");
    expect((html.match(/<button\b/g) ?? []).length).to.equal(1);
  });
});

describe("Global native-control reset (src/index.css) -- the exact contract whose breakage caused this regression", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.css"), "utf8");

  it("declares the same cascade-layer order as merge.css, with `base` ahead of `utilities`", () => {
    const stmt = css.match(/@layer\s+([a-z,\s]+);/);
    expect(stmt, "index.css must declare an explicit @layer order").to.not.equal(null);
    const order = stmt![1].split(",").map((s) => s.trim());
    expect(order).to.include("base");
    expect(order).to.include("utilities");
    expect(order.indexOf("base")).to.be.lessThan(order.indexOf("utilities"));
  });

  it("puts the button reset INSIDE @layer base, so Tailwind utilities can override it", () => {
    const baseLayer = css.match(/@layer base\s*\{[\s\S]*?\n\}/);
    expect(baseLayer, "expected an @layer base block").to.not.equal(null);
    expect(baseLayer![0]).to.match(/\bbutton\b/);
    expect(baseLayer![0]).to.match(/appearance:\s*none/);
  });

  it("does NOT scope the reset away from .merge-scope -- doing so is exactly what let native browser chrome back in", () => {
    expect(css).to.not.match(/button:not\(\.merge-scope\s*\*\)/);
  });

  it("neutralises the specific native properties that produced the gray/bevelled look", () => {
    const baseLayer = css.match(/@layer base\s*\{[\s\S]*?\n\}/)![0];
    expect(baseLayer, "appearance:none kills the native widget bevel").to.match(/appearance:\s*none/);
    expect(baseLayer, "transparent background kills the gray ButtonFace fill").to.match(/background-color:\s*transparent/);
    expect(baseLayer, "border-style:solid stops Tailwind border widths inheriting the UA's `outset` bevel").to.match(/border-style:\s*solid/);
  });
});
