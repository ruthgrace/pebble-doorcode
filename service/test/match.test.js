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
