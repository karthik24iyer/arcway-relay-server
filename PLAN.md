# arcway-relay-server — Scale-to-1000+ Plan

Full product flow at every milestone: Android login → device list → tap device → terminal → keystrokes work.

---

## Milestone 0 — Remove Old Username/Password Auth — N/A
Never had username/password auth. `src/auth.js` is for Google/Apple Sign-In JWT only.

---

## Milestone 1 — Non-Breaking Hardening
No schema changes. No client changes. Existing Android app works unchanged throughout.

### Rate limiting (`devices.js`)
Install `express-rate-limit` (npm install). Apply in `devices.js`:
- `/auth/google`, `/auth/apple`: 10 req/IP/15min
- `/api/*`: 100 req/IP/min
- Pre-wire `/auth/refresh` at 20 req/IP/15min — no handler yet, endpoint returns 404 until M3

### CORS lockdown (`index.js`)
`index.js` lines 9-15 set CORS via three manual `res.header()` calls — the `cors` npm package
is not installed. Install it (`npm install cors`), then replace the manual headers with:
```javascript
const cors = require('cors');
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [];
app.use(cors({ origin: allowedOrigins }));
```
`ALLOWED_ORIGINS` env var: comma-separated list. Dev default: `http://localhost:3000`.

### WebSocket hardening (`index.js`, `relay.js`)
`maxPayload` change is in `index.js` only — `relay.js` has no `WebSocket.Server`:
```javascript
// index.js line 22
const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });
```
Auth handshake timeout in both `handleAgentConnection` and `handleClientConnection` in
`relay.js`. Both use `ws.once('message', ...)` with no timeout — a client that never sends
holds the socket forever:
```javascript
const authTimeout = setTimeout(() => ws.close(1008, 'Auth timeout'), 10_000);
ws.once('message', (data) => {
  clearTimeout(authTimeout);
  // ... existing handler body
});
```

### Provider column — additive migration (`db.js`, `devices.js`)
SQLite migration:
```sql
ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'google';
-- Cannot rename column in older SQLite; add provider_sub as new column and backfill:
ALTER TABLE users ADD COLUMN provider_sub TEXT;
UPDATE users SET provider_sub = google_sub;
```
Update `upsertUser` signature: `function upsertUser(providerSub, email, provider)`.
Update **both** call sites in `devices.js`:
- Line 30 (Google): `upsertUser(sub, email, 'google')`
- Line 44 (Apple): `upsertUser(sub, email, 'apple')`
Update all SQL inside `upsertUser` to use `provider_sub` and `provider` columns.

### Device name validation (`relay.js`, `devices.js`)
- In `relay.js` agent registration (`msg.name`): truncate to 50 chars, strip non-printable chars
- In `devices.js` `/api/devices/register` (`req.body.name`): same validation

### `updateLastSeen` on heartbeat (`relay.js`)
Currently called at connect time only. In `startHeartbeat`, the `ws.on('pong')` handler
(line 8) must be updated — `deviceId` is in scope since `startHeartbeat(ws, deviceId)`:
```javascript
function startHeartbeat(ws, deviceId) {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
    updateLastSeen(deviceId); // add this line
  });
  // ... rest unchanged
}
```

### Verify
```
1. Login → device list → connect → terminal → keystrokes work
2. 11 rapid POSTs to /auth/google from same IP → 11th returns 429
3. Open raw WS to /client, send nothing for 11s → connection closed with 1008
4. SELECT provider FROM users — existing rows show 'google'
5. Register Mac with a 60-char name → name stored as 50 chars max
```

---

## Milestone 2 — PostgreSQL Migration
Relay-only. No client changes. Product behaviour identical to M1.

