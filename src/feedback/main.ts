// Public feedback form (feedback.html -> /feedback). Built by Vite as its own
// entry so it can load Vercel BotID's client: initBotId registers the protected
// route, and the BotID script (served through the vercel.json proxy rewrites)
// attaches an invisible human/bot classification to the POST that
// api/feedback/submit.ts verifies server-side with checkBotId(). No puzzle is
// ever shown to a human; a bot gets a 403 from the endpoint.
import { initBotId } from "botid/client/core";

initBotId({ protect: [{ path: "/api/feedback/submit", method: "POST" }] });

const f = document.getElementById("f") as HTMLFormElement;
const btn = document.getElementById("btn") as HTMLButtonElement;
const msg = document.getElementById("msg") as HTMLDivElement;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = val("message").trim();
  if (!message) {
    msg.textContent = "Please write something first.";
    msg.className = "msg err";
    return;
  }
  btn.disabled = true;
  msg.textContent = "Sending…";
  msg.className = "msg";
  try {
    const r = await fetch("/api/feedback/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ category: val("category"), message, contact: val("contact").trim(), pageUrl: document.referrer || location.href }),
    });
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    if (r.ok) {
      f.reset();
      msg.textContent = "✅ Thanks — sent. A human will take a look.";
      msg.className = "msg ok";
    } else {
      msg.textContent = "⚠️ " + (j?.error || (r.status === 429 ? "Too many submissions from your network right now — try again later." : "Something went wrong."));
      msg.className = "msg err";
    }
  } catch {
    msg.textContent = "⚠️ Network error — try again.";
    msg.className = "msg err";
  } finally {
    btn.disabled = false;
  }
});
