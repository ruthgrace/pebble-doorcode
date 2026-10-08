import { extractCode, findUserChannel } from "./match.js";
import { newToken, hashToken } from "./token.js";
import { randomBytes } from "node:crypto";

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extraHeaders });
  res.end(html);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title>
<style>
:root{--bg:#fff;--fg:#111;--muted:#555;--accent:#5865F2;--accent-fg:#fff;--secondary:#e6e6e6;--secondary-fg:#111;--border:#bbb}
@media (prefers-color-scheme: dark){:root{--bg:#1e1f22;--fg:#f2f3f5;--muted:#b5bac1;--secondary:#3a3c42;--secondary-fg:#f2f3f5;--border:#777}}
html,body{background:var(--bg);color:var(--fg)}
body{font-family:system-ui,sans-serif;margin:0;padding:1.25rem 1rem 2rem;line-height:1.5;font-size:17px}
h1{font-size:1.6rem;margin:.25rem 0 .75rem}h2{font-size:1.15rem;margin:1.5rem 0 .5rem}
p{margin:.5rem 0}.muted{color:var(--muted);font-size:.95rem}
a.btn,button.btn{display:block;width:100%;box-sizing:border-box;margin:.75rem 0;padding:.9rem;background:var(--accent);color:var(--accent-fg);text-decoration:none;border-radius:10px;text-align:center;font-size:1.05rem;font-weight:600;border:0}
a.btn.secondary,button.btn.secondary{background:var(--secondary);color:var(--secondary-fg)}
.link{display:block;margin:.5rem 0;padding:.9rem;border:1px solid var(--border);border-radius:10px;word-break:break-all;color:var(--accent);font-weight:600;text-decoration:underline}
input.code{font-size:1.6rem;letter-spacing:.25em;width:100%;padding:.75rem;box-sizing:border-box;text-align:center;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg)}
.bigcode{font-size:2.6rem;letter-spacing:.3em;text-align:center;font-family:ui-monospace,monospace;margin:1rem 0}
</style>
</head><body>${body}</body></html>`;
}

function looksLikeInAppBrowser(req, url) {
  const mode = url.searchParams.get("mode");
  if (mode === "app") return true;
  if (mode === "browser") return false;
  const ua = req.headers["user-agent"] ?? "";
  if (/\bwv\b/.test(ua)) return true;                 // Android WebView
  if (/iPhone|iPad/.test(ua) && !/Safari\//.test(ua)) return true; // iOS WKWebView
  return false;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/.exec(h);
  return m ? m[1] : null;
}

const CLEAR_STATE = "state=; Max-Age=0; Path=/auth";

function closeUrl(payload) {
  return "pebblejs://close#" + encodeURIComponent(JSON.stringify(payload));
}

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_TTL_MS = 10 * 60 * 1000;

function newPairCode() {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  return out;
}

function normalizePairCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { resolve(null); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

export function createApp({ baseUrl, guildId, store, discord, pairTtlMs = PAIR_TTL_MS, now = Date.now }) {
  const redirectUri = `${baseUrl}/auth/callback`;
  // Pending pairing codes: code -> { token, expires }. In memory on purpose:
  // they live ten minutes and a restart simply asks the user to sign in again.
  const pending = new Map();
  let failedPairAttempts = 0;
  let failedPairWindowStart = 0;

  function sweepPending() {
    const t = now();
    for (const [code, entry] of pending) if (entry.expires <= t) pending.delete(code);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /auth/start") {
      const noStore = { "Cache-Control": "no-store" };
      const startUrl = `${baseUrl}/auth/start`;
      const host = baseUrl.replace(/^https?:\/\//, "");
      const signOut = `<a class="btn secondary" href="${closeUrl({ signout: true })}">Sign out of this watch</a>`;
      if (looksLikeInAppBrowser(req, url)) {
        return sendHtml(res, 200, page("Door Code",
          `<h1>Door Code setup</h1>
<p>Two steps, once only.</p>
<h2>Step 1: sign in with Discord in your browser</h2>
<p>Discord's sign-in does not work inside the Pebble app, so tap this link to open it in Chrome or Safari:</p>
<a class="btn" id="openlink" href="${startUrl}" target="_blank" rel="noopener">Open in my browser</a>
<a class="link" href="${startUrl}" target="_blank" rel="noopener">${startUrl}</a>
<button class="btn secondary" type="button" id="copy">Copy link</button>
<p class="muted">If the link opens inside this app instead, copy it and paste it into your browser. After you sign in, the browser shows a six-character code.</p>
<h2>Step 2: enter the code here</h2>
<form id="pair"><input class="code" id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="ABC123">
<button class="btn" type="submit">Pair this watch</button></form>
<p id="msg"></p>
<p class="muted">After pairing, the watch keeps working through weekly code changes.</p>
${signOut}
<script>
(function () {
  // Ask the OS, not this in-app browser, to open the address in the default browser.
  const ua = navigator.userAgent;
  const a = document.getElementById("openlink");
  const host = ${JSON.stringify(host)};
  if (/Android/i.test(ua)) {
    a.href = "intent://" + host + "/auth/start#Intent;scheme=https;action=android.intent.action.VIEW;end";
  } else if (/iPhone|iPad/i.test(ua)) {
    a.href = "x-safari-https://" + host + "/auth/start";
  }
})();
document.getElementById("copy").addEventListener("click", async () => {
  const b = document.getElementById("copy");
  try { await navigator.clipboard.writeText(${JSON.stringify(startUrl)}); b.textContent = "Copied"; }
  catch (e) { b.textContent = "Long-press the link to copy it"; }
});
document.getElementById("pair").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  const typed = document.getElementById("code").value.trim();
  if (!typed) { msg.textContent = "Type the six-character code from your browser first."; return; }
  msg.textContent = "Checking...";
  try {
    const r = await fetch("/auth/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: typed }) });
    const j = await r.json();
    if (r.ok && j.token) {
      msg.textContent = "Paired. Returning to the Pebble app.";
      location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify({ token: j.token }));
    } else {
      msg.textContent = r.status === 429 ? "Too many attempts, wait a minute." : "That code is not valid or has expired. Sign in again in your browser to get a new one.";
    }
  } catch (err) {
    msg.textContent = "Could not reach the service. Check your connection.";
  }
});
</script>`), noStore);
      }
      return sendHtml(res, 200, page("Door Code",
        `<h1>Door Code</h1>
