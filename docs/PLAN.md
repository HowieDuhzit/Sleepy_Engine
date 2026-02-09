# Implementation Plan

## Goal
Build a session-based multiplayer urban riot sandbox with authoritative networking, dense crowds, heat escalation, and short objective-based rounds (10–15 minutes).

## Scope Targets (Prototype)
- 1 map block (200m x 200m)
- 8 players, 100 simulated NPCs, 1000 far-instanced crowd
- 6 weapons, 20 destructibles
- Heat meter + 2 response phases
- 3 objective types

## Architecture
- **Client (`client/`)**: Three.js renderer, input, HUD, VFX, client-side prediction/interp.
- **Server (`server/`)**: Colyseus room, authoritative movement/combat, heat system, crowd AI.
- **Shared (`shared/`)**: Protocol/event types, constants, input schemas.

## Milestone Plan

### Phase 0 — Preproduction (1–2 weeks)
- Lock player cap, NPC LOD counts, tick rates (20Hz server, 60Hz render).
- Define crowd LOD policy (LOD0/1/2 and distances).
- Produce one-page spec and art direction notes.

### Phase 1 — Vertical Slice (Single-player feel) (2–4 weeks)
- **Movement & camera**: third-person controller, sprint/dodge, basic state machine.
- **Combat feel**: light/heavy melee, hit reactions, basic stamina.
- **Weapons**: pickup/drop, durability, thrown arc events.
- **Destructibles**: intact/broken/burned state swaps, fire timers.
- **Goal**: one player can cause satisfying chaos in a tiny block.

### Phase 2 — Authoritative Multiplayer (3–6 weeks)
- **Server authoritative movement**: input commands -> server sim -> snapshots.
- **Client interpolation/prediction**: reconcile local player, interpolate others.
- **Server authoritative combat**: server decides hits, damage, knockback.
- **Goal**: 4–8 players brawl with no desync disputes.

### Phase 3 — Crowd System (4–8 weeks)
- **Zone model**: agitation, density, faction bias per zone.
- **LOD replication**: LOD0 full entity sync, LOD1 sparse, LOD2 procedural render.
- **Rendering**: instanced meshes + promoted nearby agents.
- **Goal**: 300–2000 visible people without bandwidth/FPS collapse.

### Phase 4 — Heat & Response (3–6 weeks)
- **Heat accumulation**: destruction, assaults, fires, alarms.
- **Heat decay**: suppression, arrests, extinguish fires, restore power.
- **Response phases**: patrols -> riot lines -> armored response -> crackdown.
- **Goal**: match pacing tells a story without scripts.

### Phase 5 — Objectives & Scoring (2–4 weeks)
- Rotating objectives, 2–3 active at a time.
- Team/personal scoring, clear win conditions.
- **Goal**: players move with intent, not just wandering.

### Phase 6 — Perf & Net Optimization (ongoing)
- Binary protocol, delta snapshots, interest management.
- Aggressive LOD, instancing, texture atlases.
- Remove per-frame allocations.

### Phase 7 — Content & Polish (ongoing)
- Modular city kit, destructible variants.
- VFX/audio library, final HUD.

## Key Risks & Mitigations
- **Crowd perf**: enforce LOD + instancing; keep near-sim count bounded.
- **Network load**: interest grid + delta snapshots; cap update rates.
- **Combat feel**: prioritize animation timing and hit feedback early.

## Acceptance Criteria (Prototype)
- 8 players with authoritative combat and movement.
- Crowd feels alive (LOD + instancing) with stable FPS.
- Heat visibly escalates response phases.
- Objectives rotate and influence player movement.
