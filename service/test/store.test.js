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

test("count returns the number of rows", () => {
  const s = openStore(":memory:");
  assert.equal(s.count(), 0);
  s.put({ tokenHash: "h1", userId: "u1", channelId: "c1" });
  s.put({ tokenHash: "h2", userId: "u2", channelId: "c2" });
  assert.equal(s.count(), 2);
  s.del("h1");
  assert.equal(s.count(), 1);
  s.close();
});
