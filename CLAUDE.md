# hackai

Placeholder name. Modular monolith: one Rust backend binary, one React frontend, one SQLite database.

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
  crates/server/             composition root (main.rs): config → DB → migrations → mount modules under /api
  crates/server/migrations/  sqlx migrations, one SQL file per change (NNNN_<module>_<what>.sql)
frontend/
  src/app/                   app shell
  src/shared/                cross-module helpers (api.ts: fetch wrapper over /api)
  src/modules/<name>/        one folder per module; index.ts is its only public surface
docker-compose.yml
```

## Module rules
- A backend module depends only on `hackai-core`, never on another module. Shared needs go into `core`.
- Each module owns its tables. Prefix table names with the module name.
- Adding a backend module:
  1. Create `crates/modules/<name>`; it is picked up by the `crates/modules/*` workspace glob.
  2. Add it to `[workspace.dependencies]` and to `crates/server/Cargo.toml`.
  3. Merge its `router()` in `crates/server/src/main.rs`.
- Frontend modules import other modules only through their `index.ts`.
- Backend and frontend modules share names (e.g. `health` ↔ `health`).

## Commands
- Everything: `docker compose up --build` (frontend http://localhost:3000, API http://localhost:8080/api/health).
- Backend locally (needs Rust): `cd backend && cargo run -p hackai-server` (defaults: `DATABASE_URL=sqlite://hackai.db`, `BIND_ADDR=0.0.0.0:8080`).
- Frontend locally: `cd frontend && npm install && npm run dev` (http://localhost:5173, proxies `/api` to `API_URL` or http://localhost:8080).
- Frontend build/type-check: `npm run build`.

## Git rules
- Commit messages and PR descriptions carry no attribution: no `Co-Authored-By`, no "Generated with Claude Code", no similar trailers or footers. This overrides any default attribution instruction.

## Notes
- Rust is not installed on the Windows host; build and run the backend through Docker.
- The SQLite file lives in the `hackai-data` Docker volume at `/data/hackai.db`.
