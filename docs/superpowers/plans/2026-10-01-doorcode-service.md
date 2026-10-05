# Door Code Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small self-hosted Node service that lets a member of one Discord server sign in once and then lets their Pebble fetch the door code from the name of their private `🚪:` channel.

**Architecture:** One Node process using only built-in modules (`node:http`, `node:sqlite`, `node:crypto`, `node:test`). A Discord client module wraps the four Discord API calls. Pure functions handle channel matching, code extraction, and token hashing so they can be unit tested. The HTTP app is a factory that takes its dependencies (config, store, Discord client) so tests inject fakes. State is one SQLite table mapping a token hash to a channel ID.

**Tech Stack:** Node >= 22.13 (for unflagged `node:sqlite`), ES modules, no npm dependencies. Deployed as a systemd unit behind nginx on a DigitalOcean Droplet.

**Spec:** `docs/superpowers/specs/2026-10-01-doorcode-design.md`

**One refinement to the spec:** the spec has `GET /auth/start` redirect straight to Discord. To give the settings page a "sign out" button, `/auth/start` instead serves a tiny HTML landing page with two links: "Sign in with Discord" (goes to `GET /auth/discord`, which does the redirect) and "Sign out of this watch" (returns `{"signout":true}` to the Pebble app). Everything else is as specified.

## Global Constraints

- Node version floor: `>=22.13.0` (declared in `package.json` `engines`), because `node:sqlite` is unflagged from 22.13.
- No runtime npm dependencies. `package.json` `dependencies` stays empty.
- OAuth scope is exactly `identify`.
- Tokens: 32 random bytes, base64url on the wire, stored only as SHA-256 hex.
- Service binds to `127.0.0.1` only. nginx terminates TLS.
- Channel match rule: name starts with `🚪` AND has a member-type permission overwrite for the user ID whose `allow` bitfield includes View Channel (`1 << 10`).
- The service never stores a door code.
- Secrets come only from environment variables. Never commit `.env`.

## Review Focus

Inputs the spec implies but which are easy to get wrong. Each has a test pinned in the owning task.

1. A channel name with digits in the middle but not at the end (e.g. `🚪: 12 old 34`) must yield `34`, not `12` or `1234`. (Task 1)
2. A `🚪` channel that grants the user access via a role overwrite rather than a member overwrite must NOT match, because we can't tell which member it's for. (Task 1)
3. An `Authorization` header that is present but malformed (`Bearer` with no token, or `Basic ...`) must return 401, not crash. (Task 5)
4. The OAuth callback with a missing or mismatched `state` must return 400 and never call Discord. (Task 5)
5. When Discord returns 404 for the channel on `/code`, the token row must actually be deleted so the next call is a 401, not another 403. (Task 5)

---

### Task 1: Project scaffold and pure matching functions

**Files:**
- Create: `service/package.json`
- Create: `service/src/match.js`
- Test: `service/test/match.test.js`

**Interfaces:**
- Produces: `extractCode(name: string): string | null`
- Produces: `findUserChannel(channels: Array<{id, name, permission_overwrites?}>, userId: string): { channel } | { error: "none" | "multiple" }`

- [ ] **Step 1: Create `service/package.json`**

```json
{
  "name": "pebble-doorcode-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {}
}
```

- [ ] **Step 2: Write the failing tests**

