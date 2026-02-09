# Trashy Game

Session-based multiplayer urban riot sandbox prototype. The client is a Three.js + Vite app, the server is a Colyseus authoritative simulation, and shared protocol types live in `shared/`.

## Quick Start

1) Install deps (pnpm recommended):

```bash
pnpm install
```

2) Run the server:

```bash
pnpm dev:server
```

3) Run the client:

```bash
pnpm dev
```

The client connects to `ws://localhost:2567` by default.

## Workspace Layout
- `client/` Three.js + Vite frontend
- `server/` Colyseus authoritative backend
- `shared/` protocol/types shared between client/server
- `docs/PLAN.md` implementation plan

## Docker (Local Test / Deployment)

### Single container (client + server)
Build and run everything in one container:

```bash
docker compose up --build
```

Then open:
- Client: `http://localhost:5175/`
- Server: `ws://localhost:2567`

### Separate images (optional)
If you want to build images separately:

```bash
docker build --target server -t trashy-server .
docker build --target client -t trashy-client .
```
