import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/app.js";
import { openStore } from "../src/store.js";

const VIEW = String(1 << 10);

test("pairing codes expire after the TTL and the failure brake returns 429", async () => {
  let clock = 1_000_000;
  const store = openStore(":memory:");
  const discord = {
    authorizeUrl: (r, st) => `https://discord.com/oauth2/authorize?state=${st}`,
    async exchangeCode() { return "at"; },
    async getMe() { return { id: "u1" }; },
    async listGuildChannels() { return [{ id: "c1", name: "🚪 Code: 1#", permission_overwrites: [{ id: "u1", type: 1, allow: VIEW, deny: "0" }] }]; },
  };
  const server = http.createServer(createApp({ baseUrl: "https://dc.test", guildId: "g", store, discord, pairTtlMs: 1000, now: () => clock }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(base + "/auth/discord", { redirect: "manual" });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const st = cookie.slice("state=".length);
    const html = await (await fetch(`${base}/auth/callback?code=x&state=${st}`, { headers: { cookie } })).text();
    const code = /<b id="paircode">([A-Z2-9]{6})<\/b>/.exec(html)[1];
    clock += 1001;
    const expired = await fetch(base + "/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    assert.equal(expired.status, 404);
    for (let i = 0; i < 19; i++) {
      await fetch(base + "/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "BADBAD" }) });
    }
    const braked = await fetch(base + "/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "BADBAD" }) });
    assert.equal(braked.status, 429);
    clock += 61_000;
    const after = await fetch(base + "/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "BADBAD" }) });
    assert.equal(after.status, 404);
  } finally {
    server.close();
    store.close();
  }
});
