# Arcway Relay Server

Lightweight Node.js relay that bridges the mobile/mac client with the backend agent over WebSocket.

## Requirements

- Node.js 18+

## Setup

```bash
npm install
```

## Run

```bash
JWT_SECRET=your-secret node src/index.js
```

Starts on port `3000` by default.

```bash
# Custom port
JWT_SECRET=your-secret PORT=3001 node src/index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Secret key for signing session tokens |
| `PORT` | No | Server port (default: 3000) |

## Endpoints

| Path | Protocol | Description |
|------|----------|-------------|
| `/agent` | WebSocket | Backend agent connects here |
| `/client` | WebSocket | Client app connects here |
| `/devices` | HTTP | Device registration |
