# Door Code Watchapp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Alloy (Moddable JS) watchapp for the Pebble Time 2 that, when launched from Quick Launch, shows the door code fetched from the service, with an offline cache and a phone-side settings page for Discord sign-in.

**Architecture:** Watch-side code is split into pure modules (`interpret.js` maps an HTTP result to a view state, `status.js` turns a view state into the status line) that are unit tested with Node, plus a thin `display.js` for Poco drawing and `main.js` for orchestration. The phone-side `pkjs/index.js` registers the network proxy, opens the service's settings page, and relays the token to the watch over app messages, persisting it on the phone so it can be re-sent whenever the watchapp launches.

**Tech Stack:** pebble-tool (installed with uv), Pebble SDK with Alloy/Moddable, `@moddable/pebbleproxy`, Poco renderer with BMF fonts from the Moddable SDK assets. Node >= 22.7 for the pure-module tests (module syntax detection).

**Spec:** `docs/superpowers/specs/2026-10-01-doorcode-design.md`

**Depends on:** the service plan (`2026-10-01-doorcode-service.md`) being deployed, for Tasks 5 and 6. Tasks 1 to 4 need no service.

## Global Constraints

- Project type is a **watchapp**: `"watchapp": { "watchface": false }` in `watchapp/package.json`, so it appears in Quick Launch.
- Target platform: `emery` only.
- `capabilities` includes `"configurable"` so the Pebble phone app shows the settings gear.
- Message keys are exactly `TOKEN` and `SIGNOUT`, declared in `package.json` `messageKeys`.
- Fetch timeout is 8 seconds.
- Nothing is drawn with a font other than the two BMF fonts declared in the manifest (64 px digits, 16 px Basic Latin) and a 40 px digits fallback for codes wider than the screen.
- The Back button is not subscribed, so the firmware's default Back handling exits the app.
- `localStorage` keys on the watch: `token`, `code`, `fetchedAt` (ms since epoch as a string).
- `BASE_URL` lives in one place per side: `src/embeddedjs/config.js` and the top of `src/pkjs/index.js`.

## Review Focus

1. A code of 6 or more digits is wider than the 200 px screen at 64 px; it must fall back to the 40 px font rather than clip. (Task 4, verified in the emulator with a fake code.)
2. A 401 from the service (token revoked) must be treated like 403: clear the token and show "Sign in again in settings", not "cached". (Task 2)
3. A fetch that rejects (network error, timeout) with no cached code must show "no code yet" and dashes, never a blank screen or a crash. (Task 2 and Task 3)
4. `fetchedAt` stored as a string must round-trip to a weekday label without producing "Invalid Date". (Task 3)
5. The phone must re-send the stored token on every `ready` so that a token saved while the watchapp was closed still reaches the watch. (Task 5)

---

### Task 1: Toolchain and project scaffold

**Files:**
- Create: `watchapp/` via `pebble new-project --alloy`
- Modify: `watchapp/package.json`
- Create: `watchapp/src/embeddedjs/config.js`

**Interfaces:**
- Produces: `config.js` exporting `BASE_URL` (string) and `FETCH_TIMEOUT_MS` (number, 8000).

- [ ] **Step 1: Install the Pebble tool and SDK (skip any step already done)**

```bash
brew install uv libpng
uv tool install pebble-tool
pebble sdk install latest
pebble --version
```
Expected: `pebble --version` prints a version. If `pebble` is not on PATH, run `uv tool update-shell` and open a new terminal.

- [ ] **Step 2: Scaffold the project**

```bash
cd /Users/ruthgracewong/pebble/doorcode
pebble new-project --alloy watchapp
ls watchapp watchapp/src/embeddedjs watchapp/src/pkjs
```
Expected: `watchapp/package.json`, `watchapp/wscript`, `watchapp/src/embeddedjs/main.js`, `watchapp/src/embeddedjs/manifest.json`, `watchapp/src/pkjs/index.js`, `watchapp/src/c/`.

- [ ] **Step 3: Install the network proxy package**

```bash
cd watchapp && pebble package install @moddable/pebbleproxy
```
Expected: `@moddable/pebbleproxy` appears under `dependencies` in `watchapp/package.json` and `node_modules/@moddable/pebbleproxy` exists.

- [ ] **Step 4: Edit `watchapp/package.json`**

Keep the generated `uuid`. Set the following fields so the `pebble` section reads:

```json
"pebble": {
  "displayName": "Door Code",
  "uuid": "KEEP-THE-GENERATED-UUID",
  "projectType": "moddable",
  "sdkVersion": "3",
  "enableMultiJS": true,
  "targetPlatforms": ["emery"],
  "watchapp": { "watchface": false },
  "capabilities": ["configurable"],
  "messageKeys": ["TOKEN", "SIGNOUT"],
  "resources": { "media": [] }
}
```

Also set top-level `"name": "pebble-doorcode-watchapp"` and `"author"` to your name.

- [ ] **Step 5: Create `watchapp/src/embeddedjs/config.js`**

```js
// Set this to the public origin of your deployed service, no trailing slash.
export const BASE_URL = "https://doorcode.example.com";
export const FETCH_TIMEOUT_MS = 8000;
```

- [ ] **Step 6: Build to confirm the toolchain works**

```bash
cd watchapp && pebble build
```
Expected: ends with `'build' finished successfully` and a `build/*.pbw` file exists. The generated `main.js` is still the scaffold's hello world at this point.

- [ ] **Step 7: Add a gitignore and commit**

`watchapp/.gitignore`:
```
build/
node_modules/
```

```bash
cd /Users/ruthgracewong/pebble/doorcode
git add watchapp
git commit -m "watchapp: scaffold alloy project with proxy and config"
```

---

### Task 2: Pure response interpretation

**Files:**
- Create: `watchapp/src/embeddedjs/interpret.js`
- Create: `watchapp/test/interpret.test.js`
- Create: `watchapp/test/package.json`

**Interfaces:**
- Produces: `interpret(result: { status: number, body?: any } | { error: true }): View`
- `View` is one of:
  - `{ kind: "ok", code: string }`
  - `{ kind: "reauth" }`
  - `{ kind: "unparseable" }`
  - `{ kind: "stale" }`

- [ ] **Step 1: Create `watchapp/test/package.json`** so the tests are ESM regardless of the watchapp's own package.json:

```json
{ "type": "module" }
```

- [ ] **Step 2: Write the failing tests**