### Replace `better-sqlite3` with `pg` (`db.js`, `index.js`, `devices.js`, `relay.js`)
- Install `pg`, remove `better-sqlite3`
- `POSTGRES_URL` env var — throw at startup if missing
- `pg.Pool` with pool size 10, set `connectionTimeoutMillis: 5000`
- All DB functions in `db.js` become `async` — every caller must `await` them
- **Critical**: `relay.js` WebSocket message callbacks are not `async`. Every callback that
  calls a DB function must be made async. Specific locations to update in `relay.js`:
  - `handleAgentConnection`: `ws.once('message', async (data) => {` (lines 22, 36, 55, 61, 64)
  - `handleClientConnection`: `ws.once('message', async (data) => {` (lines 80, 96, 103)
  - Missing `await` on any DB call returns a Promise instead of a value — silent bug
- All callers in `devices.js` route handlers are already in `async` functions — add `await`

Await pool connectivity in `index.js` before accepting connections:
```javascript
const pool = require('./db').pool;
pool.connect().then(client => {
  client.release();
  server.listen(PORT, () => console.log(`Listening on ${PORT}`));
}).catch(err => { console.error('DB connection failed', err); process.exit(1); });
```

### PostgreSQL schema
```sql
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  provider_sub TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'google',
  email        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_sub)
);

CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  name              TEXT NOT NULL,
  device_credential TEXT UNIQUE NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ,
  UNIQUE(user_id, name)   -- new: DB-level dedup, absent in current SQLite schema
);

```

### Data migration script
One-off Node.js script. Must run in this order to satisfy FK constraints:
1. Insert all `users` rows (SQLite `google_sub` → `provider_sub`, set `provider = 'google'`)
2. Insert all `devices` rows (FKs reference users)

Run as a single PostgreSQL transaction — rollback if any insert fails. Keep SQLite
read-only during migration (stop the relay server). Test the script against a copy of
production data before running it live. After migration: verify row counts match.

### Verify
```
1. Full login → device list → connect → terminal works
2. Register new Mac → appears in device list
3. Restart relay → Mac reconnects → client reconnects
4. Row counts: SELECT COUNT(*) FROM users/devices match pre-migration SQLite
5. 50 concurrent GET /api/devices → all succeed (confirms no event-loop blocking from sync DB)
```

---

## Milestone 3 — Short JWT + Refresh Tokens
Relay + Android. Deploy in two sub-steps — relay first, Android second.

### Sub-step 3a — Relay: add refresh tokens, keep JWT at 30d (relay deploy only)

**New `sessions` table** (`db.js`):
```sql
-- gen_random_uuid() requires PostgreSQL 13+ or pgcrypto extension on PG 12
-- If PG < 13: CREATE EXTENSION IF NOT EXISTS "pgcrypto"; and use gen_random_uuid() from that
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  token_hash  TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions(user_id);
```

**Remove `email` from JWT payload** (`auth.js`, `devices.js`, `relay.js`):
Current `auth.js` line 22: `jwt.sign({ userId, email }, ...)` — `email` is PII readable
in base64 in every auth frame.
- Change to: `jwt.sign({ userId }, ...)`
- `signSessionToken(userId, email)` → `signSessionToken(userId)` — remove `email` param
- Update both call sites in `devices.js` (lines 31 and 44)
- `authMiddleware` in `devices.js` (line 13) destructures `{ userId, email }` from token —
  change to `{ userId }` only; remove `req.email` assignment (not used downstream)
- `relay.js` (line 77) destructures `{ userId, email }` from token — change to `{ userId }`
- `relay.js` (line 114) uses `email` to send `user_email` to agent — fetch from DB instead.
  Add new DB function `getUserById(userId)` to `db.js`:
  ```javascript
  async function getUserById(id) {
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
  ```
  In `handleClientConnection` (relay.js line ~133), `await` this before sending `client_connected`
- JWT stays at `30d` for now. Existing Android clients unaffected.

**Update `/auth/google` and `/auth/apple`** (`devices.js`):
- Generate refresh token: `crypto.randomBytes(32).toString('hex')`
- Hash: `crypto.createHash('sha256').update(rawToken).digest('hex')`
- Insert into `sessions` (use `req.ip` for `ip_address`)
- Return `{ session_token, refresh_token }` — existing Android ignores the new field

