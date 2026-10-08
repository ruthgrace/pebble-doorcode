import Message from "pebble/message";
import { createDisplay } from "./display";
import { interpret } from "./interpret";
import { statusLine, bigText } from "./status";
import { BASE_URL, FETCH_TIMEOUT_MS } from "./config";

const display = createDisplay();

let token = localStorage.getItem("token");
let cachedCode = localStorage.getItem("code");
let fetchedAt = localStorage.getItem("fetchedAt");
let lastError = null;

function render(view) {
  let status = statusLine(view, fetchedAt, Date.now());
  // Diagnostic detail when there is nothing cached to show: what failed and
  // whether the watch currently sees the phone's JS side.
  if (view.kind === "stale" && !cachedCode && lastError) {
    status = `${lastError} (phone ${watch.connected.pebblekit ? "linked" : "not linked"})`;
  }
  display.draw(bigText(view, cachedCode), status);
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

async function fetchCode(t) {
  try {
    return await withTimeout(
      (async () => {
        const response = await fetch(`${BASE_URL}/code`, { headers: { Authorization: `Bearer ${t}` } });
        let body = null;
        try { body = await response.json(); } catch {}
        return { status: response.status, body };
      })(),
      FETCH_TIMEOUT_MS,
    );
  } catch (e) {
    console.log(`fetch failed: ${e}`);
    lastError = String(e && e.message ? e.message : e).slice(0, 40);
    return { error: true };
  }
}

let refreshing = false;
let refreshPending = false;
async function refresh() {
  if (!token) return render({ kind: "notoken" });
  if (refreshing) {
    refreshPending = true;
    return;
  }
  refreshing = true;
  try {
    const t = token;
    render({ kind: "loading" });
    lastError = null;
  const result = await fetchCode(t);
  if (!result.error && result.status !== 200) lastError = `HTTP ${result.status}`;
  const view = interpret(result);
    // The token changed (new TOKEN or SIGNOUT) while fetching: discard this result.
    if (token !== t) {
      if (token) refreshPending = true;
      return;
    }
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
  } finally {
    refreshing = false;
    if (refreshPending) {
      refreshPending = false;
      if (token) refresh();
    }
  }
}

async function signOut() {
  const t = token;
  token = null;
  cachedCode = null;
  fetchedAt = null;
  localStorage.removeItem("token");
  localStorage.removeItem("code");
  localStorage.removeItem("fetchedAt");
  render({ kind: "notoken" });
  if (t) {
    try {
      await withTimeout(
        fetch(`${BASE_URL}/auth/revoke`, { method: "POST", headers: { Authorization: `Bearer ${t}` } }),
        FETCH_TIMEOUT_MS,
      );
    } catch (e) {
      console.log(`revoke failed: ${e}`);
    }
  }
}

new Message({
  keys: ["TOKEN", "SIGNOUT"],
  onReadable() {
    const msg = this.read();
    if (msg.has("SIGNOUT")) return void signOut();
    const t = msg.get("TOKEN");
    if (typeof t === "string" && t.length) {
      if (t !== token) {
        token = t;
        localStorage.setItem("token", token);
        refresh();
      }
    }
  },
});

// Draw immediately so the screen is never blank, then fetch right away: the
// proxy queues the request until the phone is ready, and the 8 s timeout turns
// a missing phone into a visible status instead of "loading..." forever.
render(token ? { kind: "loading" } : { kind: "notoken" });

if (token) {
  refresh();
  // If the phone link comes up later (or drops and returns), fetch again.
  watch.addEventListener("connected", () => { if (watch.connected.pebblekit) refresh(); });
}

export {};
