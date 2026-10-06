var moddableProxy = require("@moddable/pebbleproxy");

// Set this to the public origin of your deployed service, no trailing slash.
var BASE_URL = "https://moxcode.ruthgracewong.com";

function sendToken(token) {
  moddableProxy.sendAppMessage({ TOKEN: token },
    function () { console.log("token sent to watch"); },
    function (e) { console.log("token send failed: " + (e && e.error ? e.error : "unknown")); });
}

function sendSignout() {
  moddableProxy.sendAppMessage({ SIGNOUT: 1 },
    function () {
      localStorage.removeItem("pendingSignout");
      console.log("signout sent to watch");
    },
    function (e) { console.log("signout send failed: " + (e && e.error ? e.error : "unknown")); });
}

function revoke(token) {
  var xhr = new XMLHttpRequest();
  xhr.open("POST", BASE_URL + "/auth/revoke");
  xhr.setRequestHeader("Authorization", "Bearer " + token);
  xhr.onload = function () { console.log("revoke status " + xhr.status); };
  xhr.onerror = function () { console.log("revoke request failed"); };
  xhr.send();
}

Pebble.addEventListener("ready", function (e) {
  moddableProxy.readyReceived(e);
  var pending = localStorage.getItem("pendingSignout");
  if (pending) {
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
    console.log("bad config response (" + e.response.length + " chars)");
    return;
  }
  if (!data || typeof data !== "object") return;
  if (data.signout) {
    var oldSignout = localStorage.getItem("token");
    if (oldSignout) revoke(oldSignout);
    localStorage.removeItem("token");
    localStorage.setItem("pendingSignout", "1");
    sendSignout();
  } else if (typeof data.token === "string" && data.token.length) {
    var old = localStorage.getItem("token");
    if (old && old !== data.token) revoke(old);
    localStorage.removeItem("pendingSignout");
    localStorage.setItem("token", data.token);
    sendToken(data.token);
  }
});
