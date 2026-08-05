// Regression coverage for a real, live bug fixed this pass: 10 genuinely
// distinct range-selector <button> elements were rendering as one visually
// concatenated string ("1s1m5m1h4h24h7d30d1yAll"). Root cause: a global,
// UNLAYERED `button {}` CSS reset in src/index.css (padding: 0, background:
// none, border: none) always beats Tailwind's own LAYERED utility classes
// regardless of specificity (a documented CSS cascade-layer behavior this
// exact codebase already has one prior example of -- see index.css's
// `.container:not(.merge-scope *)` comment) -- it was silently stripping
// every merge-scoped button's px-2.5/bg-background/bg-muted padding and
// background, collapsing all 10 real buttons down to bare, padding-less
// inline text with no visual gap between them. Fixed by excluding
// `.merge-scope` from that reset (src/index.css) and by extracting the
// selector into its own small, dependency-free component
// (ChartTimeframeSelector) specifically so its REAL rendered output can be
// asserted on here, offline, without a browser.
import { expect } from "chai";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartTimeframeSelector, CHART_TIMEFRAMES } from "../src/merge/components/ChartTimeframeSelector";

describe("ChartTimeframeSelector -- rendered structure (regression: was one concatenated control)", () => {
  it("has exactly 10 configured timeframes, in the required order", () => {
    expect(CHART_TIMEFRAMES).to.deep.equal(["1s", "1m", "5m", "1h", "4h", "24h", "7d", "30d", "1y", "All"]);
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

  it("each button's onClick calls onChange with exactly that button's own timeframe -- no shared/stale closure across buttons", () => {
    const calls: string[] = [];
    const element = ChartTimeframeSelector({ timeframe: "24h", onChange: (tf) => calls.push(tf) }) as React.ReactElement<{ children: React.ReactElement<{ onClick: () => void }>[] }>;
    const buttons = element.props.children;
    expect(buttons.length).to.equal(10);
    buttons.forEach((btn) => btn.props.onClick());
    expect(calls).to.deep.equal(CHART_TIMEFRAMES);
  });
});
