// GET /api/feedback/form -- serves the public feedback form as a self-contained
// HTML page. Served from /api/* so it bypasses the site-wide beta gate (the
// middleware lets /api/* through), i.e. it's reachable without the site
// password. The page POSTs to /api/feedback/submit.
interface Req { method?: string }
interface Res {
  status: (n: number) => Res
  setHeader: (k: string, v: string) => void
  send: (b: string) => void
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Send feedback</title>
<style>
  :root{color-scheme:light dark;--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;--acc:#2f81f7;--border:#30363d}
  @media(prefers-color-scheme:light){:root{--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--muted:#59636e;--acc:#0969da;--border:#d0d7de}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:520px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}
  h1{margin:0 0 4px;font-size:20px}p.sub{margin:0 0 20px;color:var(--muted);font-size:13px}
  label{display:block;font-weight:600;font-size:13px;margin:14px 0 6px}
  select,input,textarea{width:100%;padding:10px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:9px;font:inherit}
  textarea{min-height:120px;resize:vertical}
  button{margin-top:20px;width:100%;padding:12px;background:var(--acc);color:#fff;border:0;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .msg{margin-top:14px;font-size:14px;text-align:center;min-height:20px}
  .ok{color:#3fb950}.err{color:#f85149}
</style></head><body>
<form class="card" id="f">
  <h1>Send feedback</h1>
  <p class="sub">Report a bug, request a feature, or tell us what's off. A human reviews every submission.</p>
  <label for="category">Type</label>
  <select id="category" name="category">
    <option value="bug">🐞 Bug</option>
    <option value="idea">💡 Feature / idea</option>
    <option value="confusing">🤔 Confusing / UX</option>
    <option value="general" selected>💬 General</option>
  </select>
  <label for="message">What's up?</label>
  <textarea id="message" name="message" maxlength="4000" required placeholder="Describe the issue or idea. Steps to reproduce help a lot for bugs."></textarea>
  <label for="contact">Contact (optional)</label>
  <input id="contact" name="contact" maxlength="400" placeholder="email / @handle so we can follow up">
  <button id="btn" type="submit">Send feedback</button>
  <div class="msg" id="msg"></div>
</form>
<script>
  var f=document.getElementById('f'),btn=document.getElementById('btn'),msg=document.getElementById('msg');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var m=document.getElementById('message').value.trim();
    if(!m){msg.textContent='Please write something first.';msg.className='msg err';return;}
    btn.disabled=true;msg.textContent='Sending…';msg.className='msg';
    fetch('/api/feedback/submit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({category:document.getElementById('category').value,message:m,
        contact:document.getElementById('contact').value.trim(),pageUrl:document.referrer||location.href})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){
      if(x.ok){f.reset();msg.textContent='✅ Thanks — sent. A human will take a look.';msg.className='msg ok';}
      else{msg.textContent='⚠️ '+((x.j&&x.j.error)||'Something went wrong.');msg.className='msg err';}
    })
    .catch(function(){msg.textContent='⚠️ Network error — try again.';msg.className='msg err';})
    .finally(function(){btn.disabled=false;});
  });
</script>
</body></html>`

export default function handler(_req: Req, res: Res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.status(200).send(PAGE)
}
