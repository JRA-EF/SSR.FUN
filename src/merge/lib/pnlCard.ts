// Shareable Reserve performance ("PnL") card -- pure canvas renderer.
//
// One card, one logic, for everyone who opens a Reserve (holders and the
// Manager alike): the Reserve's own all-time gain since launch, its three
// best-performing reserve assets, and who runs it. It deliberately does NOT
// draw any per-wallet position figures: a wallet's cost basis lives only in
// this browser's local store (DEC-0149/DEC-0158) and would be wrong on any
// other device, whereas the Reserve-level figures are the same on-chain-backed
// numbers the detail page already shows (calcAllTimeChangePct +
// calcAssetPnlPct), so a shared card can never claim more than the page does.
//
// Rendered with the plain 2D canvas API (no html-to-image style dependency):
// the output is a real PNG the user can download, copy, or paste into an X
// post. Fonts are the merge-scope families (Lexend Giga / Lexend / Geist
// Mono) already loaded by merge.css; the palette is the "Your Position"
// dark share-card ramp from DTRDetail (#070429 -> #1c1465 -> #2e3f92) so the
// card reads as SSR.fun even when it lands on someone else's timeline.

export const PNL_CARD_WIDTH = 1200;
export const PNL_CARD_HEIGHT = 630;

/** Mascot backgrounds -- the eagle art under public/pnl, downscaled to 1600px for the web. */
export type PnlCardBackgroundId = "rain" | "couch" | "bull";

export interface PnlCardBackground {
  id: PnlCardBackgroundId;
  /** Short, user-facing name for the chooser. */
  label: string;
  src: string;
  /** Point of interest in the art (0..1 of its width/height) -- the mascot. */
  focus: { x: number; y: number };
  /** Where that point should land in the card (0..1 of its width/height); the text column owns the left ~55%. */
  anchor: { x: number; y: number };
  /** Extra enlargement over a plain cover fit, so the mascot can sit right of the text without leaving a gap. */
  zoom: number;
}

export const PNL_CARD_BACKGROUNDS: PnlCardBackground[] = [
  { id: "rain", label: "Coin rain", src: "/pnl/eagle-rain.jpg", focus: { x: 0.5, y: 0.42 }, anchor: { x: 0.74, y: 0.5 }, zoom: 1.1 },
  { id: "couch", label: "Boardroom", src: "/pnl/eagle-couch.jpg", focus: { x: 0.66, y: 0.3 }, anchor: { x: 0.74, y: 0.42 }, zoom: 1.05 },
  { id: "bull", label: "Bull run", src: "/pnl/eagle-bull.jpg", focus: { x: 0.55, y: 0.22 }, anchor: { x: 0.72, y: 0.4 }, zoom: 1 },
];

export interface PnlCardTopAsset {
  symbol: string;
  /** Gain since the asset entered the Reserve, percent. Always > 0: the card only ever lists winners. */
  pnlPct: number;
}

export interface PnlCardData {
  name: string;
  ticker: string;
  logoUrl?: string;
  /** All-time change in Token Price since launch, percent; null while it isn't available yet. */
  allTimeChangePct: number | null;
  /** Current Token Price in USDC; null when pricing is unavailable. */
  tokenPriceUsdc: number | null;
  /** Up to three reserve assets with a POSITIVE gain since entry, best first; empty hides the section. */
  topAssets: PnlCardTopAsset[];
  /** Label printed next to "Manager" -- a truncated wallet today, a profile name once profiles ship. */
  managerLabel: string;
  /** Host shown in the footer (e.g. ssr.fun) -- where the reader can find the Reserve. */
  siteHost: string;
}

const INK = "#eef1fc";
const INK_MUTED = "#a7b2dc";
const PERIWINKLE = "#97abef";
const PERI_SOFT = "#c9d3f7";
const YELLOW = "#ede871";
const POSITIVE = "#4fe3a3";
const NEGATIVE = "#ff8598";
const NAVY = "#070429";

const DISPLAY = '"Lexend Giga", "Lexend", sans-serif';
const SANS = '"Lexend", sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin for the bundled art and the app-served Reserve logos; the
    // attribute only matters if a logo ever comes from elsewhere, in which
    // case a CORS-less host makes the load fail and we fall back to initials
    // rather than tainting the canvas (which would break PNG export).
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