**New `/auth/refresh` endpoint** (`devices.js`):
```
POST /auth/refresh
Body: { refresh_token }
→ hash token
→ UPDATE sessions SET revoked = TRUE WHERE token_hash = $1 AND revoked = FALSE RETURNING user_id, expires_at
  (atomic: only succeeds if not already revoked; if 0 rows returned → token already used or revoked → 401)
→ check expires_at
→ issue new access JWT, new refresh token, insert new session row
→ return { session_token, refresh_token }
```
The `UPDATE ... WHERE revoked = FALSE RETURNING` pattern is the atomic rotation — eliminates
the race condition where two concurrent requests both read the session as valid before either
marks it revoked.

**New `/auth/logout` endpoint** (`devices.js`):
```
POST /auth/logout
Body: { refresh_token }
→ hash token, UPDATE sessions SET revoked = TRUE WHERE token_hash = $1
→ always return 200 (don't reveal whether token existed — prevents oracle)
```

Deploy 3a. Existing Android app still works — 30d JWT unchanged, `refresh_token` field ignored.

### Sub-step 3b — Android handles refresh tokens, then relay shortens JWT to 15min
_(See arcway-android PLAN.md for Android implementation.)_

After Android update is live:
- Change `jwt.sign({ userId }, ..., { expiresIn: '15m' })` in `auth.js`
- Deploy relay

### Verify (after 3b)
```
1. Login → device list → connect → terminal works
2. Set JWT expiry to 1min for test → wait → API call refreshes transparently
3. Logout → POST /auth/refresh with old refresh_token → 401
4. base64-decode JWT payload → no 'email' field
5. Concurrent refresh: send same refresh_token twice simultaneously →
   only one succeeds (UPDATE WHERE revoked=FALSE is atomic), other gets 401
6. Relay returns user_email correctly in client_connected message after removing email from JWT
```

---

## Milestone 4 — Device Credential Hashing ✓ DONE (2026-03-25)
Relay-only.

- Added `credential_hashed BOOLEAN DEFAULT FALSE` column to `devices` (additive migration via `ALTER TABLE IF NOT EXISTS`)
- `upsertDeviceByName`: always issues a fresh argon2-hashed credential on every registration call (existing device → UPDATE, new device → INSERT). Raw credential returned once, hash stored.
- `getDeviceByCredential`: scans `credential_hashed = TRUE` rows and verifies with `argon2.verify`. No plaintext fallback (single-user, low device count).
- `/auth/google` + `/auth/apple` now include `email` in response body — `AuthService` on Mac reads it from there instead of trying to decode from JWT (email was removed from JWT in M3a).
- arcway-mac: on `STATUS:invalid_credential` from relay, clears Keychain and shows login screen. Re-registration via "Sign in with Google" issues a new hashed credential automatically.

---

## Milestone 5 — Multi-Client Guard + Listener Leak
Relay-only.

### Already-bridged check (`relay.js`)
Add alongside `connectedAgents` (line 4):
```javascript
const bridgedAgents = new Map(); // deviceId -> clientWs
```
In `handleClientConnection`, before attaching listeners to `agentWs`:
```javascript
if (bridgedAgents.has(msg.device_id)) {
  ws.send(JSON.stringify({ type: 'error', message: 'Device already in use' }));
  ws.close();
  return;
}
bridgedAgents.set(msg.device_id, ws);
```
On client disconnect (line 108 in current code):
```javascript
ws.on('close', () => {
  bridgedAgents.delete(msg.device_id);
  agentWs.removeListener('message', onAgentMessage);
  agentWs.removeListener('close', onAgentClose);
});
```

### Listener leak canary (`relay.js`)
Current listener count per bridged agent: `pong`(1) + `close` from heartbeat(1) +
`close` from registration(1) + `onAgentMessage`(1) + `onAgentClose`(1) = **5 minimum**.
Setting `setMaxListeners(3)` would throw false alarms on every bridge. Use:
```javascript
agentWs.setMaxListeners(6); // 5 real + 1 headroom as canary
```

### Verify
```
1. Connect Android device A to Mac → terminal works
2. Connect Android device B to same Mac → gets "Device already in use" error
3. Device A still works after device B's rejected attempt
4. Disconnect A → B can now connect
5. Connect/disconnect 20 times → no MaxListenersExceededWarning in logs
```

