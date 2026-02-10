# Simple Architecture

## How It Works

### Server (port 2567)
```
Express HTTP server with Colyseus attached
├── /api/animations -> REST API
├── /api/player-config -> REST API  
├── /matchmake/* -> Colyseus matchmaking
└── /{roomId}/{sessionId} -> Colyseus WebSocket rooms
```

### Nginx (port 80)
```
Try files first, proxy if not found
├── /assets/* -> serve from /usr/share/nginx/html
├── /animations/* -> serve from /app/animations
├── /config/* -> serve from /app/config
├── /index.html -> serve from /usr/share/nginx/html
└── everything else -> proxy to localhost:2567
```

### Client Connection
```javascript
// Production: wss://yourdomain.com
// Local dev: ws://127.0.0.1:2567

const client = new Client(wsUrl);
await client.joinOrCreate('riot_room');
// Colyseus handles: matchmaking -> room connection
```

## Request Flow

**Static file (e.g., /index.html)**
```
Browser -> Nginx -> serves from disk
```

**WebSocket connection**
```
Browser -> Nginx (try_files fails) -> @proxy -> localhost:2567 -> Colyseus
```

**API request (e.g., /api/animations)**
```
Browser -> Nginx (try_files fails) -> @proxy -> localhost:2567 -> Express
```

## Why This Works

1. **No path matching needed** - nginx tries static first, proxies everything else
2. **All Colyseus paths work** - /matchmake/*, /{random}/{random}, /api/*
3. **WebSocket upgrade works** - proxy preserves Upgrade headers
4. **Same as local dev** - client connects to same domain, nginx handles routing

## Files

- `Dockerfile` - builds client + server, runs nginx + node
- `docker/nginx.conf` - simple try_files + proxy config
- `docker/start.sh` - starts node in background, nginx in foreground
- `client/src/game/GameApp.ts` - client connects to same domain
- `server/src/index.ts` - Express + Colyseus on port 2567

## No Configuration Needed

Client auto-detects:
- `https://domain.com` -> connects to `wss://domain.com`
- `http://localhost` -> connects to `ws://127.0.0.1:2567`

That's it. No environment variables, no runtime config, no magic variables.
