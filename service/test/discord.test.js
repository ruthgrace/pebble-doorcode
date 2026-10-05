import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscordClient, DiscordError } from "../src/discord.js";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = handler(String(url), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const cfg = { clientId: "cid", clientSecret: "sec", botToken: "bot" };

test("authorizeUrl includes client id, redirect, identify scope, and state", () => {
  const c = createDiscordClient(cfg);
  const u = new URL(c.authorizeUrl("https://x.test/auth/callback", "st8"));
  assert.equal(u.origin + u.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("redirect_uri"), "https://x.test/auth/callback");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), "identify");
  assert.equal(u.searchParams.get("state"), "st8");
});

test("exchangeCode posts form data and returns access_token", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ body: { access_token: "at" } }));
  const c = createDiscordClient({ ...cfg, fetchImpl });
  assert.equal(await c.exchangeCode("thecode", "https://x.test/cb"), "at");
  assert.equal(calls[0].url, "https://discord.com/api/v10/oauth2/token");
  assert.equal(calls[0].init.method, "POST");
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "thecode");
  assert.equal(form.get("redirect_uri"), "https://x.test/cb");
  assert.equal(form.get("client_id"), "cid");
  assert.equal(form.get("client_secret"), "sec");
});

test("getMe uses the user bearer token", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ body: { id: "u1" } }));
  const c = createDiscordClient({ ...cfg, fetchImpl });
  assert.deepEqual(await c.getMe("at"), { id: "u1" });
  assert.equal(calls[0].url, "https://discord.com/api/v10/users/@me");
  assert.equal(calls[0].init.headers.Authorization, "Bearer at");
});

test("listGuildChannels and getChannel use the bot token", async () => {
  const { fetchImpl, calls } = fakeFetch((url) =>
    url.endsWith("/channels") ? { body: [{ id: "c1" }] } : { body: { id: "c1", name: "🚪: 1" } },
  );
  const c = createDiscordClient({ ...cfg, fetchImpl });
  assert.deepEqual(await c.listGuildChannels("g1"), [{ id: "c1" }]);
  assert.equal(calls[0].url, "https://discord.com/api/v10/guilds/g1/channels");
  assert.equal(calls[0].init.headers.Authorization, "Bot bot");
  assert.deepEqual(await c.getChannel("c1"), { id: "c1", name: "🚪: 1" });
  assert.equal(calls[1].url, "https://discord.com/api/v10/channels/c1");
});

test("non-2xx responses throw DiscordError with the status", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { message: "Unknown Channel" } }));
  const c = createDiscordClient({ ...cfg, fetchImpl });
  await assert.rejects(c.getChannel("c1"), (e) => e instanceof DiscordError && e.status === 404);
});
