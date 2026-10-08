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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}a.btn{display:block;margin:1rem 0;padding:1rem;background:#5865F2;color:#fff;text-decoration:none;border-radius:8px;text-align:center}a.btn.secondary{background:#444}</style>
</head><body>${body}</body></html>`;
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
      const host = baseUrl.replace(/^https?:\/\//, "");
      return sendHtml(res, 200, page("Door Code",
        `<h1>Door Code setup</h1>
<p>Setting up takes two steps. Discord's sign-in does not work inside the Pebble app, so step 1 happens in your phone's browser.</p>
<h2 style="margin-bottom:.25rem">Step 1: sign in with Discord in your browser</h2>
<p>Open Chrome or Safari and go to:<br><b style="font-size:1.1rem;user-select:all">${host}/auth/start</b><br>
Tap <b>Sign in with Discord</b> and approve. You will get a six-character code.</p>
<h2 style="margin-bottom:.25rem">Step 2: enter the code here</h2>
<form id="pair"><input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="ABC123" style="font-size:1.5rem;letter-spacing:.2em;width:100%;padding:.75rem;box-sizing:border-box;text-align:center">
<button class="btn" type="submit" style="width:100%;border:0;font-size:1rem">Pair this watch</button></form>
<p id="msg"></p>
<p style="margin-top:2rem;color:#666;font-size:.9rem">You only do this once. The watch keeps working through weekly code changes.</p>
<details><summary style="color:#666">Other options</summary>
<a class="btn secondary" href="/auth/discord">Try signing in here anyway</a>
<a class="btn secondary" href="${closeUrl({ signout: true })}">Sign out of this watch</a>
</details>
<script>
document.getElementById("pair").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  msg.textContent = "Checking...";
  try {
    const r = await fetch("/auth/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: document.getElementById("code").value }) });
    const j = await r.json();
    if (r.ok && j.token) {
      msg.textContent = "Paired. Returning to the Pebble app.";
      location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify({ token: j.token }));
    } else {
      msg.textContent = r.status === 429 ? "Too many attempts, wait a minute." : "That code is not valid or has expired. Sign in again to get a new one.";
    }
  } catch (err) {
    msg.textContent = "Could not reach the service. Check your connection.";
  }
});
</script>`));
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
<p style="font-size:2.5rem;letter-spacing:.3em;text-align:center;font-family:monospace"><b>${pairCode}</b></p>
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
