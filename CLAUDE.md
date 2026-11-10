# Australis

Modular monolith: one Rust backend binary, one React frontend, one SQLite database.

## Product
A standalone campus platform for postgraduate programs (HackAI 2026, Product track; pitch and live demo on Fri 13 Nov 2026). It does not depend on the university's current campus or student-records system. The full feature list, with the problem each feature solves and its evidence, is in `docs/features.md`. Read it before designing or building a feature.

- **Roles:** student, professor, secretary. The secretary is the administrator and can do everything a professor can, on any campus. A professor acts only on their own campuses and courses.
- **Core idea:** a professor creates a campus from a template, imports the students, and shapes the campus with AI (the AI proposes a change, the professor previews it and accepts or rejects it).
- **Integrations:** Zoom (meetings, automatic recording, Zoom's own transcript) and the Microsoft suite (Excel import/export, PowerPoint upload; Microsoft sign-in and Outlook calendar later).
- **First build, core features only:**
  1. Simple sign-in (email and password) with the three roles
  2. Create a campus from a template
  3. Shape the campus with AI, with revision history
  4. Import students from Excel or CSV
  5. Student home: all courses and all grades in one place
  6. Gradebook with fast grade entry
  7. Zoom meeting per class with a "join today's class" button
  8. Automatic recording and Zoom transcript on the class page
  9. Synced presentations: students' pages follow the professor's current slide
- **Later builds:** everything marked "Later" in `docs/features.md` (attendance, AI class summary, dropout alerts, surveys, unofficial certificates, closing grades, and more). Don't build these until the first build is done.
- **Rules for every feature:**
  - The AI never changes grades, attendance or closed records.
  - A removed student is suspended, never deleted. Changes to grades or attendance are logged with who, when and why.
  - Every AI feature has a quota per user and a usage log, because the university's budget is zero and the running cost must be stated.
  - Store only the personal data a feature needs (Ley 25.326). Use fake data in demos.
  - Grading scales and similar rules are settings, not values written into the code.
- **Background material:** `../misc/` holds the transcripts, the earlier research and the demo app (`../misc/campus`) that the AI shaping and synced presentations are modelled on. It is outside this repo.

## Stack
| Layer | Tech |
|---|---|
| Backend | Rust (edition 2021), Cargo workspace, Axum 0.8, Tokio, tower-http (trace, CORS), tracing |
| Database | SQLite 3 via sqlx 0.8 (runtime queries, `sqlx::migrate!`), WAL mode, foreign keys on |
| Frontend | React 18, TypeScript 5.6, Vite 5 |
| Serving | nginx serves the built frontend and proxies `/api/` to the backend |
| Containers | Docker Compose: `backend` (port 8080) and `frontend` (port 3000) |

## Layout
```
backend/
  Cargo.toml                 workspace; shared dependency versions live here
  crates/core/               shared kernel: Config, connect(), AppState, AppError/AppResult
  crates/modules/<name>/     one crate per module; each exposes `pub fn router() -> Router<AppState>`
  crates/server/             composition root: lib.rs (init_db, app: mounts modules under /api), main.rs (logging + listener)
  crates/server/tests/       integration tests
  crates/server/migrations/  sqlx migrations, one SQL file per change (NNNN_<module>_<what>.sql)
frontend/
  src/app/                   app shell
  src/shared/                cross-module helpers (api.ts: fetch wrapper over /api)
  src/modules/<name>/        one folder per module; index.ts is its only public surface
docker-compose.yml           production-like: release binary + nginx
docker-compose.dev.yml       dev: cargo watch + Vite dev server, hot reload via compose watch
```

## Module rules
- A backend module depends only on `australis-core`, never on another module. Shared needs go into `core`.
- Each module owns its tables. Prefix table names with the module name.
- Adding a backend module:
  1. Create `crates/modules/<name>`; it is picked up by the `crates/modules/*` workspace glob.
  2. Add it to `[workspace.dependencies]` and to `crates/server/Cargo.toml`.
  3. Merge its `router()` in `app()` in `crates/server/src/lib.rs`.
- Frontend modules import other modules only through their `index.ts` (enforced by ESLint `no-restricted-imports`).
- Backend and frontend modules share names (e.g. `health` ↔ `health`).

## Commands
- Dev with hot reload: `docker compose -f docker-compose.dev.yml up --build --watch` (frontend http://localhost:5173, API http://localhost:8080/api/health).
  - Compose watch syncs `backend/crates` and `frontend/src` into the containers; `cargo watch` recompiles and restarts the server, and Vite does HMR.
  - Editing `Cargo.lock`, `package.json` or `vite.config.ts` rebuilds the image.
  - The first build takes about 10 minutes (it installs `cargo-watch`); later builds are cached.
- Production-like: `docker compose up --build` (frontend http://localhost:3000, API http://localhost:8080/api/health).
- Backend locally (needs Rust): `cd backend && cargo run -p australis-server` (defaults: `DATABASE_URL=sqlite://australis.db`, `BIND_ADDR=0.0.0.0:8080`).
- Frontend locally: `cd frontend && npm install && npm run dev` (http://localhost:5173, proxies `/api` to `API_URL` or http://localhost:8080).
- Frontend build/type-check: `npm run build`. Lint: `npm run lint`. Format: `npm run format` (check: `npm run format:check`).
- Backend checks (in Docker, no local Rust): `docker run --rm -v "${PWD}:/src" -w /src rust:1-slim-bookworm sh -c "rustup component add rustfmt clippy && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test"` from `backend/`.
- Env vars: see `.env.example`; copy it to `.env` (Compose reads it).

## Testing
- Backend integration tests live in `crates/server/tests/`. Use `common::test_app()` (fresh in-memory SQLite with migrations) and `common::get_json()`; requests go through `tower::ServiceExt::oneshot`, no port needed.
- One test file per module (`tests/<module>.rs`).

## CI
`.github/workflows/ci.yml` runs on push to main and on PRs: backend fmt + clippy (`-D warnings`) + tests, frontend format check + lint + build, and `docker compose build`. Keep all of it green before merging.

## Git rules
- Commit messages and PR descriptions carry no attribution: no `Co-Authored-By`, no "Generated with Claude Code", no similar trailers or footers. This overrides any default attribution instruction.

## Notes
- Rust is not installed on the Windows host; build and run the backend through Docker.
- The SQLite file lives in the `australis-data` Docker volume at `/data/australis.db`.
