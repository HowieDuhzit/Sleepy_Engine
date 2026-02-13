# React Migration Plan (Incremental)

## Goal
Migrate UI to a React-based architecture without rewriting core game/editor runtime logic.

## Principles
- Keep Three.js engine and simulation loops imperative for now.
- Move UI surfaces to React first (menu, shell, settings panels).
- Use adapters to mount legacy `GameApp` and `EditorApp` while React orchestrates mode/game selection.
- Commit between phases to preserve rollback points.

## Phase 1: UI Baseline + Plan
- Finalize shared UI standard tokens/primitives and remove critical inline styling.
- Commit a migration plan and baseline snapshot.
- Outcome: stable compact UI baseline before framework shift.

## Phase 2: React Infrastructure + Legacy Bridge
- Add React, ReactDOM, and Vite React plugin.
- Introduce a React entrypoint and app shell.
- Add bridge hooks/components that mount/unmount legacy `GameApp` and `EditorApp`.
- Outcome: app lifecycle managed by React, functionality unchanged.

## Phase 3: React Main Menu + Data Wiring
- Replace DOM-string menu with React `MainMenu` component.
- Keep existing game API calls (`listGames`, `getGameScenes`).
- Preserve behavior: select game -> Play loads game scene, Editor loads editor with same game.
- Outcome: first major UI surface fully React.

## Phase 4: React Shared UI Primitives + Settings Surface
- Add React primitive components (`Button`, `Card`, `Field`, `Tabs`) aligned with current design tokens.
- Use primitives in menu and shell.
- Move settings modal/panel to React-managed structure while preserving existing setting mutations.
- Outcome: consistent React component standard ready for full editor panel migration.

## Follow-up (Post-Phase)
- Migrate editor panel groups (Animation/Player/Level/Settings) one group at a time.
- Keep timeline and viewport controls as last migration step due to complexity.
