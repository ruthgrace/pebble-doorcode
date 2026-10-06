import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";
import { DiscordError } from "../src/discord.js";
import { hashToken } from "../src/token.js";

const VIEW = String(1 << 10);

const DEFAULT_CHANNEL = {
  id: "c1",
  name: "🚪: 4321",
  permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }],
};

function fakeDiscord() {
  const state = {
    me: { id: "u1" },
    channels: [
      { id: "c1", name: "🚪: 4321", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] },
    ],
    listError: null,
    exchangeError: null,
    calls: [],
  };
  const client = {
    authorizeUrl: (redirectUri, st) => `https://discord.com/oauth2/authorize?state=${st}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async exchangeCode(code) {
      state.calls.push(["exchangeCode", code]);
      if (state.exchangeError) {
        const e = state.exchangeError;
        state.exchangeError = null;
        throw e;
      }
      return "at";
    },
    async getMe() { state.calls.push(["getMe"]); return state.me; },
    async listGuildChannels(g) {
      state.calls.push(["listGuildChannels", g]);
      if (state.listError) { const e = state.listError; state.listError = null; throw e; }
      return state.channels;
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
  assert.match(res.headers.get("set-cookie"), /Secure/);
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
  const before = store.count();
  const res = await signIn();
  discord.state.channels = saved;
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /No door code channel found/);
  assert.doesNotMatch(html, /pebblejs:\/\/close#/);
  assert.equal(store.count(), before);
  assert.match(res.headers.get("set-cookie"), /state=;\s*Max-Age=0/);
});

test("callback with multiple matching channels shows the multiple message", async () => {
  const saved = discord.state.channels;
  discord.state.channels = [saved[0], { ...saved[0], id: "c9" }];
  const before = store.count();
  const res = await signIn();
  discord.state.channels = saved;
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Multiple door code channels/);
  assert.equal(store.count(), before);
  assert.match(res.headers.get("set-cookie"), /state=;\s*Max-Age=0/);
});

test("callback renders an HTML 502 page when the Discord token exchange fails", async () => {
  discord.state.exchangeError = new DiscordError(500, "boom");
  const before = store.count();
  const res = await signIn();
  discord.state.exchangeError = null;
  assert.equal(res.status, 502);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(await res.text(), /Sign-in failed/);
  assert.equal(store.count(), before);
  assert.match(res.headers.get("set-cookie"), /state=;\s*Max-Age=0/);
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

function withChannels(channels, fn) {
  const saved = discord.state.channels;
  discord.state.channels = channels;
  return fn().finally(() => { discord.state.channels = saved; });
}

test("GET /code is 422 when the channel name has no trailing digits", async () => {
  const token = await tokenFromSignIn();
  const res = await withChannels([{ ...DEFAULT_CHANNEL, name: "🚪: tbd" }], () =>
    get("/code", { authorization: `Bearer ${token}` }));
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "unparseable" });
});

test("GET /code resolves the channel by the user's overwrite, not the stored id", async () => {
  const token = await tokenFromSignIn();
  const recreated = { ...DEFAULT_CHANNEL, id: "c9", name: "🚪 Code: 7777#" };
  const res = await withChannels([recreated], () => get("/code", { authorization: `Bearer ${token}` }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: "7777#", channel: "🚪 Code: 7777#" });
  assert.equal(store.get(hashToken(token)).channelId, "c9");
});

test("GET /code is 404 nochannel and keeps the token when the user has no door channel", async () => {
  const token = await tokenFromSignIn();
  const res = await withChannels([{ ...DEFAULT_CHANNEL, permission_overwrites: [] }], () =>
    get("/code", { authorization: `Bearer ${token}` }));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "nochannel" });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(store.get(hashToken(token)), "token kept");
});

test("GET /code is 404 nochannel when the door channel now belongs to another user", async () => {
  const token = await tokenFromSignIn();
  const other = { ...DEFAULT_CHANNEL, permission_overwrites: [{ id: "u2", type: 1, allow: VIEW, deny: "0" }] };
  const res = await withChannels([other], () => get("/code", { authorization: `Bearer ${token}` }));
  assert.equal(res.status, 404);
  assert.ok(store.get(hashToken(token)), "token kept");
});

test("GET /code is 409 multiple when more than one door channel matches", async () => {
  const token = await tokenFromSignIn();
  const res = await withChannels([DEFAULT_CHANNEL, { ...DEFAULT_CHANNEL, id: "c2" }], () =>
    get("/code", { authorization: `Bearer ${token}` }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "multiple" });
});

test("GET /code is 502 when the Discord listing fails", async () => {
  const token = await tokenFromSignIn();
  discord.state.listError = new DiscordError(500, "boom");
  const res = await get("/code", { authorization: `Bearer ${token}` });
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
