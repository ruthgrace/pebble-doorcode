import { test } from "node:test";
import assert from "node:assert/strict";
import { statusLine, bigText } from "../src/embeddedjs/status.js";

// Local-time fixtures (status.js reads weekday/date in local time).
// 2026-10-01 is a Thursday. 2026-09-29 is a Tuesday.
const THU = new Date(2026, 9, 1, 12).getTime();
const TUE = new Date(2026, 8, 29, 12).getTime();

test("notoken", () => {
  assert.equal(statusLine({ kind: "notoken" }, null, THU), "Set up in phone app settings");
});

test("loading with no cache", () => {
  assert.equal(statusLine({ kind: "loading" }, null, THU), "loading...");
});

test("loading with a cache shows the cached label", () => {
  assert.equal(statusLine({ kind: "loading" }, String(TUE), THU), "cached, from Tue");
});

test("ok", () => {
  assert.equal(statusLine({ kind: "ok", code: "1" }, String(THU), THU), "just now");
});

test("reauth", () => {
  assert.equal(statusLine({ kind: "reauth" }, String(TUE), THU), "Sign in again in settings");
});

test("unparseable", () => {
  assert.equal(statusLine({ kind: "unparseable" }, String(TUE), THU), "Code unreadable");
});

test("stale with a cache names the weekday", () => {
  assert.equal(statusLine({ kind: "stale" }, String(TUE), THU), "cached, from Tue");
});

test("stale fetched today says today", () => {
  assert.equal(statusLine({ kind: "stale" }, String(THU - 3600_000), THU), "cached, from today");
});

test("stale with no cache", () => {
  assert.equal(statusLine({ kind: "stale" }, null, THU), "Phone not reachable. Reopen app.");
});

test("stale with a garbage fetchedAt does not say Invalid Date", () => {
  assert.equal(statusLine({ kind: "stale" }, "banana", THU), "cached");
});

test("bigText prefers the fresh code, then the cache, then dashes", () => {
  assert.equal(bigText({ kind: "ok", code: "1234" }, "9999"), "1234");
  assert.equal(bigText({ kind: "stale" }, "9999"), "9999");
  assert.equal(bigText({ kind: "unparseable" }, "9999"), "9999");
  assert.equal(bigText({ kind: "stale" }, null), "----");
  assert.equal(bigText({ kind: "notoken" }, "9999"), "----");
  assert.equal(bigText({ kind: "reauth" }, "9999"), "----");
});

test("stale 6.5 days old still names the weekday", () => {
  const t = THU - 6.5 * 86400_000;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(t).getDay()];
  assert.equal(statusLine({ kind: "stale" }, String(t), THU), `cached, from ${day}`);
});

test("stale 7.5 days old says over a week old", () => {
  assert.equal(statusLine({ kind: "stale" }, String(THU - 7.5 * 86400_000), THU), "cached, over a week old");
});