---

## Milestone 6 — Device Limits + Audit Log + Account Deletion ✓ DONE (2026-03-25)
Relay-only. All verifiable via API — no Android UI changes needed.

### Per-user device limit (`db.js`, `devices.js`, `relay.js`)
- `MAX_DEVICES_PER_USER = 10` (env var override)
- Limit check must be placed **after** the existing-device lookup in `upsertDeviceByName`,
  not before — existing devices must reconnect freely even if the user is at the limit:
  ```javascript
  async function upsertDeviceByName(userId, name) {
    const existing = await getDeviceByName(userId, name);
    if (existing) return existing;                         // returning existing: no count check
    const count = await countDevices(userId);
    if (count >= MAX_DEVICES_PER_USER) throw new Error('Device limit reached');
    return createDevice(userId, name);
  }
  ```
- New `DELETE /api/devices/:id` (authenticated, verify `device.user_id === req.userId`)
- Same limit check already enforced — `upsertDeviceByName` in `devices.js` is the only registration path (via arcway-mac `POST /api/devices/register`)

### Audit log (`db.js`, `relay.js`, `devices.js`)
```sql
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    INTEGER REFERENCES users(id),
  device_id  TEXT,
  event      TEXT NOT NULL,  -- client_connected | client_disconnected | agent_connected
                             --   agent_disconnected | agent_registered | auth_failed
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_id ON audit_log(user_id);
CREATE INDEX audit_log_created_at ON audit_log(created_at);
```
- Log in `relay.js` on all connect/disconnect events and `agent_registered`
- Log `auth_failed` in `devices.js` on 401 responses
- `GET /api/audit` (authenticated) — last 100 events for `req.userId`
- Daily retention: run in batches to avoid lock contention:
  ```sql
  DELETE FROM audit_log WHERE id IN (
    SELECT id FROM audit_log WHERE created_at < now() - interval '90 days' LIMIT 1000
  )
  ```

### Account deletion (`db.js`, `devices.js`)
`DELETE /api/account` (authenticated) — single transaction. FK order matters
(`sessions`, `devices`, `audit_log` reference `users` — delete children before parent):
```sql
BEGIN;
UPDATE sessions SET revoked = TRUE WHERE user_id = $1;
DELETE FROM devices WHERE user_id = $1;
DELETE FROM audit_log WHERE user_id = $1;
DELETE FROM users WHERE id = $1;
COMMIT;
```

### Verify
```
1. Register 10 devices → 11th attempt returns error; re-registering an existing device by
   the same name succeeds (no count check for existing)
2. DELETE /api/devices/:id → device removed from list
3. Connect to Mac → GET /api/audit → client_connected event visible with IP + timestamp
4. DELETE /api/account → re-login → no user record → starts fresh
5. Attempt DELETE /api/devices/:id with another user's device_id → 403
```

---

## Milestone 7 — Redis + Horizontal Scaling
Relay-only. Zero client changes. Two sub-steps.

### Sub-step 7a — Single node + Redis (`src/redis.js`, `relay.js`, `devices.js`, `index.js`)

New `src/redis.js`:
```javascript
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const pub = new Redis(process.env.REDIS_URL);
const sub = new Redis(process.env.REDIS_URL);
const NODE_ID = process.env.NODE_ID || uuidv4();

// Required: unhandled error events crash Node.js process
pub.on('error', (err) => console.error('Redis pub error:', err));
sub.on('error', (err) => console.error('Redis sub error:', err));

module.exports = { pub, sub, NODE_ID };
```

Replace `connectedAgents` Map in `relay.js`:
- On agent connect: `await pub.set('relay:agent:' + deviceId, NODE_ID, 'EX', 30)`
- Refresh TTL on pong: `await pub.expire('relay:agent:' + deviceId, 30)`
- On agent disconnect: `await pub.del('relay:agent:' + deviceId)`
- Keep `localAgents: Map` for agents on this node