async function ensureFonts(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const wanted = [
    `800 108px ${DISPLAY}`,
    `700 34px ${DISPLAY}`,
    `700 22px ${DISPLAY}`,
    `600 22px ${SANS}`,
    `400 18px ${SANS}`,
    `500 18px ${MONO}`,
    `500 13px ${MONO}`,
  ];
  // Best effort with a short cap: a font that never arrives must not block the card.
  await Promise.race([
    Promise.all(wanted.map((f) => document.fonts.load(f).catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

export function truncateWallet(address: string, head = 4, tail = 4): string {
  if (!address) return "";
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function formatSignedPct(pct: number, digits = 2): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

function pctColor(pct: number | null): string {
  if (pct === null) return INK_MUTED;
  if (pct > 0) return POSITIVE;
  if (pct < 0) return NEGATIVE;
  return PERI_SOFT;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, W: number, H: number, bg: PnlCardBackground) {
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight) * bg.zoom;
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  // Place the mascot at the anchor; never let the art pull away from the
  // right/top/bottom edges (a gap on the LEFT is fine -- the navy wash there
  // is nearly opaque anyway).
  let dx = W * bg.anchor.x - dw * bg.focus.x;
  let dy = H * bg.anchor.y - dh * bg.focus.y;
  dx = Math.max(Math.min(dx, W * 0.3), W - dw);
  dy = Math.min(0, Math.max(dy, H - dh));
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawAvatar(ctx: CanvasRenderingContext2D, logo: HTMLImageElement | null, ticker: string, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (logo) {
    const s = Math.max((r * 2) / logo.naturalWidth, (r * 2) / logo.naturalHeight);
    const w = logo.naturalWidth * s;
    const h = logo.naturalHeight * s;
    ctx.drawImage(logo, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = "rgba(151,171,239,0.22)";
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = PERI_SOFT;
    ctx.font = `700 ${Math.round(r * 0.8)}px ${DISPLAY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ticker.slice(0, 2).toUpperCase(), cx, cy + 1);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(201,211,247,0.55)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Draws the card into a fresh canvas and returns it. `scale` multiplies the
 * pixel size (2 = crisp on high-DPI screens and on X) without changing layout.
 */
export async function renderPnlCard(data: PnlCardData, background: PnlCardBackground, scale = 2): Promise<HTMLCanvasElement> {
  const W = PNL_CARD_WIDTH;
  const H = PNL_CARD_HEIGHT;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  ctx.scale(scale, scale);

  const [bg, seal, logo] = await Promise.all([
    loadImage(background.src).catch(() => null),
    loadImage("/ssr-seal.png").catch(() => null),
    data.logoUrl ? loadImage(data.logoUrl).catch(() => null) : Promise.resolve(null),
    ensureFonts(),
  ]);

  // --- Ground: mascot art, then a navy wash that keeps the left half legible
  // while leaving the eagle clearly visible on the right.
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, W, H);
  if (bg) drawCover(ctx, bg, W, H, background);

  const wash = ctx.createLinearGradient(0, 0, W, 0);
  wash.addColorStop(0, "rgba(7,4,41,0.96)");
  wash.addColorStop(0.42, "rgba(7,4,41,0.88)");
  wash.addColorStop(0.68, "rgba(7,4,41,0.42)");
  wash.addColorStop(1, "rgba(7,4,41,0.08)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  const floor = ctx.createLinearGradient(0, H - 160, 0, H);
  floor.addColorStop(0, "rgba(7,4,41,0)");
  floor.addColorStop(1, "rgba(7,4,41,0.85)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, H - 160, W, 160);

  const ceiling = ctx.createLinearGradient(0, 0, 0, 110);
  ceiling.addColorStop(0, "rgba(7,4,41,0.7)");
  ceiling.addColorStop(1, "rgba(7,4,41,0)");
  ctx.fillStyle = ceiling;
  ctx.fillRect(0, 0, W, 110);

  // Hairline frame + brand accent stripe.
  ctx.strokeStyle = "rgba(201,211,247,0.18)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  const stripe = ctx.createLinearGradient(0, 0, 320, 0);
  stripe.addColorStop(0, YELLOW);
  stripe.addColorStop(1, "rgba(237,232,113,0)");
  ctx.fillStyle = stripe;
  ctx.fillRect(0, 0, 320, 4);

  const PAD = 56;
  ctx.textBaseline = "alphabetic";

  // --- Header: seal + wordmark (left), card kind (right).
  if (seal) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(PAD + 18, 58, 18, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(seal, PAD, 40, 36, 36);
    ctx.restore();
  }
  ctx.fillStyle = INK;
  ctx.font = `700 22px ${DISPLAY}`;
  ctx.textAlign = "left";
  ctx.fillText("SSR.fun", PAD + (seal ? 48 : 0), 66);

  ctx.fillStyle = PERIWINKLE;
  ctx.font = `500 13px ${MONO}`;
  ctx.textAlign = "right";
  ctx.fillText("RESERVE PERFORMANCE", W - PAD, 64);

  // --- Reserve identity: avatar, name, ticker pill.
  const idY = 150;
  drawAvatar(ctx, logo, data.ticker, PAD + 28, idY, 28);
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `700 34px ${DISPLAY}`;
  const nameX = PAD + 72;
  const name = ellipsize(ctx, data.name, 520);
  ctx.fillText(name, nameX, idY + 12);
  const nameW = ctx.measureText(name).width;

  ctx.font = `500 18px ${MONO}`;
  const tickerText = `$${data.ticker}`;
  const pillW = ctx.measureText(tickerText).width + 28;
  const pillX = nameX + nameW + 16;
  roundedRect(ctx, pillX, idY - 17, pillW, 34, 17);
  ctx.fillStyle = "rgba(201,211,247,0.14)";
  ctx.fill();
  ctx.strokeStyle = "rgba(201,211,247,0.45)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = PERI_SOFT;
  ctx.fillText(tickerText, pillX + 14, idY + 6);

  // --- Headline figure: all-time gain since launch.
  const headY = 318;
  const hasGain = data.allTimeChangePct !== null;
  ctx.font = hasGain ? `800 108px ${DISPLAY}` : `700 64px ${DISPLAY}`;
  ctx.fillStyle = hasGain ? pctColor(data.allTimeChangePct) : PERI_SOFT;
  const headline = hasGain ? formatSignedPct(data.allTimeChangePct!) : "Just launched";
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillText(headline, PAD - 4, headY);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = INK_MUTED;
  ctx.font = `400 18px ${SANS}`;
  const sub = data.allTimeChangePct === null ? "All-time gain not available yet" : "All-time gain since launch";
  ctx.fillText(sub, PAD, headY + 38);
  if (data.tokenPriceUsdc !== null) {
    const subW = ctx.measureText(sub).width;
    ctx.fillStyle = "rgba(167,178,220,0.6)";
    ctx.fillText("·", PAD + subW + 12, headY + 38);
    ctx.fillStyle = PERI_SOFT;
    ctx.font = `500 18px ${MONO}`;
    ctx.fillText(`$${formatPrice(data.tokenPriceUsdc)} per Reserve Token`, PAD + subW + 28, headY + 38);
  }

  // --- Top performers (winners only; nothing drawn when there are none yet).
  if (data.topAssets.length > 0) {
    const listY = 418;
    ctx.fillStyle = PERIWINKLE;
    ctx.font = `500 13px ${MONO}`;
    ctx.fillText("TOP PERFORMERS", PAD, listY);

    const medals = [YELLOW, "#d7dcee", "#e0a96b"];
    data.topAssets.slice(0, 3).forEach((asset, i) => {
      const rowY = listY + 40 + i * 40;
      ctx.beginPath();
      ctx.arc(PAD + 12, rowY - 7, 12, 0, Math.PI * 2);
      ctx.fillStyle = medals[i] ?? PERI_SOFT;
      ctx.fill();
      ctx.fillStyle = NAVY;
      ctx.font = `700 12px ${DISPLAY}`;
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), PAD + 12, rowY - 2);

      ctx.textAlign = "left";
      ctx.fillStyle = INK;
      ctx.font = `600 22px ${SANS}`;
      ctx.fillText(asset.symbol, PAD + 38, rowY);
      const symW = ctx.measureText(asset.symbol).width;

      ctx.font = `500 20px ${MONO}`;
      ctx.fillStyle = pctColor(asset.pnlPct);
      ctx.fillText(formatSignedPct(asset.pnlPct, 1), PAD + 38 + symW + 18, rowY);
    });
  }

  // --- Footer: manager + where to find it.
  const footY = H - 34;
  ctx.textAlign = "left";
  ctx.fillStyle = INK_MUTED;
  ctx.font = `400 15px ${SANS}`;
  ctx.fillText("Manager", PAD, footY);
  const mgrLabelW = ctx.measureText("Manager").width;
  ctx.fillStyle = PERI_SOFT;
  ctx.font = `500 15px ${MONO}`;
  ctx.fillText(data.managerLabel, PAD + mgrLabelW + 10, footY);

  ctx.textAlign = "right";
  ctx.fillStyle = INK_MUTED;
  ctx.font = `500 15px ${MONO}`;
  ctx.fillText(data.siteHost, W - PAD, footY);

  return canvas;
}

function formatPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the card image."))), "image/png");
  });
}

/** Copies a PNG to the clipboard; false when the browser doesn't allow image clipboard writes. */
export async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** X (Twitter) web intent URL -- the text is pre-filled; the image is attached by the user from their clipboard or download. */
export function buildXShareUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params.toString()}`;
}

export function buildShareText(data: PnlCardData): string {
  const gain = data.allTimeChangePct === null ? null : formatSignedPct(data.allTimeChangePct, 1);
  const lines: string[] = [];
  lines.push(gain ? `$${data.ticker} ${data.name} is ${gain} since launch on SSR.fun 🦅` : `$${data.ticker} ${data.name} just launched on SSR.fun 🦅`);
  const performers = data.topAssets.slice(0, 3);
  if (performers.length > 0) {
    lines.push("");
    lines.push(`Top performers: ${performers.map((a) => `${a.symbol} ${formatSignedPct(a.pnlPct, 1)}`).join(" · ")}`);
  }
  return lines.join("\n");
}
