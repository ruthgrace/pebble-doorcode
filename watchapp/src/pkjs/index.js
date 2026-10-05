var moddableProxy = require("@moddable/pebbleproxy");

// Set this to the public origin of your deployed service, no trailing slash.
var BASE_URL = "https://moxcode.ruthgracewong.com";

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
