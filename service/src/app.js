import { DiscordError } from "./discord.js";
import { extractCode, findUserChannel, channelGrantsUser } from "./match.js";
import { newToken, hashToken } from "./token.js";

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

function closeUrl(payload) {
  return "pebblejs://close#" + encodeURIComponent(JSON.stringify(payload));
}

export function createApp({ baseUrl, guildId, store, discord }) {
  const redirectUri = `${baseUrl}/auth/callback`;

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /auth/start") {
      return sendHtml(res, 200, page("Door Code",
        `<h1>Door Code</h1>
<p>Sign in with Discord so your watch can read your door code.</p>
<a class="btn" href="/auth/discord">Sign in with Discord</a>
<a class="btn secondary" href="${closeUrl({ signout: true })}">Sign out of this watch</a>`));
    }

    if (route === "GET /auth/discord") {
      const state = newToken();
      return sendHtml(res, 302, "", {
        Location: discord.authorizeUrl(redirectUri, state),
        "Set-Cookie": `state=${state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/auth`,
      });
    }

    if (route === "GET /auth/callback") {
      const cookies = parseCookies(req);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code || !cookies.state || cookies.state !== state) {
        return sendHtml(res, 400, page("Error", "<h1>Sign-in failed</h1><p>Please go back and try again.</p>"));
      }
      const accessToken = await discord.exchangeCode(code, redirectUri);
      const me = await discord.getMe(accessToken);
      const channels = await discord.listGuildChannels(guildId);
      const match = findUserChannel(channels, me.id);
      if (match.error === "none") {
        return sendHtml(res, 200, page("Not found", "<h1>No door code channel found for your account.</h1><p>Ask the server admin to check your door channel.</p>"));
      }
      if (match.error === "multiple") {
        return sendHtml(res, 200, page("Ambiguous", "<h1>Multiple door code channels found, contact the admin.</h1>"));
      }
      const token = newToken();
      store.put({ tokenHash: hashToken(token), userId: me.id, channelId: match.channel.id });
      const href = closeUrl({ token });
      return sendHtml(res, 200, page("Signed in",
        `<h1>Signed in</h1><p>Returning to the Pebble app.</p><a class="btn" href="${href}">Continue</a><script>location.href=${JSON.stringify(href)};</script>`),
        { "Set-Cookie": "state=; Max-Age=0; Path=/auth", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    }

    if (route === "GET /code") {
      const token = bearer(req);
      const noStore = { "Cache-Control": "no-store" };
      if (!token) return sendJson(res, 401, { error: "unauthorized" }, noStore);
      const h = hashToken(token);
      const row = store.get(h);
      if (!row) return sendJson(res, 401, { error: "unauthorized" }, noStore);
      let channel;
      try {
        channel = await discord.getChannel(row.channelId);
      } catch (e) {
        if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
          store.del(h);
          return sendJson(res, 403, { error: "reauth" }, noStore);
        }
        console.error(e);
        return sendJson(res, 502, { error: "discord" }, noStore);
      }
      if (!channelGrantsUser(channel, row.userId)) {
        store.del(h);
        return sendJson(res, 403, { error: "reauth" }, noStore);
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
