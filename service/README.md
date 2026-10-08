# Door code service

Reads a member's door code from the name of their private `🚪:` channel in
one Discord server and serves it to the Pebble watchapp.

## Requirements

- Node 22.13 or newer (uses the built-in `node:sqlite`).
- A domain pointed at your server with nginx and a TLS certificate.
- A Discord application with a bot, invited to the server.

## Discord setup

1. Go to https://discord.com/developers/applications and create an application.
2. Under **OAuth2**, add the redirect `https://moxcode.ruthgracewong.com/auth/callback`.
   Copy the Client ID and Client Secret.
3. Under **Bot**, create the bot and copy its token. No privileged intents are needed.
4. Build an invite URL with only the **View Channels** permission:
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=1024`
   Send it to a server admin to approve.
5. The bot does not need to be added to the private door channels or
   categories: the server-wide channel listing exposes their names and
   permissions to any bot in the server.
6. Copy the server ID (enable Developer Mode in Discord, right-click the server, Copy ID).

## Install on the server

The commands and files below use the author's values: domain
`moxcode.ruthgracewong.com`, webroot `/var/www/moxcode/static`, nginx conf name
`moxcode.conf`, and port `8787`. Replace the domain in
`deploy/doorcode.env.example`, `deploy/nginx-http.conf`, `deploy/nginx.conf` and
the commands below, for example with
`sed -i 's/moxcode.ruthgracewong.com/YOUR.DOMAIN/g' deploy/*.conf deploy/doorcode.env.example`.

Check and upgrade your Node version:

```bash
node --version            # must be >= 22.13
```

If it's below 22.13, upgrade:

```bash
sudo dnf module switch-to nodejs:24 -y
node --version            # verify now prints 22.13 or newer (24.x expected)
```

Then proceed with the installation:

```bash
sudo useradd --system --home /opt/doorcode --shell /usr/sbin/nologin doorcode
sudo mkdir -p /var/lib/doorcode
sudo git clone https://github.com/ruthgrace/pebble-doorcode /opt/doorcode
sudo chown -R doorcode:doorcode /opt/doorcode /var/lib/doorcode
sudo cp /opt/doorcode/service/deploy/doorcode.env.example /etc/doorcode.env
sudo chmod 600 /etc/doorcode.env
sudo nano /etc/doorcode.env   # fill in the values
sudo cp /opt/doorcode/service/deploy/doorcode.service /etc/systemd/system/
```

Obtain the TLS certificate first, then enable the service:

```bash
sudo mkdir -p /var/www/moxcode/static
sudo cp /opt/doorcode/service/deploy/nginx-http.conf /etc/nginx/conf.d/moxcode.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/moxcode/static -d moxcode.ruthgracewong.com --deploy-hook "systemctl reload nginx"
sudo cp /opt/doorcode/service/deploy/nginx.conf /etc/nginx/conf.d/moxcode.conf
sudo nginx -t && sudo systemctl reload nginx
```

On AlmaLinux with SELinux enforcing, nginx needs permission to reach the service:

```bash
sudo setsebool -P httpd_can_network_connect 1
getsebool httpd_can_network_connect           # verify it prints on
```

Now enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now doorcode
sudo journalctl -u doorcode -n 50 --no-pager
```

The last command should show recent logs; look for the line `doorcode service listening on 127.0.0.1:8787`.

## How sign-in works

Discord's login page does not work reliably inside the Pebble phone app's
embedded browser, so sign-in happens in a normal browser:

1. The user opens `https://YOUR_DOMAIN/auth/start` in their phone's browser
   (or any browser), taps **Sign in with Discord**, and authorizes.
2. The final page shows a six-character pairing code, valid for ten minutes.
3. In the Pebble phone app, the Door Code app's settings page asks for that
   code. Entering it hands the token to the watch.

Pairing codes are kept in memory; a service restart just means signing in
again. Twenty wrong codes within a minute pause pairing for the rest of that
minute.

## Logs

The service appends its output to `/var/lib/doorcode/doorcode.log` (set in the
systemd unit), so `sudo tail -50 /var/lib/doorcode/doorcode.log` shows what
happened even on hosts where journald is not capturing service output.

## Verify

Open `https://moxcode.ruthgracewong.com/auth/start` in a browser. Signing in should end on
a page that tries to open `pebblejs://close#...`. In a normal browser that link
does nothing, which is expected; it works inside the Pebble phone app.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /auth/start` | Settings landing page used by the watchapp: enter a pairing code, or sign in here |
| `POST /auth/pair` | `{ "code": "ABC123" }` exchanges a pairing code (10 min, single use) for `{ "token": ... }` |
| `GET /auth/discord` | Begins Discord OAuth |
| `GET /auth/callback` | OAuth return; issues a token |
| `GET /code` | `Authorization: Bearer <token>` returns `{ "code": "1234", "channel": "🚪: 1234" }` |
| `POST /auth/revoke` | Deletes the token |

Error responses from `/code`: 401 bad token, 404 `{"error":"nochannel"}`
(no door channel grants this user; token kept), 409 `{"error":"multiple"}`,
422 `{"error":"unparseable"}`, 502 `{"error":"discord"}`.

## Development

```bash
cd service
npm test
```

## Updating

```bash
cd /opt/doorcode && sudo -u doorcode git pull
sudo cp /opt/doorcode/service/deploy/doorcode.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart doorcode
```

Running git as the owning user avoids the dubious-ownership error.
