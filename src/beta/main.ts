// Public BETA key claim page (beta.html -> /beta, DEC-0276). Its own Vite
// entry so it can load Vercel BotID's client, exactly like src/feedback/main.ts:
// initBotId registers the protected route and the BotID script attaches an
// invisible human/bot classification to the claim POST, which
// api/site/claim.ts verifies with checkBotId(). No puzzle is ever shown.
//
// After a claim, "Enter SSR.fun" redeems the key through the same
// /api/site/login endpoint the Coming Soon page uses, then opens the app.
import { initBotId } from "botid/client/core";

initBotId({ protect: [{ path: "/api/site/claim", method: "POST" }] });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const claimView = $("claim-view");
const keyView = $("key-view");
const closedView = $("closed-view");
const form = $<HTMLFormElement>("claim-form");
const handleInput = $<HTMLInputElement>("handle");
const emailInput = $<HTMLInputElement>("email");
const claimBtn = $<HTMLButtonElement>("claim-btn");
const claimStatus = $("claim-status");
const keyValue = $("key-value");
const copyBtn = $<HTMLButtonElement>("copy-btn");
const enterBtn = $<HTMLButtonElement>("enter-btn");
const enterStatus = $("enter-status");
const shareBtn = $<HTMLAnchorElement>("share-btn");

// TODO(Creator): add SSR.fun's X @handle here once confirmed.
const SHARE_TEXT = "I just got my SSR.fun BETA key. Launch a Reserve on Solana with me 👇";

function setStatus(el: HTMLElement, text: string, isError = false) {
  el.textContent = text;
  el.className = "status" + (isError ? " err" : "");
}

function show(view: HTMLElement) {
  for (const v of [claimView, keyView, closedView]) v.classList.toggle("hidden", v !== view);
}

function showKey(key: string, alreadyClaimed: boolean) {
  keyValue.textContent = key;
  if (alreadyClaimed) $("key-lede").textContent = "This handle already has a key, so here it is again. Save it to sign in on another browser or device.";
  const url = "https://ssr.fun/beta";
  shareBtn.href = `https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(url)}`;
  show(keyView);
  enterBtn.focus();
}

// Is claiming switched on for this deployment? (Off everywhere but ssr.fun.)
fetch("/api/site/claim", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((j: { open?: boolean }) => { if (!j.open) show(closedView); })
  .catch(() => { /* leave the form up; the POST reports any problem */ });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const handle = handleInput.value.trim();
  if (!handle) { setStatus(claimStatus, "Enter your X handle.", true); handleInput.focus(); return; }
  claimBtn.disabled = true;
  setStatus(claimStatus, "Creating your key…");
  try {
    const r = await fetch("/api/site/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ handle, email: emailInput.value.trim() }),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; key?: string; alreadyClaimed?: boolean; error?: string } | null;
    if (r.ok && j?.key) { showKey(j.key, !!j.alreadyClaimed); return; }
    setStatus(claimStatus, j?.error || "Something went wrong. Please try again.", true);
  } catch {
    setStatus(claimStatus, "Network error. Please try again.", true);
  }
  claimBtn.disabled = false;
});

copyBtn.addEventListener("click", async () => {
  const key = keyValue.textContent || "";
  try {
    await navigator.clipboard.writeText(key);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(keyValue);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand("copy");
  }
  copyBtn.textContent = "Copied";
  setTimeout(() => { copyBtn.textContent = "Copy"; }, 1800);
});

enterBtn.addEventListener("click", async () => {
  enterBtn.disabled = true;
  setStatus(enterStatus, "Signing you in…");
  try {
    const r = await fetch("/api/site/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ key: keyValue.textContent }),
    });
    if (r.ok) { window.location.href = "/"; return; }
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    setStatus(enterStatus, j?.error || "We couldn't sign you in. Copy your key and enter it on the home page.", true);
  } catch {
    setStatus(enterStatus, "Network error. Please try again.", true);
  }
  enterBtn.disabled = false;
});
