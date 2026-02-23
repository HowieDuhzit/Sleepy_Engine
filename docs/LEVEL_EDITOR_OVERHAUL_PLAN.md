# Level Editor Overhaul Plan (3D-First AAA)

## Goal
Turn the editor into a full-screen 3D-first experience where all tooling is overlaid on top of the scene, with fast world-building workflows and minimal raw JSON editing.

## Design Direction
- Scene is always primary (no page-like layout competing with viewport).
- UI is a tactical HUD: compact, layered, contextual, keyboard/controller friendly.
- Most common actions are one click or one hotkey away.
- Advanced systems stay available without blocking core flow.

## Pillars
1. 3D-first workflow
2. Fast placement and transform operations
3. Data-driven no-code logic authoring
4. Strong debug visibility
5. Production-safe save/version flow

## Phase 1: Foundation (implemented in this pass)
- Full-screen overlay skin for editor HUD and panels.
- Left and bottom tools converted to glass overlay surfaces above scene.
- Level dropper tools expanded:
  - `drop_box`, `drop_zone`, `drop_ground`, `drop_player`, `drop_crowd`
- Ground/player/crowd fully deletable and placeable.
- Fallback plane placement when no mesh is present.

## Phase 2: Builder UX
- Introduce dedicated Level top bar:
  - Select, Move, Rotate, Scale, Dropper presets, Snap toggle, Local/World toggle.
- Add right-side contextual inspector drawer (selected object only).
- Add multi-select + group operations.
- Add duplication with offset and radial array tools.

## Phase 3: Terrain and World Tools
- Terrain sculpt brushes (raise/lower/smooth/flatten/noise paint).
- Spline roads and path authoring.
- Zones with visual handles, layering, and filtering.
- Environment presets (time of day, fog, sky, post stack).

## Phase 4: No-Code Gameplay Systems
- Visual graph editor for logic (node canvas).
- Trigger/action templates and validation rules.
- Runtime preview with simulation timeline.
- Component presets library with searchable catalog.

## Phase 5: AAA Pipeline Features
- Prefab system with variants.
- Asset browser with drag-drop placement and tags.
- Layer manager with lock/hide/solo.
- Bookmarks and camera shots.
- Build validation report (missing refs, invalid IDs, perf budget warnings).

## Controls and Input Standard
- Keyboard and controller parity for core editor actions.
- Pointer lock free-fly + transform gizmo manipulation shortcuts.
- Action map:
  - `Q/W/E/R` tools
  - `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y` history
  - `F` focus
  - `Del/Backspace` delete

## Technical Boundaries
- Keep scene contracts in existing game-scoped APIs:
  - `/api/games/:gameId/scenes`
- Keep schema compatibility with `zones`, `components`, `logic`, `ground`, `player`, `crowd`.
- Keep renderer and editor in same runtime to avoid duplicate state systems.

## Success Metrics
- New user can place, transform, and save a playable scene in under 3 minutes.
- 90% of common authoring tasks completed without editing JSON manually.
- Editor actions remain responsive with 500+ objects and multiple zones.
- No regressions in scene save/load determinism.
