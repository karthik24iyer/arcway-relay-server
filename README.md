# Arcway Relay Server

Lightweight Node.js relay that bridges the mobile/mac client with the backend agent over WebSocket.

## Requirements

- Node.js 18+

## Run

```bash
node src/index.js
```

Starts on port `3000` by default.

```bash
# Custom port
PORT=3001 node src/index.js
```

## Endpoints

| Path | Protocol | Description |
|------|----------|-------------|
| `/agent` | WebSocket | Backend agent connects here |
| `/client` | WebSocket | Client app connects here |
| `/devices` | HTTP | Device registration |
