# Sleepy Engine - Project Notes

## Overview
Sleepy Engine is a session-based multiplayer urban riot sandbox prototype with an authoritative Colyseus server and a Three.js + Vite client. The server simulates players, combat, and crowds; the client handles rendering, input, and UI (including the animation/editor tools).

## Repo Layout
- `client/` - Three.js + Vite app, game + editor UI, assets, PSX render settings.
- `server/` - Colyseus + Express server, rooms, snapshots, REST endpoints.
- `shared/` - Shared constants/protocol types for client + server.
- `docs/PROJECT.md` - Consolidated documentation (this file).

## Key Commands (pnpm)
- `pnpm install`
- `pnpm dev` (client on http://localhost:5173)
- `pnpm dev:server` (server on ws://localhost:2567)
- `pnpm build` (all workspaces)
- `pnpm lint`

## Runtime Ports & URLs
- Server: `ws://localhost:2567` (local)
- Client: `http://localhost:5173` (local)
- Production: Nginx on port 80 proxies WebSocket/API to server port 2567.

## Deployment (Docker/Coolify)
The `Dockerfile` builds an all-in-one image with Nginx + server.
- Container listens on **port 80** (Nginx).
- Game server listens on **port 2567** internally.
- Required persistent paths:
  - `/app/animations`
  - `/app/config`
  - `/app/data`

**Coolify (Dockerfile build):**
- Container port: **80**
- Environment: set `GAME_PORT=2567` (prevents port 80 conflict)
- Volumes: map the three paths above

## Architecture Summary
- Server runs Express + Colyseus on port 2567.
- Nginx serves static client assets and proxies `/matchmake/*`, `/api/*`, and room paths to Colyseus.
- Client connects to the same domain and auto-selects ws/wss based on protocol.

## PSX/Visual Settings
The client has PSX-style rendering options and color adjustments. Settings are shared between game and editor and persisted via local storage. Console presets are available in the UI.

## Editor Tools
The editor supports animation clips (JSON), Mixamo retargeting, and scene configuration. Scene definitions are stored in `/app/config/scenes.json` and served from `/config/scenes.json`.
