import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";
import { DiscordError } from "../src/discord.js";
import { hashToken } from "../src/token.js";

const VIEW = String(1 << 10);

function fakeDiscord() {
  const state = {
    me: { id: "u1" },
    channels: [
      { id: "c1", name: "🚪: 4321", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] },
    ],
    channel: { id: "c1", name: "🚪: 4321" },
    channelError: null,
    calls: [],
  };
  const client = {
    authorizeUrl: (redirectUri, st) => `https://discord.com/oauth2/authorize?state=${st}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async exchangeCode(code) { state.calls.push(["exchangeCode", code]); return "at"; },
    async getMe() { state.calls.push(["getMe"]); return state.me; },
    async listGuildChannels(g) { state.calls.push(["listGuildChannels", g]); return state.channels; },
    async getChannel(id) {
      state.calls.push(["getChannel", id]);
      if (state.channelError) throw state.channelError;
      return state.channel;
    },
  };
  return { client, state };
}

let server, base, store, discord;

before(async () => {
  store = openStore(":memory:");
  discord = fakeDiscord();
  const handler = createApp({ baseUrl: "https://dc.test", guildId: "g1", store, discord: discord.client });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

async function get(path, headers = {}) {
  return fetch(base + path, { headers, redirect: "manual" });
}

function cookieFrom(res) {
  const sc = res.headers.get("set-cookie") ?? "";
  return sc.split(";")[0];
}

test("GET /auth/start serves a landing page with sign in and sign out links", async () => {
  const res = await get("/auth/start");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /href="\/auth\/discord"/);
  assert.match(html, /pebblejs:\/\/close#%7B%22signout%22%3Atrue%7D/);
});

test("GET /auth/discord sets a state cookie and redirects to Discord with that state", async () => {
  const res = await get("/auth/discord");
  assert.equal(res.status, 302);
  const cookie = cookieFrom(res);
  assert.match(cookie, /^state=[A-Za-z0-9_-]+$/);
  const st = cookie.slice("state=".length);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.searchParams.get("state"), st);
  assert.equal(loc.searchParams.get("redirect_uri"), "https://dc.test/auth/callback");
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
});

test("GET /auth/callback with mismatched state is 400 and never calls Discord", async () => {
  discord.state.calls.length = 0;
  const res = await get("/auth/callback?code=x&state=wrong", { cookie: "state=right" });
  assert.equal(res.status, 400);
  assert.deepEqual(discord.state.calls, []);
});

test("GET /auth/callback with no state cookie is 400", async () => {
  const res = await get("/auth/callback?code=x&state=abc");
  assert.equal(res.status, 400);
});

async function signIn() {
  const start = await get("/auth/discord");
  const cookie = cookieFrom(start);
  const st = cookie.slice("state=".length);
  return get(`/auth/callback?code=thecode&state=${st}`, { cookie });
}

test("successful callback stores a token and returns a pebblejs close page with it", async () => {
  const res = await signIn();
  assert.equal(res.status, 200);
  const html = await res.text();
  const m = /pebblejs:\/\/close#([A-Za-z0-9%._-]+)/.exec(html);
  assert.ok(m, "close url present");
  const payload = JSON.parse(decodeURIComponent(m[1]));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
  const row = store.get(hashToken(payload.token));
  assert.equal(row.userId, "u1");
  assert.equal(row.channelId, "c1");
});

test("callback with no matching channel shows the none message and stores nothing", async () => {
  const saved = discord.state.channels;
  discord.state.channels = [];
  const res = await signIn();
  discord.state.channels = saved;
  assert.equal(res.status, 200);
  assert.match(await res.text(), /No door code channel found/);
});

test("callback with multiple matching channels shows the multiple message", async () => {
  const saved = discord.state.channels;
  discord.state.channels = [saved[0], { ...saved[0], id: "c9" }];
  const res = await signIn();
  discord.state.channels = saved;
  assert.match(await res.text(), /Multiple door code channels/);
});

async function tokenFromSignIn() {
  const html = await (await signIn()).text();
  const m = /pebblejs:\/\/close#([A-Za-z0-9%._-]+)/.exec(html);
  return JSON.parse(decodeURIComponent(m[1])).token;
}

test("GET /code with a valid token returns the code", async () => {
  const token = await tokenFromSignIn();
  const res = await get("/code", { authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { code: "4321", channel: "🚪: 4321" });
});

test("GET /code without a token is 401", async () => {
  assert.equal((await get("/code")).status, 401);
});

test("GET /code with malformed authorization is 401", async () => {
  assert.equal((await get("/code", { authorization: "Bearer" })).status, 401);
  assert.equal((await get("/code", { authorization: "Bearer " })).status, 401);
  assert.equal((await get("/code", { authorization: "Basic abc" })).status, 401);
});

test("GET /code with an unknown token is 401", async () => {
  assert.equal((await get("/code", { authorization: "Bearer nope" })).status, 401);
});

test("GET /code is 422 when the channel name has no trailing digits", async () => {
  const token = await tokenFromSignIn();
  discord.state.channel = { id: "c1", name: "🚪: tbd" };
  const res = await get("/code", { authorization: `Bearer ${token}` });
  discord.state.channel = { id: "c1", name: "🚪: 4321" };
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "unparseable" });
});

test("GET /code is 403 reauth and deletes the token when Discord says 404", async () => {
  const token = await tokenFromSignIn();
  discord.state.channelError = new DiscordError(404, "Unknown Channel");
  const res = await get("/code", { authorization: `Bearer ${token}` });
  discord.state.channelError = null;
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "reauth" });
  assert.equal(store.get(hashToken(token)), undefined);
  const again = await get("/code", { authorization: `Bearer ${token}` });
  assert.equal(again.status, 401);
});

test("GET /code is 403 reauth when Discord says 403", async () => {
  const token = await tokenFromSignIn();
  discord.state.channelError = new DiscordError(403, "Missing Access");
  const res = await get("/code", { authorization: `Bearer ${token}` });
  discord.state.channelError = null;
  assert.equal(res.status, 403);
});

test("GET /code is 502 when Discord fails some other way", async () => {
  const token = await tokenFromSignIn();
  discord.state.channelError = new DiscordError(500, "boom");
  const res = await get("/code", { authorization: `Bearer ${token}` });
  discord.state.channelError = null;
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "discord" });
  assert.ok(store.get(hashToken(token)), "token kept on 502");
});

test("POST /auth/revoke deletes the token", async () => {
  const token = await tokenFromSignIn();
  const res = await fetch(base + "/auth/revoke", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 204);
  assert.equal(store.get(hashToken(token)), undefined);
  const again = await fetch(base + "/auth/revoke", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(again.status, 204);
});

test("unknown routes are 404 json", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
});
