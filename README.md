# Arcway Relay Server

Self-hostable WebSocket relay that bridges the Arcway mobile / desktop clients with the agent process on your Mac or Linux box. SQLite by default, auto-TLS, every feature unlocked.

## Quickstart

You need a public domain pointing at the host (any DNS A record works — DuckDNS is free).

```bash
git clone https://github.com/karthik24iyer/arcway-relay-server
cd arcway-relay-server
# edit .env — set DOMAIN
docker compose up -d
```

That's it. Caddy obtains a Let's Encrypt cert for `DOMAIN` on first boot, the relay starts behind it, and `https://your-domain/` is live.

### Run from source (no Docker)

```bash
npm install
npm run dev      # auto-restart on changes (Node 20+)
# or: npm start
```

Reads `.env` automatically. SQLite lives at `./data/relay.db`. Put TLS in front yourself (or use `http://localhost:3000` for local testing — the apps will warn but allow it).

## Pairing your devices

In the Arcway Android / Mac / iOS app, flip **Self Host** ON. Enter your relay URL. Leave the pair code blank for the **first** device — the app will show you the code after pairing. For subsequent devices, enter that same code.

```
First device (Mac):                 Second device (phone):
┌──────────────────────────┐        ┌──────────────────────────┐
│ Self Host?         [──●] │        │ Self Host?         [──●] │
│                          │        │                          │
│ Relay URL                │        │ Relay URL                │
│ [https://your-relay]     │        │ [https://your-relay]     │
│                          │        │                          │
│ Pair code                │        │ Pair code                │
│ [                      ] │        │ [XK3F9P                ] │
│   leave blank            │        │                          │
│                          │        │                          │
│ [ Connect ]              │        │ [ Connect ]              │
└──────────────────────────┘        └──────────────────────────┘
            │                                    │
            ↓                                    ↓
   Mac shows: "Pair code:                Phone joins,
              XK3F9P"                    sees Mac in device list
   ↳ type that on phone
```

If you need the pair code later (e.g. to add a third device):
```bash
docker compose exec relay cat /data/.relay-code
```

## Without a public domain

Use one of these in front of `docker run` (skip `docker compose`):

| Tool | Why |
|---|---|
| **Cloudflare Tunnel** | Free, no port forwarding |
| **Tailscale Funnel** | Free for personal, no public IP needed |
| **ngrok** | Quickest for testing |

```bash
docker run -d --name arcway-relay -v arcway-data:/data -p 3000:3000 \
  ghcr.io/karthik24iyer/arcway-relay:latest
```

## Pointing apps at your relay

- **Android**: Settings → Self Host ON → URL + code
- **Mac**: Login screen → Self Host ON → URL + code
- **iOS**: Login screen → Self Host ON → URL + code

## Re-pairing / resetting

If you lose access to all paired devices:
```bash
docker compose exec relay node src/reset.js --confirm
```
This purges all users/devices/sessions but keeps the same pair code. Add `--regenerate-code` to also rotate it.

## Backup

```bash
docker run --rm -v arcway-relay-server_arcway-data:/data -v "$(pwd):/backup" alpine \
  cp /data/relay.db /backup/relay.db.bak
```

## Endpoints

| Path | Protocol | Purpose |
|---|---|---|
| `/agent` | WS | Agent (Mac/Linux) |
| `/client` | WS | Client (Android/iOS) |
| `/auth/pair-initiate` | POST | First device (empty code) |
| `/auth/pair` | POST | Subsequent devices (with code) |
| `/api/pair/code` | GET (auth) | Re-show code on a paired device |
| `/auth/refresh`, `/auth/logout` | POST | Session rotation |
| `/api/devices`, `/api/devices/register`, `/api/devices/:id` | HTTP | Device CRUD |
| `/api/account` | DELETE | Full erase |
| `/api/audit` | GET | Last 100 audit events |
| `/health` | GET | Liveness probe |

## License

MIT — see [LICENSE](LICENSE).