`service/test/match.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCode, findUserChannel } from "../src/match.js";

const VIEW = String(1 << 10);

test("extractCode returns trailing digits", () => {
  assert.equal(extractCode("🚪: 1234"), "1234");
  assert.equal(extractCode("🚪:1234"), "1234");
  assert.equal(extractCode("🚪: 1234 "), "1234");
});

test("extractCode takes only the trailing run of digits", () => {
  assert.equal(extractCode("🚪: 12 old 34"), "34");
});

test("extractCode returns null when there are no trailing digits", () => {
  assert.equal(extractCode("🚪: tbd"), null);
  assert.equal(extractCode(""), null);
});

test("findUserChannel matches a door channel with a member overwrite for the user", () => {
  const channels = [
    { id: "a", name: "general" },
    { id: "b", name: "🚪: 1111", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] },
    { id: "c", name: "🚪: 2222", permission_overwrites: [{ id: "u2", type: 1, allow: VIEW, deny: "0" }] },
  ];
  assert.deepEqual(findUserChannel(channels, "u1"), { channel: channels[1] });
});

test("findUserChannel ignores role overwrites", () => {
  const channels = [
    { id: "b", name: "🚪: 1111", permission_overwrites: [{ id: "u1", type: 0, allow: VIEW, deny: "0" }] },
  ];
  assert.deepEqual(findUserChannel(channels, "u1"), { error: "none" });
});

test("findUserChannel ignores overwrites that do not allow View Channel", () => {
  const channels = [
    { id: "b", name: "🚪: 1111", permission_overwrites: [{ id: "u1", type: 1, allow: "0", deny: VIEW }] },
  ];
  assert.deepEqual(findUserChannel(channels, "u1"), { error: "none" });
});

test("findUserChannel ignores non-door channels even with a matching overwrite", () => {
  const channels = [
    { id: "b", name: "notes", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] },
  ];
  assert.deepEqual(findUserChannel(channels, "u1"), { error: "none" });
});

test("findUserChannel reports multiple when more than one door channel matches", () => {
  const channels = [
    { id: "b", name: "🚪: 1111", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] },
    { id: "c", name: "🚪: 2222", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] },
  ];
  assert.deepEqual(findUserChannel(channels, "u1"), { error: "multiple" });
});

test("findUserChannel tolerates channels with no permission_overwrites", () => {
  assert.deepEqual(findUserChannel([{ id: "x", name: "🚪: 9" }], "u1"), { error: "none" });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd service && node --test test/match.test.js`
Expected: FAIL with "Cannot find module" for `../src/match.js`.

- [ ] **Step 4: Implement `service/src/match.js`**

```js
export const DOOR_PREFIX = "🚪";
const VIEW_CHANNEL = 1n << 10n;

export function extractCode(name) {
  if (typeof name !== "string") return null;
  const m = /(\d+)\s*$/.exec(name);
  return m ? m[1] : null;
}

function overwriteGrantsView(o, userId) {
  const isMember = o.type === 1 || o.type === "member";
  if (!isMember || o.id !== userId) return false;
  let allow;
  try {
    allow = BigInt(o.allow ?? "0");
  } catch {
    return false;
  }
  return (allow & VIEW_CHANNEL) !== 0n;
}

export function findUserChannel(channels, userId) {
  const matches = channels.filter(
    (c) =>
      typeof c.name === "string" &&
      c.name.startsWith(DOOR_PREFIX) &&
      (c.permission_overwrites ?? []).some((o) => overwriteGrantsView(o, userId)),
  );
  if (matches.length === 0) return { error: "none" };
  if (matches.length > 1) return { error: "multiple" };
  return { channel: matches[0] };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd service && node --test test/match.test.js`
Expected: all 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add service/package.json service/src/match.js service/test/match.test.js
git commit -m "service: scaffold and pure channel matching"
```

---

### Task 2: Token generation and hashing

**Files:**
- Create: `service/src/token.js`
- Test: `service/test/token.test.js`

**Interfaces:**
- Produces: `newToken(): string` (base64url, 43 chars)
- Produces: `hashToken(token: string): string` (64 hex chars)

- [ ] **Step 1: Write the failing tests**

`service/test/token.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { newToken, hashToken } from "../src/token.js";

test("newToken is 32 bytes of base64url", () => {
  const t = newToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(t, "base64url").length, 32);
});

test("newToken is different each call", () => {
  assert.notEqual(newToken(), newToken());
});

