# Sleepy Engine

Retro-console style game engine with a built-in editor. The app boots to a splash screen, enters a console menu, and can launch games/scenes, open the editor, or change engine settings. The client is Three.js + Vite, the server is Colyseus + Express, and shared protocol types live in `shared/`.

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

## Console Flow
1) Splash screen boot
2) Console menu (play, editor, settings)
3) Load project + scene

## Workspace Layout
- `client/` Three.js + Vite frontend
- `server/` Colyseus authoritative backend
- `shared/` protocol/types shared between client/server
- `docs/PROJECT.md` consolidated project notes
- `server/projects/` project data (animations, scenes, avatars, configs)

## Database
Postgres is recommended for persistence and tooling. Configure with `DATABASE_URL` (see `docs/PROJECT.md`).

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
docker build --target server -t sleepy-server .
docker build --target client -t sleepy-client .
```