`watchapp/test/interpret.test.js`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd watchapp && node --test test/interpret.test.js`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `watchapp/src/embeddedjs/interpret.js`**

```js
export function interpret(result) {
  if (!result || result.error) return { kind: "stale" };
  const { status, body } = result;
  if (status === 200) {
    const code = body && typeof body.code === "string" ? body.code : "";
    return code ? { kind: "ok", code } : { kind: "stale" };
  }
  if (status === 401 || status === 403) return { kind: "reauth" };
  if (status === 422) return { kind: "unparseable" };
  return { kind: "stale" };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd watchapp && node --test test/interpret.test.js`
Expected: 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add watchapp/src/embeddedjs/interpret.js watchapp/test
git commit -m "watchapp: interpret service responses"
```

---

### Task 3: Pure status line

**Files:**
- Create: `watchapp/src/embeddedjs/status.js`
- Create: `watchapp/test/status.test.js`

**Interfaces:**
- Produces: `statusLine(view: View | { kind: "notoken" } | { kind: "loading" }, fetchedAt: string | null, now: number): string`
- Produces: `bigText(view, cachedCode: string | null): string` returning what goes in the large font.

- [ ] **Step 1: Write the failing tests**

`watchapp/test/status.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusLine, bigText } from "../src/embeddedjs/status.js";

// 2026-10-01 is a Thursday. 2026-09-29 is a Tuesday.
const THU = Date.UTC(2026, 9, 1, 12);
const TUE = Date.UTC(2026, 8, 29, 12);

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
  assert.equal(statusLine({ kind: "stale" }, null, THU), "no code yet");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd watchapp && node --test test/status.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `watchapp/src/embeddedjs/status.js`**

```js
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400_000;

function cachedLabel(fetchedAt, now) {
  const t = Number(fetchedAt);
  if (!fetchedAt || !Number.isFinite(t)) return "cached";
  const then = new Date(t);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  if (sameDay) return "cached, from today";
  if (now - t > 6 * DAY_MS) return "cached, over a week old";
  return `cached, from ${DAYS[then.getDay()]}`;
}

export function statusLine(view, fetchedAt, now) {
  switch (view.kind) {
    case "notoken":
      return "Set up in phone app settings";
    case "loading":
      return fetchedAt ? cachedLabel(fetchedAt, now) : "loading...";
    case "ok":
      return "just now";
    case "reauth":
      return "Sign in again in settings";
    case "unparseable":
      return "Code unreadable";
    case "stale":
    default:
      return fetchedAt ? cachedLabel(fetchedAt, now) : "no code yet";
  }
}

export function bigText(view, cachedCode) {
  if (view.kind === "ok") return view.code;
  if (view.kind === "notoken" || view.kind === "reauth") return "----";
  return cachedCode || "----";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd watchapp && node --test test/status.test.js`
Expected: 11 PASS. (The "garbage fetchedAt" case passes because `Number("banana")` is NaN.)

- [ ] **Step 5: Commit**

```bash
git add watchapp/src/embeddedjs/status.js watchapp/test/status.test.js
git commit -m "watchapp: status line and big text selection"
```

---

### Task 4: Display and main flow, verified in the emulator

**Files:**
- Modify: `watchapp/src/embeddedjs/manifest.json`
- Create: `watchapp/src/embeddedjs/display.js`
- Modify: `watchapp/src/embeddedjs/main.js` (replace scaffold contents)

**Interfaces:**
- Consumes: `interpret`, `statusLine`, `bigText`, `BASE_URL`, `FETCH_TIMEOUT_MS`.
- Produces: `createDisplay(): { draw(big: string, status: string): void }`
- Produces: `main.js` with `refresh()` (fetches and redraws) and `render(view)`.

- [ ] **Step 1: Replace `watchapp/src/embeddedjs/manifest.json`**

```json
{
  "include": [
    "$(MODDABLE)/examples/manifest_mod.json",
    "$(MODDABLE)/examples/manifest_typings.json"
  ],
  "modules": {
    "*": ["./main", "./display", "./interpret", "./status", "./config"]
  },
  "resources": {
    "*-alpha": [
      {
        "source": "$(MODDABLE)/examples/assets/scalablefonts/OpenSans/OpenSans-Regular",
        "size": 64,
        "monochrome": true,
        "characters": "0123456789-"
      },
      {
        "source": "$(MODDABLE)/examples/assets/scalablefonts/OpenSans/OpenSans-Regular",
        "size": 40,
        "monochrome": true,
        "characters": "0123456789-"
      },
      {
        "source": "$(MODDABLE)/examples/assets/scalablefonts/OpenSans/OpenSans-Regular",
        "size": 16,
        "monochrome": true,
        "blocks": ["Basic Latin"]
      }
    ]
  }
}
```

- [ ] **Step 2: Create `watchapp/src/embeddedjs/display.js`**

```js
import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import parseRLE from "commodetto/parseRLE";

function getFont(name, size) {
  const font = parseBMF(new Resource(`${name}-${size}.fnt`));
  font.bitmap = parseRLE(new Resource(`${name}-${size}-alpha.bm4`));
  return font;
}

export function createDisplay() {
  const render = new Poco(screen);
  const black = render.makeColor(0, 0, 0);
  const white = render.makeColor(255, 255, 255);
  const bigFont = getFont("OpenSans-Regular", 64);
  const mediumFont = getFont("OpenSans-Regular", 40);
  const smallFont = getFont("OpenSans-Regular", 16);
  const margin = 8;

  function centered(text, font, color, y) {
    const w = render.getTextWidth(text, font);
    render.drawText(text, font, color, (render.width - w) >> 1, y);
  }

  return {
    draw(big, status) {
      let font = bigFont;
      if (render.getTextWidth(big, font) > render.width - 2 * margin) font = mediumFont;
      render.begin(0, 0, render.width, render.height);
      render.fillRectangle(white, 0, 0, render.width, render.height);
      centered(big, font, black, ((render.height - font.height) >> 1) - 12);
      centered(status, smallFont, black, render.height - smallFont.height - margin);
      render.end();
    },
  };
}
```

- [ ] **Step 3: Replace `watchapp/src/embeddedjs/main.js`**

```js
import Message from "pebble/message";
import { createDisplay } from "./display";
import { interpret } from "./interpret";
import { statusLine, bigText } from "./status";
import { BASE_URL, FETCH_TIMEOUT_MS } from "./config";

const display = createDisplay();

let token = localStorage.getItem("token");
let cachedCode = localStorage.getItem("code");
let fetchedAt = localStorage.getItem("fetchedAt");

function render(view) {
  display.draw(bigText(view, cachedCode), statusLine(view, fetchedAt, Date.now()));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function fetchCode() {
  try {
    const response = await withTimeout(
      fetch(`${BASE_URL}/code`, { headers: { Authorization: `Bearer ${token}` } }),
      FETCH_TIMEOUT_MS,
    );
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  } catch (e) {
    console.log(`fetch failed: ${e}`);
    return { error: true };
  }
}

let refreshing = false;
async function refresh() {
  if (!token) return render({ kind: "notoken" });
  if (refreshing) return;
  refreshing = true;
  render({ kind: "loading" });
  const view = interpret(await fetchCode());
  refreshing = false;
  if (view.kind === "ok") {
    cachedCode = view.code;
    fetchedAt = String(Date.now());
    localStorage.setItem("code", cachedCode);
    localStorage.setItem("fetchedAt", fetchedAt);
  } else if (view.kind === "reauth") {
    token = null;
    localStorage.removeItem("token");
  }
  render(view);
}

async function signOut() {
  if (token) {
    try {
      await withTimeout(
        fetch(`${BASE_URL}/auth/revoke`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }),
        FETCH_TIMEOUT_MS,
      );
    } catch (e) {
      console.log(`revoke failed: ${e}`);
    }
  }
  token = null;
  cachedCode = null;
  fetchedAt = null;
  localStorage.removeItem("token");
  localStorage.removeItem("code");
  localStorage.removeItem("fetchedAt");
  render({ kind: "notoken" });
}

new Message({
  keys: ["TOKEN", "SIGNOUT"],
  onReadable() {
    const msg = this.read();
    if (msg.has("SIGNOUT")) return void signOut();
    const t = msg.get("TOKEN");
    if (typeof t === "string" && t.length) {
      token = t;
      localStorage.setItem("token", token);
      refresh();
    }
  },
});

// Draw immediately so the screen is never blank, then fetch once the phone proxy is up.
render(token ? { kind: "loading" } : { kind: "notoken" });

if (token) {
  if (watch.connected.pebblekit) refresh();
  else watch.addEventListener("connected", () => { if (watch.connected.pebblekit) refresh(); });
}

export {};
```

- [ ] **Step 4: Build and run in the emulator, no-token state**

```bash
cd watchapp && pebble build && pebble install --emulator emery && pebble logs --emulator emery
```
Expected: the emulator shows `----` in large digits and "Set up in phone app settings" at the bottom. No errors in the logs. Press Back in the emulator (the `q` key or the back button in the window); the app exits to the watchface.

- [ ] **Step 5: Verify the cached-state rendering and the wide-code fallback with a temporary stub**

Temporarily add these two lines right after the three `localStorage.getItem` lines in `main.js`:

```js
cachedCode = "123456"; fetchedAt = String(Date.now() - 2 * 86400000); token = null;
```

Rebuild and install. Expected: `123456` drawn in the 40 px font (it is wider than 184 px at 64 px) and the status line reads "Set up in phone app settings" because `token` is null. Change `"123456"` to `"1234"` and rebuild: it is now drawn in the 64 px font. Then **remove the stub lines** before continuing.

- [ ] **Step 6: Run the pure tests once more and commit**

```bash
cd watchapp && node --test test/ && cd .. && git add watchapp && git commit -m "watchapp: display and main flow"
```

---

### Task 5: Phone side: proxy, settings page, token relay

**Files:**
- Modify: `watchapp/src/pkjs/index.js` (replace scaffold contents)

**Interfaces:**
- Consumes: service endpoints `GET /auth/start` and the `pebblejs://close#` payloads `{"token": "..."}` and `{"signout": true}`.
- Produces: app messages to the watch with key `TOKEN` (string) or `SIGNOUT` (1).

- [ ] **Step 1: Replace `watchapp/src/pkjs/index.js`**

```js
var moddableProxy = require("@moddable/pebbleproxy");

// Set this to the public origin of your deployed service, no trailing slash.
var BASE_URL = "https://doorcode.example.com";

function sendToken(token) {
  Pebble.sendAppMessage({ TOKEN: token },
    function () { console.log("token sent to watch"); },
    function (e) { console.log("token send failed: " + JSON.stringify(e)); });
}

function sendSignout() {
  Pebble.sendAppMessage({ SIGNOUT: 1 },
    function () { console.log("signout sent to watch"); },
    function (e) { console.log("signout send failed: " + JSON.stringify(e)); });
}

Pebble.addEventListener("ready", function (e) {
  moddableProxy.readyReceived(e);
  var pending = localStorage.getItem("pendingSignout");
  if (pending) {
    localStorage.removeItem("pendingSignout");
    sendSignout();
    return;
  }
  var token = localStorage.getItem("token");
  if (token) sendToken(token);
});

Pebble.addEventListener("appmessage", function (e) {
  if (moddableProxy.appMessageReceived(e)) return;
});

Pebble.addEventListener("showConfiguration", function () {
  Pebble.openURL(BASE_URL + "/auth/start");
});

Pebble.addEventListener("webviewclosed", function (e) {
  if (!e.response) return;
  var data;
  try {
    data = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    console.log("bad config response: " + e.response);
    return;
  }
  if (data.signout) {
    localStorage.removeItem("token");
    localStorage.setItem("pendingSignout", "1");
    sendSignout();
  } else if (typeof data.token === "string" && data.token.length) {
    localStorage.setItem("token", data.token);
    sendToken(data.token);
  }
});
```

Note on `pendingSignout`: the watch does the revoke call itself (it holds the token). The phone just remembers that a sign-out happened in case the watchapp was closed at the time, and relays it on the next launch.

- [ ] **Step 2: Build**

```bash
cd watchapp && pebble build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
cd /Users/ruthgracewong/pebble/doorcode && git add watchapp/src/pkjs/index.js && git commit -m "watchapp: phone-side proxy, settings page, and token relay"
```

---

### Task 6: End-to-end on the real watch

**Files:**
- Modify: `watchapp/src/embeddedjs/config.js` and `watchapp/src/pkjs/index.js` with the real `BASE_URL`.

This task needs the service deployed (service plan, Task 7) and the phone and watch available.

- [ ] **Step 1: Set the real `BASE_URL`** in both files, rebuild, and commit.

```bash
cd watchapp && pebble build && cd .. && git commit -am "watchapp: point at deployed service"
```

- [ ] **Step 2: Install to the watch**

Enable Developer Connection in the Pebble phone app, note the phone's IP, then:
```bash
cd watchapp && pebble install --phone PHONE_IP && pebble logs --phone PHONE_IP
```
Expected: the app launches on the watch showing `----` and "Set up in phone app settings".

- [ ] **Step 3: Sign in from the settings page**

In the Pebble phone app, open the Door Code app's settings (gear icon). Expected: the service's landing page opens. Tap "Sign in with Discord", authorize, and the page closes itself. In the logs: "token sent to watch". The watch redraws with the real code and "just now".

- [ ] **Step 4: Relaunch and confirm the cache**

Exit with Back, relaunch the app. Expected: the cached code appears immediately with "cached, from today" and then "just now" after the fetch.

- [ ] **Step 5: Offline behavior**

Turn Bluetooth off on the phone, launch the app. Expected: cached code with "cached, from today" (or the weekday) and no crash. Turn Bluetooth back on.

- [ ] **Step 6: Quick Launch**

On the watch: Settings > Quick Launch > choose a button > Door Code. From the watchface, long-press that button. Expected: the app launches and shows the code.

- [ ] **Step 7: Sign out**

Open settings in the phone app, tap "Sign out of this watch". Expected: the watch shows `----` and "Set up in phone app settings"; `curl` with the old token against `/code` now returns 401.

- [ ] **Step 8: Reauth path**

Sign in again, then on the server delete the token row (or revoke with curl). Launch the app. Expected: "Sign in again in settings" with `----`.

---

### Task 7: Root README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md`**

```markdown
# pebble-doorcode

Long-press a button on a Pebble Time 2 and see your door code.

The code lives in the name of a private `🚪:` channel in a Discord server.
A small self-hosted service reads it with a bot, and the watchapp fetches it
through the phone when launched from Quick Launch. Members sign in with
Discord once from the app's settings page.

- `service/` the Node service. See `service/README.md` for Discord setup and deployment.
- `watchapp/` the Alloy (Moddable JS) watchapp. See below.
- `docs/superpowers/specs/` the design.

## Building the watchapp

Requires [pebble-tool](https://developer.repebble.com/sdk/) with the Alloy SDK.

```bash
cd watchapp
# set BASE_URL in src/embeddedjs/config.js and src/pkjs/index.js
pebble package install @moddable/pebbleproxy
pebble build
pebble install --phone YOUR_PHONE_IP
```

Then on the watch: Settings > Quick Launch > pick a button > Door Code.

## Tests

```bash
(cd service && npm test)
(cd watchapp && node --test test/)
```

## Security notes

The watch stores a per-user random token and the last code. The service
stores only a hash of the token and the ID of the user's channel. Nothing
stores the code server-side. All traffic is HTTPS.
```

- [ ] **Step 2: Commit and push**

```bash
git add README.md && git commit -m "README: project overview and build steps" && git push
```
