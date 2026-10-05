# Door Code on Pebble Time 2: Design

Date: 2026-10-01

## Goal

Long-press a button on a Pebble Time 2 and see the current door code. The
code changes every week or two and is published as the name of a private
Discord channel that is visible only to the member it belongs to. The
channel name has the form `🚪: 1234` (door emoji, colon, the code).

The system is a small hosted service plus a Pebble watchapp. Members of one
specific Discord server sign in with Discord once, after which the watch can
fetch their code at any time. The project will be open source.

## Non-goals

- Supporting more than one Discord server. The service is configured with a
  single server ID.
- Scraping the website that also shows the code.
- Reading Discord messages. Only channel names are read.
- Any admin UI. Configuration is by environment variables.

## Components

### 1. Service (`service/`)

Plain Node using the built-in `node:http` module (no web framework), one process,
SQLite file for state. Listens on localhost; nginx on the Droplet provides
HTTPS and proxies to it.

Environment variables:

| Name | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | OAuth application client ID |
| `DISCORD_CLIENT_SECRET` | OAuth application client secret |
| `DISCORD_BOT_TOKEN` | Bot token used to list and read channels |
| `DISCORD_GUILD_ID` | The one server this instance serves |
| `BASE_URL` | Public HTTPS origin, used to build the OAuth redirect |
| `DB_PATH` | SQLite file path |
| `PORT` | Localhost port nginx proxies to |

Endpoints:

- `GET /auth/start` — sets a random `state` cookie and redirects to Discord
  OAuth with scope `identify` only.
- `GET /auth/callback` — validates `state`, exchanges the code for an access
  token, reads the user's Discord ID. Using the bot token, lists the guild's
  channels and selects the channel that (a) has a name starting with `🚪`
  and (b) has a permission overwrite of type member for this user ID that
  allows View Channel. Exactly one match: generate a 32-byte random token,
  store its SHA-256 hash with user ID, channel ID, and created time; return
  a page that closes itself via the Pebble config-page mechanism
  (`pebblejs://close#<urlencoded JSON>`) carrying the raw token. Zero
  matches: show "No door code channel found for your account." More than
  one match: show "Multiple channels found, contact the admin." Never guess.
  Before issuing a token the service fetches the matched channel with the bot
  token; a 403/404 shows "The bot can't see your door channel, contact the
  admin."
- `GET /code` — requires `Authorization: Bearer <token>`. Hashes the token,
  looks it up, fetches `GET /channels/{id}` from Discord with the bot token.
  The service also re-checks that the channel still grants View Channel to the
  stored user ID via a member overwrite; if not, the row is deleted and 403
  reauth is returned, because Discord keeps overwrites when a member leaves.
  Extracts the trailing digit run from the channel name, returns
  `{ "code": "1234", "channel": "🚪: 1234" }`. Responses:
  - 401 unknown token.
  - 403 channel missing or bot lacks access (Discord 403/404). The token
    row is deleted. Body: `{ "error": "reauth" }`.
  - 422 channel found but no digits in the name. Body:
    `{ "error": "unparseable" }`.
  - 502 Discord unreachable or 5xx.
- `POST /auth/revoke` — requires the bearer token; deletes the row.

The service never stores the code. The only state is the token-to-channel
map.

Data model (SQLite, one table `tokens`): `token_hash TEXT PRIMARY KEY`,
`user_id TEXT`, `channel_id TEXT`, `created_at INTEGER`.

Pure functions, kept in their own modules for testing:

- `extractCode(channelName) -> string | null`
- `findUserChannel(channels, userId) -> { channel } | { error: "none" | "multiple" }`
- `hashToken(token) -> hex string`

### 2. Watchapp (`watchapp/`)

Alloy (Moddable) watchapp, platform `pebble/emery`, declared as a watchapp
so it appears in Settings > Quick Launch. The user assigns the long-press
button on the watch; the app does nothing special for that.

Phone side (`src/pkjs/index.js`):