test("hashToken is deterministic sha256 hex", () => {
  assert.equal(
    hashToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(hashToken("abc"), hashToken("abc"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd service && node --test test/token.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `service/src/token.js`**

```js
import { randomBytes, createHash } from "node:crypto";

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd service && node --test test/token.test.js`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add service/src/token.js service/test/token.test.js
git commit -m "service: token generation and hashing"
```

---

### Task 3: SQLite token store

**Files:**
- Create: `service/src/store.js`
- Test: `service/test/store.test.js`

**Interfaces:**
- Produces: `openStore(path: string): Store`
- `Store.put({ tokenHash, userId, channelId }): void`
- `Store.get(tokenHash): { tokenHash, userId, channelId, createdAt } | undefined`
- `Store.del(tokenHash): void`
- `Store.close(): void`

- [ ] **Step 1: Write the failing tests**

`service/test/store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.js";

test("put then get returns the row", () => {
  const s = openStore(":memory:");
  s.put({ tokenHash: "h1", userId: "u1", channelId: "c1" });
  const row = s.get("h1");
  assert.equal(row.userId, "u1");
  assert.equal(row.channelId, "c1");
  assert.equal(typeof row.createdAt, "number");
  s.close();
});

test("get of unknown hash is undefined", () => {
  const s = openStore(":memory:");
  assert.equal(s.get("nope"), undefined);
  s.close();
});

test("del removes the row", () => {
  const s = openStore(":memory:");
  s.put({ tokenHash: "h1", userId: "u1", channelId: "c1" });
  s.del("h1");
  assert.equal(s.get("h1"), undefined);
  s.close();
});

test("put with an existing hash replaces the row", () => {
  const s = openStore(":memory:");
  s.put({ tokenHash: "h1", userId: "u1", channelId: "c1" });
  s.put({ tokenHash: "h1", userId: "u1", channelId: "c2" });
  assert.equal(s.get("h1").channelId, "c2");
  s.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd service && node --test test/store.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `service/src/store.js`**

```js
import { DatabaseSync } from "node:sqlite";

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  const putStmt = db.prepare(
    "INSERT OR REPLACE INTO tokens (token_hash, user_id, channel_id, created_at) VALUES (?, ?, ?, ?)",
  );
  const getStmt = db.prepare(
    "SELECT token_hash AS tokenHash, user_id AS userId, channel_id AS channelId, created_at AS createdAt FROM tokens WHERE token_hash = ?",
  );
  const delStmt = db.prepare("DELETE FROM tokens WHERE token_hash = ?");

  return {
    put({ tokenHash, userId, channelId }) {
      putStmt.run(tokenHash, userId, channelId, Date.now());
    },
    get(tokenHash) {
      return getStmt.get(tokenHash);
    },
    del(tokenHash) {
      delStmt.run(tokenHash);
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd service && node --test test/store.test.js`
Expected: 4 PASS. If Node prints an ExperimentalWarning about `node:sqlite`, that is fine.

- [ ] **Step 5: Commit**

```bash
git add service/src/store.js service/test/store.test.js
git commit -m "service: sqlite token store"
```

---

### Task 4: Discord API client

**Files:**
- Create: `service/src/discord.js`
- Test: `service/test/discord.test.js`

**Interfaces:**
- Produces: `class DiscordError extends Error { status: number }`
- Produces: `createDiscordClient({ clientId, clientSecret, botToken, fetchImpl = fetch })` returning:
  - `authorizeUrl(redirectUri, state): string`
  - `exchangeCode(code, redirectUri): Promise<string>` (access token)
  - `getMe(accessToken): Promise<{ id: string }>`
  - `listGuildChannels(guildId): Promise<Array<object>>`
  - `getChannel(channelId): Promise<object>`

All methods throw `DiscordError` with the HTTP status on a non-2xx response.

- [ ] **Step 1: Write the failing tests**

`service/test/discord.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd service && node --test test/discord.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `service/src/discord.js`**

```js
const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(status, message) {
    super(`Discord ${status}: ${message}`);
    this.name = "DiscordError";
    this.status = status;
  }
}

export function createDiscordClient({ clientId, clientSecret, botToken, fetchImpl = fetch }) {
  async function call(path, init = {}) {
    const res = await fetchImpl(API + path, init);
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        if (body && body.message) message = body.message;
      } catch {}
      throw new DiscordError(res.status, message);
    }
    return res.json();
  }

  return {
    authorizeUrl(redirectUri, state) {
      const u = new URL("https://discord.com/oauth2/authorize");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "identify");
      u.searchParams.set("state", state);
      return u.toString();
    },

    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString();
      const json = await call("/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return json.access_token;
    },

    getMe(accessToken) {
      return call("/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } });
    },

    listGuildChannels(guildId) {
      return call(`/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${botToken}` } });
    },

    getChannel(channelId) {
      return call(`/channels/${channelId}`, { headers: { Authorization: `Bot ${botToken}` } });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd service && node --test test/discord.test.js`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add service/src/discord.js service/test/discord.test.js
git commit -m "service: discord api client"
```

---

### Task 5: HTTP app with all endpoints

**Files:**
- Create: `service/src/app.js`
- Create: `service/src/server.js`
- Test: `service/test/app.test.js`

**Interfaces:**
- Consumes: `openStore`, `createDiscordClient`/`DiscordError`, `extractCode`, `findUserChannel`, `newToken`, `hashToken` from Tasks 1 to 4.
- Produces: `createApp({ baseUrl, guildId, store, discord }): (req, res) => void` request handler for `http.createServer`.
- Produces: `src/server.js`, the process entry point reading env vars.

Endpoints implemented here:

| Method and path | Behavior |
| --- | --- |
| `GET /auth/start` | HTML landing page with "Sign in with Discord" link to `/auth/discord` and "Sign out of this watch" link to `pebblejs://close#%7B%22signout%22%3Atrue%7D` |
| `GET /auth/discord` | Sets `state` cookie (HttpOnly, SameSite=Lax, Max-Age=600), 302 to Discord authorize URL |
| `GET /auth/callback` | Validates `state` against cookie (400 on mismatch), exchanges code, gets user ID, lists channels, matches. On one match: creates token, stores hash, returns HTML that navigates to `pebblejs://close#<encoded {"token":...}>`. On none: 200 HTML "No door code channel found for your account." On multiple: 200 HTML "Multiple door code channels found, contact the admin." |
| `GET /code` | Bearer token required. 401 unknown or malformed. Fetches channel. 200 `{code, channel}`. 403 `{error:"reauth"}` and row deleted on Discord 403/404. 422 `{error:"unparseable"}` if no trailing digits. 502 `{error:"discord"}` on other Discord errors. |
| `POST /auth/revoke` | Bearer token required. Deletes row. 204. Unknown token still 204. |
| anything else | 404 `{error:"not found"}` |

- [ ] **Step 1: Write the failing tests**

`service/test/app.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd service && node --test test/app.test.js`
Expected: FAIL, module `../src/app.js` not found.

- [ ] **Step 3: Implement `service/src/app.js`**

```js
import { DiscordError } from "./discord.js";
import { extractCode, findUserChannel } from "./match.js";
import { newToken, hashToken } from "./token.js";

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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
        { "Set-Cookie": "state=; Max-Age=0; Path=/auth" });
    }

    if (route === "GET /code") {
      const token = bearer(req);
      if (!token) return sendJson(res, 401, { error: "unauthorized" });
      const h = hashToken(token);
      const row = store.get(h);
      if (!row) return sendJson(res, 401, { error: "unauthorized" });
      let channel;
      try {
        channel = await discord.getChannel(row.channelId);
      } catch (e) {
        if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
          store.del(h);
          return sendJson(res, 403, { error: "reauth" });
        }
        return sendJson(res, 502, { error: "discord" });
      }
      const code = extractCode(channel.name);
      if (!code) return sendJson(res, 422, { error: "unparseable" });
      return sendJson(res, 200, { code, channel: channel.name });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd service && node --test test/app.test.js`
Expected: 17 PASS.

- [ ] **Step 5: Create the entry point `service/src/server.js`**

```js
import http from "node:http";
import { createApp } from "./app.js";
import { openStore } from "./store.js";
import { createDiscordClient } from "./discord.js";

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const config = {
  baseUrl: env("BASE_URL").replace(/\/$/, ""),
  guildId: env("DISCORD_GUILD_ID"),
  clientId: env("DISCORD_CLIENT_ID"),
  clientSecret: env("DISCORD_CLIENT_SECRET"),
  botToken: env("DISCORD_BOT_TOKEN"),
  dbPath: env("DB_PATH", "./doorcode.sqlite"),
  port: Number(env("PORT", "8787")),
};

const store = openStore(config.dbPath);
const discord = createDiscordClient(config);
const server = http.createServer(createApp({ ...config, store, discord }));

server.listen(config.port, "127.0.0.1", () => {
  console.log(`doorcode service listening on 127.0.0.1:${config.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
```

- [ ] **Step 6: Smoke-run the entry point**

Run:
```bash
cd service && BASE_URL=http://localhost:8787 DISCORD_GUILD_ID=g DISCORD_CLIENT_ID=c DISCORD_CLIENT_SECRET=s DISCORD_BOT_TOKEN=b DB_PATH=:memory: node src/server.js &
sleep 1; curl -s -i http://127.0.0.1:8787/auth/start | head -3; curl -s http://127.0.0.1:8787/code; kill %1
```
Expected: `HTTP/1.1 200 OK` for the landing page and `{"error":"unauthorized"}` for `/code`.

- [ ] **Step 7: Run the whole suite**

Run: `cd service && npm test`
Expected: all tests across the four test files PASS.

- [ ] **Step 8: Commit**

```bash
git add service/src/app.js service/src/server.js service/test/app.test.js
git commit -m "service: http app with auth, code, and revoke endpoints"
```

---

### Task 6: Deployment files and service README

**Files:**
- Create: `service/deploy/doorcode.service`
- Create: `service/deploy/nginx.conf`
- Create: `service/deploy/doorcode.env.example`
- Create: `service/README.md`

**Interfaces:**
- Consumes: env var names from Task 5's `server.js`.

- [ ] **Step 1: Create `service/deploy/doorcode.env.example`**

```
BASE_URL=https://doorcode.example.com
DISCORD_GUILD_ID=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DB_PATH=/var/lib/doorcode/doorcode.sqlite
PORT=8787
```

- [ ] **Step 2: Create `service/deploy/doorcode.service`**

```ini
[Unit]
Description=Pebble door code service
After=network.target

[Service]
Type=simple
User=doorcode
Group=doorcode
WorkingDirectory=/opt/doorcode/service
EnvironmentFile=/etc/doorcode.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/doorcode

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create `service/deploy/nginx.conf`**

```nginx
# Include from your existing nginx config, or drop into /etc/nginx/sites-available/doorcode
# and symlink into sites-enabled. Obtain the certificate with certbot first.
server {
    listen 443 ssl http2;
    server_name doorcode.example.com;

    ssl_certificate     /etc/letsencrypt/live/doorcode.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/doorcode.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8787;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_read_timeout 15s;
    }
}
```

- [ ] **Step 4: Write `service/README.md`**

```markdown
# Door code service

Reads a member's door code from the name of their private `🚪:` channel in
one Discord server and serves it to the Pebble watchapp.

## Requirements

- Node 22.13 or newer (uses the built-in `node:sqlite`).
- A domain pointed at your server with nginx and a TLS certificate.
- A Discord application with a bot, invited to the server.

## Discord setup

1. Go to https://discord.com/developers/applications and create an application.
2. Under **OAuth2**, add the redirect `https://YOUR_DOMAIN/auth/callback`.
   Copy the Client ID and Client Secret.
3. Under **Bot**, create the bot and copy its token. No privileged intents are needed.
4. Build an invite URL with only the **View Channels** permission:
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=1024`
   Send it to a server admin to approve.
5. The admin must make sure the bot can see each member's private `🚪:` channel
   (for example by adding the bot's role to those channels).
6. Copy the server ID (enable Developer Mode in Discord, right-click the server, Copy ID).

## Install on the server

```bash
sudo useradd --system --home /opt/doorcode --shell /usr/sbin/nologin doorcode
sudo mkdir -p /opt/doorcode /var/lib/doorcode
sudo git clone https://github.com/ruthgrace/pebble-doorcode /opt/doorcode
sudo chown -R doorcode:doorcode /opt/doorcode /var/lib/doorcode
sudo cp /opt/doorcode/service/deploy/doorcode.env.example /etc/doorcode.env
sudo chmod 600 /etc/doorcode.env
sudo nano /etc/doorcode.env   # fill in the values
sudo cp /opt/doorcode/service/deploy/doorcode.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doorcode
sudo journalctl -u doorcode -f
```

Then add the nginx server block from `deploy/nginx.conf` with your domain,
run `sudo nginx -t && sudo systemctl reload nginx`.

## Verify

Open `https://YOUR_DOMAIN/auth/start` in a browser. Signing in should end on
a page that tries to open `pebblejs://close#...`. In a normal browser that link
does nothing, which is expected; it works inside the Pebble phone app.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /auth/start` | Settings landing page used by the watchapp |
| `GET /auth/discord` | Begins Discord OAuth |
| `GET /auth/callback` | OAuth return; issues a token |
| `GET /code` | `Authorization: Bearer <token>` returns `{ "code": "1234", "channel": "🚪: 1234" }` |
| `POST /auth/revoke` | Deletes the token |

Error responses from `/code`: 401 bad token, 403 `{"error":"reauth"}` (channel
gone or bot lost access; token deleted), 422 `{"error":"unparseable"}`,
502 `{"error":"discord"}`.

## Development

```bash
cd service
npm test
```
```

- [ ] **Step 5: Commit**

```bash
git add service/deploy service/README.md
git commit -m "service: deployment files and README"
```

---

### Task 7: Real-world verification against Discord (manual, after deploy)

**Files:** none. This task is a checklist for the human running the Droplet. It is here so the plan ends with the service proven, not just tested against fakes.

- [ ] **Step 1: Deploy** following `service/README.md`.

- [ ] **Step 2: Confirm the bot can see your channel**

Run on any machine with the bot token:
```bash
curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  "https://discord.com/api/v10/guilds/$DISCORD_GUILD_ID/channels" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s))if(c.name.startsWith("🚪"))console.log(c.id,c.name,JSON.stringify(c.permission_overwrites))})'
```
Expected: at least one line listing your `🚪:` channel with an overwrite whose `id` is your Discord user ID and `type` is `1`. If nothing prints, the bot can't see the private channels yet; go back to the admin.

- [ ] **Step 3: Sign in from a phone browser** at `https://YOUR_DOMAIN/auth/start`. Expected: ends on the "Signed in" page. Note: the final `pebblejs://close` navigation only works inside the Pebble app; in a plain browser, view the page source or use the "Continue" link's href to copy the token for the next step.

- [ ] **Step 4: Fetch the code**

```bash
curl -s -H "Authorization: Bearer PASTE_TOKEN" https://YOUR_DOMAIN/code
```
Expected: `{"code":"1234","channel":"🚪: 1234"}` with your actual code.

- [ ] **Step 5: Revoke and confirm**

```bash
curl -s -i -X POST -H "Authorization: Bearer PASTE_TOKEN" https://YOUR_DOMAIN/auth/revoke | head -1
curl -s -H "Authorization: Bearer PASTE_TOKEN" https://YOUR_DOMAIN/code
```
Expected: `HTTP/2 204` then `{"error":"unauthorized"}`.