<p>Sign in with Discord to get a pairing code for your Pebble.</p>
<a class="btn" href="/auth/discord">Sign in with Discord</a>
<p class="muted">After signing in you will see a six-character code. Then open the Pebble app on your phone, go to the Door Code app's settings, and enter it there.</p>
<p class="muted"><a href="/auth/start?mode=app">I am inside the Pebble app</a></p>`), noStore);
    }

    if (route === "GET /auth/discord") {
      const state = newToken();
      return sendHtml(res, 302, "", {
        Location: discord.authorizeUrl(redirectUri, state),
        "Set-Cookie": `state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth`,
      });
    }

    if (route === "GET /auth/callback") {
      const cookies = parseCookies(req);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code || !cookies.state || cookies.state !== state) {
        return sendHtml(res, 400, page("Error", "<h1>Sign-in failed</h1><p>Please go back and try again.</p>"));
      }
      const clearState = { "Set-Cookie": CLEAR_STATE };
      const failed = () => {
        return sendHtml(res, 502, page("Error", "<h1>Sign-in failed</h1><p>Discord did not respond as expected. Go back and try again.</p>"), clearState);
      };
      let me, channels;
      try {
        const accessToken = await discord.exchangeCode(code, redirectUri);
        me = await discord.getMe(accessToken);
        channels = await discord.listGuildChannels(guildId);
      } catch (e) {
        console.error(e);
        return failed();
      }
      const match = findUserChannel(channels, me.id);
      if (match.error === "none") {
        return sendHtml(res, 200, page("Not found", "<h1>No door code channel found for your account.</h1><p>Ask the server admin to check your door channel.</p>"), clearState);
      }
      if (match.error === "multiple") {
        return sendHtml(res, 200, page("Ambiguous", "<h1>Multiple door code channels found, contact the admin.</h1>"), clearState);
      }
      const token = newToken();
      store.put({ tokenHash: hashToken(token), userId: me.id, channelId: match.channel.id });
      sweepPending();
      let pairCode = newPairCode();
      while (pending.has(pairCode)) pairCode = newPairCode();
      pending.set(pairCode, { token, expires: now() + pairTtlMs });
      const href = closeUrl({ token });
      return sendHtml(res, 200, page("Signed in",
        `<h1>Signed in</h1>
<p>Your pairing code (valid for 10 minutes):</p>
<p class="bigcode"><b>${pairCode}</b></p>
<p>Open the Pebble app on your phone, go to the Door Code app's settings, and enter this code.</p>
<p>If you are reading this inside the Pebble app already, tap Continue.</p>
<a class="btn" href="${href}">Continue</a>`),
        { "Set-Cookie": CLEAR_STATE, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    }

    if (route === "POST /auth/pair") {
      const noStore = { "Cache-Control": "no-store" };
      const t = now();
      if (t - failedPairWindowStart > 60_000) { failedPairWindowStart = t; failedPairAttempts = 0; }
      if (failedPairAttempts >= 20) return sendJson(res, 429, { error: "slow down" }, noStore);
      const body = await readJsonBody(req);
      const code = normalizePairCode(body && body.code);
      sweepPending();
      const entry = code ? pending.get(code) : undefined;
      if (!entry) {
        failedPairAttempts++;
        return sendJson(res, 404, { error: "badcode" }, noStore);
      }
      pending.delete(code);
      return sendJson(res, 200, { token: entry.token }, noStore);
    }

    if (route === "GET /code") {
      const token = bearer(req);
      const noStore = { "Cache-Control": "no-store" };
      if (!token) return sendJson(res, 401, { error: "unauthorized" }, noStore);
      const h = hashToken(token);
      const row = store.get(h);
      if (!row) return sendJson(res, 401, { error: "unauthorized" }, noStore);
      // Resolve the user's door channel fresh on every request by looking for
      // the member overwrite in the guild listing. The listing includes private
      // channels the bot has not been added to, so no per-channel bot access is
      // needed, and a renamed or recreated channel is found automatically.
      let channels;
      try {
        channels = await discord.listGuildChannels(guildId);
      } catch (e) {
        console.error(e);
        return sendJson(res, 502, { error: "discord" }, noStore);
      }
      const match = findUserChannel(channels, row.userId);
      if (match.error === "none") return sendJson(res, 404, { error: "nochannel" }, noStore);
      if (match.error === "multiple") return sendJson(res, 409, { error: "multiple" }, noStore);
      const channel = match.channel;
      if (channel.id !== row.channelId) {
        store.put({ tokenHash: h, userId: row.userId, channelId: channel.id });
      }
      const code = extractCode(channel.name);
      if (!code) return sendJson(res, 422, { error: "unparseable" }, noStore);
      return sendJson(res, 200, { code, channel: channel.name }, noStore);
    }

    if (route === "POST /auth/revoke") {
      const token = bearer(req);
      if (!token) return sendJson(res, 401, { error: "unauthorized" });
      store.del(hashToken(token));
      res.writeHead(204);
      return res.end();
    }

    return sendJson(res, 404, { error: "not found" });
  }

  return (req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  };
}
