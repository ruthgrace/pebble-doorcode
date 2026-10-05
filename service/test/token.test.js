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