- Registers `@moddable/pebbleproxy` so watch-side `fetch` works.
- On `showConfiguration`, opens `BASE_URL/auth/start` in the phone browser.
- On `webviewclosed`, parses the returned JSON, and sends the token to the
  watch over app message. A `signout: true` payload tells the watch to clear
  its token and tells pkjs to call `/auth/revoke`.

Watch side (`src/main.js`):

- On launch, read `token`, `code`, and `fetchedAt` from `localStorage`.
- If `code` exists, draw it immediately.
- If no token: show "Set up in phone app settings" and stop.
- Wait for `watch.connected.pebblekit`, then `fetch(BASE_URL + "/code")`
  with the bearer token. On 200: store code and timestamp, redraw with
  "just now". On 403 reauth: clear token, show "Sign in again in settings".
  On 422: show "Code unreadable" above the cached value. On any other
  failure or timeout (8 s): keep cached value, show "cached, from <weekday>".
- Back button exits. No other button handling.

Display: one screen, the code centered in the largest digit-only font that
fits the 200x228 screen, a one-line status underneath in a small font.
Fonts follow the pattern used in the lucky cat watchface (BMF resources
with a digits-only charset for the big font).

### 3. Security

- Tokens: 32 random bytes, base64url on the wire, stored only as SHA-256.
- OAuth `state` parameter validated on callback.
- Scope is `identify` only. The service learns nothing about the user except
  their Discord ID.
- Bot needs only View Channels, plus visibility into the private door
  channels (granted by the server admin via role or per-channel overwrite).
  No message intents, no write permissions, no Administrator.
- Secrets live in an environment file on the Droplet, never in the repo.
- All traffic over HTTPS via nginx. Service binds to 127.0.0.1.

### 4. Failure modes

| Situation | Service | Watch |
| --- | --- | --- |
| Discord down | 502 | cached code, "cached" label |
| Channel renamed without digits | 422 | "Code unreadable" + cached |
| User left server / bot lost access | 403, row deleted (overwrite re-check or Discord 403/404) | "Sign in again in settings" |
| Multiple matching channels at sign-in | error page, no token | n/a |
| Phone not connected | n/a | cached code, "cached" label |
| No token yet | n/a | "Set up in phone app settings" |

### 5. Testing

Service: Node's built-in test runner. Unit tests for `extractCode`,
`findUserChannel`, `hashToken`. Endpoint tests with the Discord HTTP calls
stubbed, covering sign-in happy path, none/multiple channel matches, bad
state, and each `/code` response branch.

Watchapp: emulator (emery) for layout, no-token state, and cached state;
real watch and phone for the fetch path and config page round trip, since
the proxy only exists with a real phone.

### 6. Deployment

- systemd unit running the service as an unprivileged user, env file at
  `/etc/doorcode.env`, SQLite under `/var/lib/doorcode/`.
- nginx `location /` block proxying to the service port on the chosen
  domain. Both files are shipped in `service/deploy/` and referenced in the
  README.
- Discord developer portal: one application with a bot. OAuth redirect URL
  set to `BASE_URL/auth/callback`. Admin invites the bot with View Channels
  and grants it visibility into the door channels.

### 7. Repo layout

```
doorcode/
  README.md
  docs/superpowers/specs/
  service/
    package.json
    src/server.js
    src/discord.js
    src/store.js
    src/match.js      (extractCode, findUserChannel)
    src/token.js      (hashToken, newToken)
    test/
    deploy/doorcode.service
    deploy/nginx.conf
  watchapp/
    manifest.json
    src/main.js
    src/pkjs/index.js
    assets/
```

### 8. Order of work

1. Service with tests, verified against the real Discord API with curl.
2. Deploy to the Droplet behind nginx; complete one real sign-in in a phone
   browser to confirm the OAuth and channel matching.
3. Watchapp: display and cached states on the emulator, then config page
   round trip and fetch on the real watch.
4. README.
