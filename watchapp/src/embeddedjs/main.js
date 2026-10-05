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
