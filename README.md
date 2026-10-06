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
pebble build
pebble install --phone YOUR_PHONE_IP
```

`pebble install --phone` requires Developer Connection to be enabled in the
Pebble phone app, with the phone and computer on the same network.

## Using it

In the Pebble phone app, open the Door Code app's settings (the gear) to
"Sign in with Discord" or "Sign out of this watch". Then on the watch, go to
Settings > Quick Launch and assign Door Code to a long-press.

## Tests

```bash
(cd service && npm test)
(cd watchapp && node --test test/*.test.js)
```

## Security notes

The token (a per-user random secret) is stored on the watch and also in the Pebble phone app's storage for the watchapp. The watch also stores the last code. The service
stores only a hash of the token and the ID of the user's channel. Nothing
stores the code server-side. All traffic is HTTPS.
