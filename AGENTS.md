# Repository Guidelines

## Project Structure & Module Organization

This repo is a pnpm workspace with three packages:

- `client/`: Three.js + Vite app (console UI, game runtime, editor).
- `server/`: Colyseus + Express backend (game APIs, rooms, tick loop).
- `shared/`: Protocol/types shared by client and server.

Supporting directories:

- `assets/`: art, audio, VFX, and glTF content.
- `tests/`: future integration/unit tests (keep deterministic, server-focused).
- `docs/`: consolidated notes in `docs/PROJECT.md`.
- `server/projects/`: game data (animations, scenes, avatars, configs, logic, assets).

## Build, Test, and Development Commands

Use pnpm from the repo root:

- `pnpm dev`: run the client (`client/`) with Vite.
- `pnpm dev:server`: run the Colyseus server (`server/`).
- `pnpm build`: build all packages (`shared`, `client`, `server`).
- `pnpm lint`: lint all packages with ESLint.
- `pnpm test`: placeholder until tests are added.

## Coding Style & Naming Conventions

TypeScript everywhere. Formatting is handled by Prettier and linting by ESLint.

- Indentation: 2 spaces.
- Filenames: `kebab-case.ts` for modules.
- Types/classes: `PascalCase`; functions/vars: `camelCase`; constants: `UPPER_SNAKE_CASE`.
- Keep networking payloads in `shared/` and reference them from both `client/` and `server/`.

## Omakase Code Principles

Apply these principles to all changes in this repo.

### Core Philosophy

- Convention over configuration: use ecosystem defaults unless there is a proven limitation.
- The menu is omakase: prefer mainstream, boring, well-supported tools over custom stacks.
- Optimize for programmer happiness: clarity over cleverness, strong naming over comments.
- Use sharp knives responsibly: powerful abstractions are fine, but keep behavior legible and debuggable.

### Project Conventions (Mandatory)

- Follow existing workspace structure (`client/`, `server/`, `shared/`); do not introduce parallel patterns.
- Group code by feature/domain and keep files focused on one concept.
- Keep functions small, use guard clauses, and avoid deep nesting.
- Use explicit, intention-revealing names. Boolean names should read like questions (`isReady`, `hasAuthority`).
- Use idiomatic error handling and add context only where it improves diagnosis.
- Minimize dependencies; favor built-ins and existing project libraries before adding new packages.
- Test behavior, not implementation details. Prioritize deterministic server simulation and message validation.
- Comments should explain why, not restate what the code already says.
- Enforce formatting/linting with project tooling (`prettier`, `eslint`); consistency beats personal preference.

### Execution Workflow (Mandatory)

- For multi-task requests, spin up specialized agents and run tasks in parallel whenever they are independent.
- Assign each agent one clear responsibility, then wait for all agents and consolidate outcomes into one coherent result.
- After all task outputs are integrated, run a final file-pass review using the `$omakase-code` principles to ensure the combined change is clean, consistent, and works together as intended.
- The final pass must verify naming clarity, small focused functions, idiomatic error handling, and project-wide formatting/lint consistency.

### Multiplayer and Engine Rules

- Keep authoritative outcomes on the server for competitive or state-critical gameplay.
- Design mechanics and networking with latency in mind (prediction/reconciliation where needed).
- Prefer data-driven tuning in `server/projects/<gameId>/` over hardcoded balance values.
- Treat content IDs, schema fields, and network payloads as versioned contracts across `shared/`, `client/`, and `server/`.
- Make systems observable: logs and debug surfaces should make runtime behavior inspectable.

## Testing Guidelines

No test framework is wired yet. When adding tests:

- Prefer `*.test.ts` naming near the module or in `tests/`.
- Cover server tick determinism and message validation first.
- Add scripts to `package.json` and document them here.

## Commit & Pull Request Guidelines

Use Conventional Commits:

- `feat: add crowd LOD scaffold`
- `fix: clamp player stamina`
- `chore: update lint rules`

PRs should include a concise summary, test steps (commands + expected output), and screenshots or clips for client-visible changes.

## Configuration & Secrets

Use `.env` files for local config. Never commit secrets. Document required variables in `README.md` once they exist.

## Project Data & APIs

Games are served from `server/projects/<gameId>/` and accessed via:

- `/api/games` (list/create)
- `/api/games/:gameId/animations/*`
- `/api/games/:gameId/scenes`

When editing animations/scenes, ensure the game ID is set in the console menu or editor.

## Database

Postgres is supported via `DATABASE_URL` (optional) and Redis via `REDIS_URL` (optional). When unset, the server runs without DB/Redis access. For local docker, `docker-compose.local.yml` provisions both.
