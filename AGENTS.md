# Repository Guidelines

## Project Structure & Module Organization
This repo is a pnpm workspace with three packages:
- `client/`: Three.js + Vite app (console UI, game runtime, editor).
- `server/`: Colyseus + Express backend (project APIs, rooms, tick loop).
- `shared/`: Protocol/types shared by client and server.

Supporting directories:
- `assets/`: art, audio, VFX, and glTF content.
- `tests/`: future integration/unit tests (keep deterministic, server-focused).
- `docs/`: consolidated notes in `docs/PROJECT.md`.
- `server/projects/`: project data (animations, scenes, avatars, configs).

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
Projects are served from `server/projects/<projectId>/` and accessed via:
- `/api/projects` (list/create)
- `/api/projects/:projectId/animations/*`
- `/api/projects/:projectId/scenes`

When editing animations/scenes, ensure the project ID is set in the console menu or editor.

## Database
Postgres is supported via `DATABASE_URL` (optional). When unset, the server runs without DB access. For local docker, `docker-compose.local.yml` provisions Postgres.
