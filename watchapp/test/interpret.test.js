import { test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../src/embeddedjs/interpret.js";

test("200 with a code is ok", () => {
  assert.deepEqual(interpret({ status: 200, body: { code: "1234", channel: "🚪: 1234" } }), { kind: "ok", code: "1234" });
});

test("200 with a missing or empty code is stale", () => {
  assert.deepEqual(interpret({ status: 200, body: {} }), { kind: "stale" });
  assert.deepEqual(interpret({ status: 200, body: { code: "" } }), { kind: "stale" });
});

test("403 is reauth", () => {
  assert.deepEqual(interpret({ status: 403, body: { error: "reauth" } }), { kind: "reauth" });
});

test("401 is also reauth", () => {
  assert.deepEqual(interpret({ status: 401, body: { error: "unauthorized" } }), { kind: "reauth" });
});

test("422 is unparseable", () => {
  assert.deepEqual(interpret({ status: 422, body: { error: "unparseable" } }), { kind: "unparseable" });
});

test("502 and 500 are stale", () => {
  assert.deepEqual(interpret({ status: 502, body: { error: "discord" } }), { kind: "stale" });
  assert.deepEqual(interpret({ status: 500 }), { kind: "stale" });
});

test("a transport error is stale", () => {
  assert.deepEqual(interpret({ error: true }), { kind: "stale" });
});
