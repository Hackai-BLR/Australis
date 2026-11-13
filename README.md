# Australis + Campus IA

A campus platform for postgraduate programs. This repository holds two systems that are being joined into one product, deployed on the same server (`campusia.tech`).

| System | Folders | What it does |
|---|---|---|
| Campus IA (platform) | `nucleo/`, `interfaz/`, `plantilla-curso/`, `sdk/`, `pruebas/`, `contratos/`, `despliegue/`, `infraestructura/`, `handoffs/`, `prototipo/` | Sign-in by email code, universities, roles, enrolments, per-course containers shaped by an agent, versions and publishing, token quotas, deployment and backups |
| Australis (campus modules) | `backend/`, `frontend/`, `docs/`, `workflows/` | Campus from a template shaped with AI proposals, student import, gradebook, Zoom classes, recordings and transcripts, synced presentations |

- How the two are joined, and everything still to build: [docs/plan.md](docs/plan.md)
- Why each feature exists: [docs/features.md](docs/features.md)
- Rules for the Australis folders: [CLAUDE.md](CLAUDE.md)
- Rules for the Campus IA folders (in Spanish): [CONVENCIONES.md](CONVENCIONES.md)
- Campus IA history and contracts: [handoffs/](handoffs/), [contratos/](contratos/)
- Screen prototype: [prototipo/campus.html](prototipo/campus.html)
