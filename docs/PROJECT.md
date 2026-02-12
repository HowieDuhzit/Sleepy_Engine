# Sleepy Engine - Project Notes

## Overview
Sleepy Engine is a retro-console style game engine with a built-in editor. It boots with a splash screen, then enters a console-style main menu where you can:
- Launch a game (starting at its first scene)
- Open the integrated game editor
- Adjust global engine settings

Think of it as a development console: a game engine that runs in \"console mode\" but ships with full creator tools.

## Core Goals
- **Console feel**: boot splash, menu, and fast load into games.
- **Retro aesthetic**: PSX/retro rendering pipeline with adjustable presets.
- **Editor-first**: animation, player, and scene editing inside the same runtime.
- **Authoritative multiplayer**: Colyseus server with shared protocol for live testing.

## Repo Layout
- `client/` - Three.js + Vite app (game runtime + editor UI + PSX renderer).
- `server/` - Colyseus + Express server, game APIs, and game rooms.
- `shared/` - Shared constants/types for client + server.
- `server/projects/` - Game data (animations, scenes, avatars, configs, logic, assets).
 - Database: Postgres (optional, for persistence and tooling).

## Runtime Flow
1. Splash screen boot
2. Console menu (play, editor, settings)
3. Load a game + start scene

## Games
Games live in `server/projects/<gameId>/`:
- `game.json` - metadata (`project.json` still read for backward compatibility)
- `player.json` - player controller config
- `animations/` - JSON clips
- `scenes/` - `scenes.json`
- `avatars/` - VRM models
- `logic/` - game-specific scripts/data
- `assets/` - game-specific non-avatar assets

Game APIs:
- `GET /api/games` (list)
- `POST /api/games` (create)
- `GET/POST /api/games/:gameId/animations/:name`
- `GET/POST /api/games/:gameId/scenes`

## Database
Postgres is the recommended primary database for persistence and tooling. Configure it with:
- `DATABASE_URL=postgres://user:pass@host:5432/db`

Redis is optional for fast ephemeral state or future multi-node coordination:
- `REDIS_URL=redis://host:6379`

When unset, the server runs without DB/Redis access. When enabled, Redis is used as a short-lived cache for game reads (animations/scenes/player) and also powers Colyseus presence/driver for multi-node readiness.

## Key Commands (pnpm)
- `pnpm install`
- `pnpm dev` (client on http://localhost:5173)
- `pnpm dev:server` (server on ws://localhost:2567)
- `pnpm build` (all workspaces)
- `pnpm lint`

## Ports & Networking
- Server: `ws://localhost:2567` (local)
- Client: `http://localhost:5173` (local)
- Production: Nginx on port 80 proxies WebSocket/API to 2567

## Deployment (Docker/Coolify)
The `Dockerfile` builds an all-in-one image with Nginx + server.
- Container listens on **port 80** (Nginx).
- Game server listens on **port 2567** internally.
- Required persistent paths:
  - `/app/data`
  - `/app/projects` (game data)

**Coolify (Dockerfile build):**
- Container port: **80**
- Environment: set `GAME_PORT=2567`
- Volumes: map the paths above
 - Add `DATABASE_URL` if you attach Postgres

## Rendering Presets
PSX-style rendering is integrated in both game and editor. Presets, post-processing, and color adjustments are managed via the shared settings system.

## Editor Tools
The editor includes animation, player, and scene editing with game-scoped APIs. Scene definitions are stored in `server/projects/<gameId>/scenes/scenes.json` and are loaded through the same backend used by the game runtime.