`devices.js` online check — currently `connectedAgents.has(d.id)` inside a `.map()`:
```javascript
// WRONG: await inside .map() returns array of Promises
devices.map(async (d) => ({ ...d, online: await pub.get('relay:agent:' + d.id) }))

// CORRECT: use Promise.all
const devices = await Promise.all(
  rawDevices.map(async (d) => ({
    ...d,
    online: (await pub.get('relay:agent:' + d.id)) !== null,
  }))
);
```

### Sub-step 7b — Two nodes (cross-node bridging)
Client bridging — same node: `GET relay:agent:{deviceId}` == `NODE_ID` → bridge directly.

Client bridging — different node:
- Subscribe: `sub.subscribe('relay:pipe:client:' + deviceId)`
- Forward client→agent: `pub.publish('relay:pipe:agent:' + deviceId, frame)`
- Owning node (has local agent): `sub.subscribe('relay:pipe:agent:' + deviceId)`;
  on message: write to agent WS; on agent→client: `pub.publish('relay:pipe:client:' + deviceId, frame)`
- On client disconnect: `sub.unsubscribe(...)`, publish tombstone to agent channel

Dead-node handling: if `GET relay:agent:{deviceId}` returns a node ID that no longer
responds to pub/sub (relay crashed), the Redis key expires in ≤30s (TTL). The client WS
will hang for up to 30s with no data before the key expires. After expiry, the client
gets "Device offline" on reconnect. This is acceptable — document it in ops runbook.

### Verify
```
7a (single node):
1. Full flow works identically to M6
2. Kill and restart relay → Mac reconnects → KEYS relay:agent:* shows key back
3. PTTL relay:agent:{id} resets after each heartbeat (check via redis-cli)

7b (two nodes):
1. nginx round-robin between node-1 (port 3000) and node-2 (port 3001)
2. Mac connects to node-1, Android to node-2 → terminal works
3. Kill node owning the agent → Mac reconnects to surviving node → Android reconnects → works
4. Logs show requests split across both nodes
```

---

## Execution Order & Dependencies

| Milestone | Depends on | Effort | Blocks launch? | Status |
|-----------|------------|--------|----------------|--------|
| 0 — Remove old auth | — | N/A | — | N/A (never existed) |
| 1 — Non-breaking hardening | — | 2–3 days | No | Done (2026-03-22) |
| 2 — PostgreSQL | M1 | 3–4 days | No (SQLite handles hundreds of users) | Done (2026-03-22) |
| 3a — Relay: refresh tokens | M2 | 2–3 days | Yes | Done (2026-03-24) |
| 3b — Android + shorten JWT | M3a + Android shipped | 3–4 days | Yes | Done (2026-03-25) |
| 4 — Credential hashing | M2 | 2–3 days | No | Done (2026-03-25) |
| 5 — Multi-client guard | M1 | 1 day | Yes (session hijack vector) | Done (2026-03-24) |
| 6 — Device limits + audit | M2 | 2–3 days | No | Done (2026-03-25) |
| 7a — Redis single node | M2 | 3–4 days | No | Pending |
| 7b — Redis two nodes | M7a | 1–2 days | No | Pending |

**Critical path to launch**: M1 → M5 → M2 → M3a → M3b → M4

M6, M7 can ship post-launch. M7 only needed when single-node capacity is actually a problem.

## Environment Variables

```
ALLOWED_ORIGINS=https://yourapp.com,https://claude-relay-server.duckdns.org
POSTGRES_URL=postgresql://user:pass@host:5432/arcway
JWT_SECRET=<32+ random bytes, required — throws at startup if missing>
GOOGLE_CLIENT_ID=<required for /auth/google>
MAC_CLIENT_ID=<optional, additional OAuth audience for Google>
APPLE_CLIENT_ID=com.yourapp.bundle   (optional, defaults to com.clauderemote.claudeRemoteAndroid)
LEGACY_CRED_DEADLINE=2025-06-01      (M4)
MAX_DEVICES_PER_USER=10              (M6, optional override)
REDIS_URL=redis://host:6379          (M7)
NODE_ID=relay-1                      (M7, unique per instance)
```
