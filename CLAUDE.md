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
- **Later builds:** the first build is merged. Everything marked "Later" in `docs/features.md` is built in phases following `docs/plan.md`, the main plan: it lists each feature's dependencies, owned paths and migration range, and how to claim a feature (a branch `feat/f<NN>-<slug>` and a draft pull request). Read it and check what is already taken on GitHub before starting any feature.
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
| Backend | Rust (edition 2021), Cargo workspace, Axum 0.8, Tokio, tower-http (trace), tracing; no CORS layer (the frontend reaches the API on its own origin) |
| Database | SQLite 3 via sqlx 0.8 (runtime queries, `sqlx::migrate!`), WAL mode, foreign keys on |
| Frontend | React 18, TypeScript 5.6, Vite 5 |
| Serving | nginx serves the built frontend and proxies `/api/` to the backend |
| Containers | Docker Compose: `backend` (port 8080) and `frontend` (port 3000) |

## Layout
```
backend/
  Cargo.toml                 workspace; shared dependency versions live here
  crates/core/               shared kernel (see "Kernel" below)
  crates/modules/<name>/     one crate per module; each exposes `pub fn router() -> Router<AppState>`
  crates/server/             composition root: lib.rs (build_state, app: mounts modules under /api), seed.rs (startup seed), main.rs (logging + listener)
  crates/server/tests/       integration tests; common/mod.rs holds the helpers
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
- **Kernel tables** (`core_` prefix: users, sessions, invites, campuses, members, audit log, settings, AI usage, AI quota) belong to `australis-core`. Modules reach them only through `australis_core` functions, never with their own SQL. A module table may have foreign keys only to `core_` tables; a reference to another module's row is a plain integer. One exception: a module migration may seed its own default settings with `INSERT OR IGNORE INTO core_settings`.
- Kernel database functions take `&mut SqliteConnection`; outside a transaction they take the write lock up front (`BEGIN IMMEDIATE`), inside one they join it. `app()` rewrites every non-JSON 4xx/5xx body (axum rejections, 405, 413) to `{"error": ...}`, so handlers can use plain `axum::Json`/`Path`/`Multipart`.
- The modules `auth`, `campus`, `roster`, `grades`, `classes` and `slides` already exist as skeletons: registered in the workspace, the server crate and `app()`, with their full `[dependencies]`. A feature package only fills in `src/`.
- **Frozen shared files.** After the kernel and frontend-shell packages, these change only when a package truly cannot finish otherwise (smallest change, reported as a deviation): `backend/Cargo.toml`, `Cargo.lock`, every crate's `Cargo.toml`, `crates/server/src/**`, `crates/core/**`, `tests/common/**`, `frontend/package.json` and its lockfile, `frontend/src/app/**`, `frontend/src/shared/**`, `nginx.conf`, the compose files and CI. Feature packages add no dependencies.
- **Migration ranges.** core 0001-0049, auth 0050-0099, campus 0100-0149, campus AI shaping 0150-0199, roster 0200-0299, grades 0300-0399, classes 0400-0449, recordings 0450-0499, slides 0500-0599. sqlx applies a lower-numbered file added after a higher one (`tests/migrations.rs` proves it), so branches cannot collide. Never edit a migration that is already on the branch you started from: sqlx refuses to start when a checksum changes. Add a new file instead.
- **After the first build** each feature `F<NN>` in `docs/plan.md` has its own migration range, `0600 + (NN - 10) * 10` and the nine numbers after it. Only a phase kickoff (`phase/<N>`) edits the frozen shared files.
- Adding a further backend module:
  1. Create `crates/modules/<name>`; it is picked up by the `crates/modules/*` workspace glob.
  2. Add it to `[workspace.dependencies]` and to `crates/server/Cargo.toml`.
  3. Merge its `router()` in `app()` in `crates/server/src/lib.rs`.
- Routes use axum 0.8 syntax `/{id}` (`/:id` panics at startup). Errors are `AppError`, sent as `{"error": "<message>"}`.
- Frontend modules import other modules only through their `index.ts` (enforced by ESLint `no-restricted-imports`).
- Backend and frontend modules share names (e.g. `health` ↔ `health`).

## Kernel (`australis-core`)
- `auth`: Argon2id passwords, `sign_in`, sessions, the `CurrentUser` extractor (401 without a valid `australis_session` cookie), `Role`.
- `access`: `require_role`, and `require_campus(conn, &user, campus_id, Access::Manage | Teach | View)`. Manage: the secretary, or a professor member. Teach: Manage plus a guest member. View: Teach plus an active student member. Suspended means no access.
- `directory`: users, campuses, members (add, suspend, reactivate; never delete), invites (only for an account with no password).
- `audit`: call `audit::record(&mut tx, ...)` in the same transaction as the change. The table is append-only.
- `settings`: grading scale, final-grade rule, AI quota, UTC offset. Never constants. The seeded grading rules are unconfirmed guesses (`"confirmed": false`); the screens must say so.
- `ai`: modules call the AI through `ai::run(...)`. It reserves the per-user daily quota (fails closed, 429), calls the provider and writes the usage log. A provider cannot be called without a quota reservation.
- `files` (`FileStore` under `UPLOAD_DIR`), `live` (`LiveHub` pub/sub), `http::upload_body_limit()` (layer for upload routes).
- Database functions take `&mut SqliteConnection`: pass `&mut conn` from `state.db.acquire()`, or `&mut tx` from `australis_core::begin_write(&state.db)` for a transaction that writes.

## Placeholder providers
Nothing in this build calls an outside service. Each provider is a trait in core with a placeholder in `AppState`. The UI shows a "Simulado" badge wherever placeholder data appears.

| Trait | Placeholder | What it returns |
|---|---|---|
| `AiProvider` (`state.ai`) | `PlaceholderAi` | Scripted replies from `crates/core/scripts/*.json`, matched by keyword; a fixed reply for anything else |
| `ZoomProvider` (`state.zoom`) | `PlaceholderZoom` | A made-up meeting whose links point at the app, and a sample recording with the transcript in `crates/core/samples/` |
| `SlideConverter` (`state.slides`) | `NoConverter` | "Not configured": upload a PDF instead of a `.pptx` |

`AI_PROVIDER` and `ZOOM_PROVIDER` accept only `placeholder`. The keys in `.env.example` are reserved for real providers.

## Commands
- Dev with hot reload: `docker compose -f docker-compose.dev.yml up --build --watch` (frontend http://localhost:5173, API http://localhost:8080/api/health).
  - Compose watch syncs `backend/crates` and `frontend/src` into the containers; `cargo watch` recompiles and restarts the server, and Vite does HMR.
  - Editing `Cargo.lock`, `package.json` or `vite.config.ts` rebuilds the image.
  - The first build takes about 10 minutes (it installs `cargo-watch`); later builds are cached.
- Production-like: `docker compose up --build` (frontend http://localhost:3000, API http://localhost:8080/api/health).
- Backend locally (needs Rust): `cd backend && cargo run -p australis-server` (defaults: `DATABASE_URL=sqlite://australis.db`, `BIND_ADDR=0.0.0.0:8080`).
- Frontend locally: `cd frontend && npm install && npm run dev` (http://localhost:5173, proxies `/api` to `API_URL` or http://localhost:8080).
- Frontend build/type-check: `npm run build`. Lint: `npm run lint`. Format: `npm run format` (check: `npm run format:check`).
- Backend checks (in Docker, no local Rust), from the repo root in PowerShell: `docker run --rm -v "${PWD}:/src" -v australis-cargo-registry:/usr/local/cargo/registry -v australis-target:/target -e CARGO_TARGET_DIR=/target -w /src/backend australis-check sh -c "cargo fmt --all --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked"`.
  - `australis-check` is `rust:1-slim-bookworm` plus rustfmt and clippy. Build it once from a Dockerfile with two lines: `FROM rust:1-slim-bookworm` and `RUN rustup component add rustfmt clippy`.
  - Use one target volume per worktree (`australis-target-<name>`). While iterating, run one test file: `cargo test --test <module>`.
- Env vars: see `.env.example`; copy it to `.env` (Compose reads it and passes each variable to the backend).
- First accounts: set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` to create the first secretary at startup. `SEED_DEMO=true` adds fake professors and students with the same password. The seed never changes an existing account.

## Testing
- Backend integration tests live in `crates/server/tests/`. `common::TestApp::new()` gives `{ router, db, state }` on its own temp-file SQLite database, with migrations applied and placeholder providers. Requests go through `tower::ServiceExt::oneshot`, no port needed.
- Requests: `app.get`, `post_json`, `put_json`, `patch_json`, `delete`, `post_multipart`, each with an optional session cookie. Seeding: `app.login_as(role)`, `seed_campus(&owner)`, `seed_student(campus)`, `seed_guest(campus)`.
- One test file per module (`tests/<module>.rs`).

## CI
`.github/workflows/ci.yml` runs on push to main and on PRs: backend fmt + clippy (`-D warnings`) + tests, frontend format check + lint + build, and `docker compose build`. Keep all of it green before merging.

## Git rules
- Commit messages and PR descriptions carry no attribution: no `Co-Authored-By`, no "Generated with Claude Code", no similar trailers or footers. This overrides any default attribution instruction.

## Notes
- Rust is not installed on the Windows host; build and run the backend through Docker.
- The SQLite file lives in the `australis-data` Docker volume at `/data/australis.db`. Uploads live in the `australis-uploads` volume at `/uploads`.
