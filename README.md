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
# BASE_URL in src/embeddedjs/config.js and src/pkjs/index.js points at the author's service; change it if you self-host
pebble package install @moddable/pebbleproxy
pebble build
pebble install --phone YOUR_PHONE_IP
```

Then on the watch: Settings > Quick Launch > pick a button > Door Code.

## Tests

```bash
(cd service && npm test)
(cd watchapp && node --test test/*.test.js)
```

## Security notes

The watch stores a per-user random token and the last code. The service
stores only a hash of the token and the ID of the user's channel. Nothing
stores the code server-side. All traffic is HTTPS.
