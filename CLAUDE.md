# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Session-based multiplayer urban riot sandbox prototype. The project uses an authoritative server architecture with client-side prediction and interpolation. Built for 8 players, 100 simulated NPCs, and 1000 far-instanced crowd members.

**Core Tech Stack:**
- Client: Three.js + Vite (TypeScript)
- Server: Colyseus authoritative simulation (TypeScript)
- Shared: Protocol/types workspace
- Package Manager: pnpm workspaces

## Development Commands

### Setup
```bash
pnpm install
```

### Development (run both in separate terminals)
```bash
pnpm dev:server  # Server on ws://localhost:2567
pnpm dev         # Client on http://localhost:5173
```

### Build & Lint
```bash
pnpm build       # Build all workspaces
pnpm lint        # Lint all workspaces
pnpm -C client build    # Build client only
pnpm -C server build    # Build server only
pnpm -C shared build    # Build shared only
```

### Docker (local test/deployment)
```bash
docker compose up --build  # Client on :5175, Server on :2567
```

## Architecture

### Workspace Layout
- `client/` - Three.js renderer, input handling, HUD, client-side prediction/interpolation
- `server/` - Colyseus room, authoritative movement/combat, heat system, crowd AI
- `shared/` - Protocol constants, TypeScript types, collision helpers
- `docs/PLAN.md` - Detailed implementation plan and milestones

### Authoritative Server Model
The server owns all gameplay state. Clients send **input commands** (not positions) via `PROTOCOL.input`, and the server broadcasts **snapshots** via `PROTOCOL.snapshot`.

**Server Tick Rate:** 20Hz (set in `RiotRoom.setSimulationInterval`)
**Client Render Rate:** 60Hz

### Client-Side Prediction & Interpolation
- Local player uses client-side prediction (applies input immediately, reconciles with server snapshots)
- Other players use interpolation (smooth between server snapshots)
- See `client/src/game/GameApp.ts` for prediction/interpolation implementation

### Crowd System
Crowd agents are simulated entirely server-side:
- NavGrid-based A* pathfinding (2.5m cell size)
- Player repulsion forces (CROWD_REPEL_RADIUS, CROWD_REPEL_FORCE)
- Server broadcasts crowd snapshots via `PROTOCOL.crowd`
- Client renders crowd with VRM models and animations

### Heat & Response Phases
- Heat accumulates from destruction, assaults, fires, alarms
- Heat decays from suppression, arrests
- Response phases: 0 (patrols) → 1 (riot lines) → 2 (armored response)
- Heat thresholds: >0.4 = phase 1, >0.7 = phase 2

### Collision & Physics
**Server-side:**
- Circle-AABB collision for obstacles (`resolveCircleAabb`)
- Circle-Circle collision for player-player and player-crowd (`resolveCircleCircle`)
- Gravity and jump physics for players

**Client-side:**
- Rapier3D physics engine (`@dimforge/rapier3d-compat`)
- Client physics only for visual effects (not authoritative)

### Animation System
**Character Animation:**
- VRM models loaded via `@pixiv/three-vrm`
- Mixamo animations retargeted to VRM skeletons (see `client/src/game/retarget.ts`)
- Custom clip format in `client/src/game/clip.ts`
- Animation blending: idle/walk/run based on velocity
- Procedural animation: head look, landing kick, bob

**Animation Files:**
- Located in `server/animations/` (mounted in Docker)
- Loaded by client from `/animations/` public path
- Custom JSON clip format parsed with `parseClipPayload` and `buildAnimationClipFromData`

## Protocol & Networking

### Message Types (defined in `shared/src/index.ts`)
- `PROTOCOL.input` - Client → Server: PlayerInput (movement, actions)
- `PROTOCOL.snapshot` - Server → Client: WorldSnapshot (players, heat, phase)
- `PROTOCOL.crowd` - Server → Client: CrowdSnapshot (NPC positions/velocities)
- `PROTOCOL.event` - Server → Client: Game events (future use)

### Shared Constants
All gameplay constants are defined in `shared/src/index.ts`:
- Movement: MOVE_SPEED, SPRINT_MULTIPLIER, CROUCH_MULTIPLIER
- Physics: GRAVITY, JUMP_SPEED, GROUND_Y
- Combat: ATTACK_RANGE, ATTACK_COOLDOWN, ATTACK_DAMAGE, ATTACK_KNOCKBACK
- Crowd: CROWD_COUNT, CROWD_SPEED, CROWD_REPEL_RADIUS, CROWD_REPEL_FORCE
- Obstacles: OBSTACLES array (static collision geometry)

**When modifying gameplay behavior, update constants in `shared/` so both client and server stay in sync.**

## Key Implementation Notes

### State Management
- Server state uses Colyseus Schema (`@colyseus/schema`) in `server/src/state/RiotState.ts`
- PlayerState includes: position (x,y,z), velocity (vx,vy,vz), health, stamina
- Client maintains separate predicted state for local player

### Input Handling
- Input captured in `client/src/input/InputState.ts`
- Inputs are sent to server with sequence numbers for reconciliation
- Server processes inputs in `RiotRoom.update()` and broadcasts snapshots

### Camera System
- Third-person orbit camera in `client/src/game/GameApp.ts`
- Controlled via mouse drag (orbitYaw, orbitPitch, orbitRadius)
- Pointer lock mode available (not currently used)
- Camera offset follows player position with spherical coordinates

### Deployment
- Dockerfile has multi-stage builds with targets: `server`, `client`, `allinone`
- `allinone` target combines server + nginx for single-container deployment
- Nginx serves client static files and proxies WebSocket to server
- Environment variables: ANIMATIONS_DIR for server animations path

## Development Workflow

1. **Making Changes:**
   - Update shared types/constants in `shared/src/index.ts` first
   - Run `pnpm -C shared build` to recompile
   - Implement in server (`server/src/rooms/RiotRoom.ts`)
   - Implement in client (`client/src/game/GameApp.ts`)
   - Test with both server and client running

2. **Adding New Features:**
   - Follow the milestone plan in `docs/PLAN.md`
   - Keep server authoritative - never trust client for gameplay decisions
   - Add constants to `shared/` for any values that affect gameplay

3. **Performance Considerations:**
   - Server targets 20Hz simulation (50ms per tick)
   - Client targets 60 FPS rendering
   - Crowd LOD and instancing for large NPC counts
   - Avoid per-frame allocations in hot paths

## Common Pitfalls

- **Don't trust client position/velocity** - Server recalculates from inputs
- **Don't forget to rebuild shared** - Changes to `shared/` require `pnpm -C shared build`
- **Don't modify state directly outside update loop** - Colyseus Schema requires proper updates
- **Don't exceed tick budget** - Keep server update under 50ms (20Hz target)
