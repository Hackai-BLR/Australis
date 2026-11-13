# Build plan

This is the main plan. It lists every feature that is still to be built, grouped into phases, with what each one depends on. `docs/features.md` says why each feature exists; this file says in what order it is built and who owns which files.

The first build (features 1 to 9) is merged. Everything below comes after it.

The CampusAi repository (the Campus IA platform) is merged into this one. Its folders sit at the repo root next to `backend/` and `frontend/`. Phase 0 joins the two systems so they run as one product on the same server.

## How to pick up a feature

Anyone on the team can do this, with or without Claude. With Claude, say: "read the main plan, check what is being worked on, and start a free feature on your own branch".

1. **Read** this file and `CLAUDE.md` on `origin/main`.
2. **Check what is taken.** GitHub is the record of who works on what, not this file:
   ```
   git fetch origin --prune
   git branch -r --list "origin/feat/f*" "origin/phase/*" "origin/fix/p1-*"
   gh pr list --state all --limit 100 --json number,title,state,isDraft,headRefName,author
   ```
   A feature is **done** when its pull request is merged, **taken** when a branch `feat/<id>-...` exists on origin (for example `feat/f10-attendance` or `feat/m2-sign-in`), and **free** otherwise.
3. **Choose** a free feature in the open phase whose dependencies are all done. If a dependency is only taken, you may still start: merge its branch into yours and say so in the pull request.
4. **Claim it at once**, before writing code, so nobody else starts the same feature:
   ```
   git checkout -b feat/f10-attendance origin/main
   git commit --allow-empty -m "Start F10 attendance"
   git push -u origin feat/f10-attendance
   gh pr create --draft --base main --title "F10 Attendance" --body "In progress."
   ```
   If the phase kickoff branch (`phase/<N>`) is not merged into `main` yet, start from `origin/phase/<N>` instead of `origin/main`.
5. **Build** inside the paths the feature owns (the "Owns" line). Follow the rules in `CLAUDE.md`. Use the feature's migration range.
6. **Finish.** Run the checks from `CLAUDE.md`, push, mark the pull request ready, and wait for CI. Do not merge your own pull request without a review.

## Phases

A phase is open when its kickoff branch is published. The kickoff does the work that several features share, so that features in the same phase touch different files and can be built at the same time.

| Phase | Name | Depends on | Status |
|---|---|---|---|
| 0 | Join Australis and Campus IA | First build, the CampusAi merge | M9 to M12 merged (2026-11-13). Round 3 open: M13 and M14. Then checkpoint B again, then M6 |
| 1 | Test and stabilise the first build | First build | Done. Checkpoint A passed and is tagged `checkpoint-a` (2026-11-13) |
| 2 | Records and staff basics | Phase 1 | Not open |
| 3 | Follow-up and closing | Phase 2 | Not open |
| 4 | Student extras | Phase 3 | Not open |
| 5 | Integrations and polish | Phase 4 | Not open |

Rules for every phase:

- **A checkpoint closes each phase** (see "Checkpoints"). The next phase opens only after it passes.
- **Kickoff first.** Before a phase starts, one person publishes `phase/<N>` and opens its pull request to `main`. The kickoff holds the kernel additions, the new module skeletons, and an empty submodule (a "seam") for each feature that shares a crate with another feature. The kickoff is the only package in a phase that edits the frozen shared files.
- **One branch and one pull request per feature**, named `feat/<id>-<slug>` with the id in lower case.
- **Migrations.** Each feature has its own range of ten numbers: feature `F<NN>` uses `0600 + (NN - 10) * 10` onwards (F10 is 0600 to 0609, F20 is 0700 to 0709). Kickoffs use the core range (0002 to 0049).
- **Production is off limits** for every task except M6. No task contacts the real server, `campusia.tech`, Cloudflare or any real account, runs Ansible or OpenTofu against anything but a local container, or reads credentials. Everything is built and tested locally with fake data.
- **Placeholders.** Nothing calls an outside service. A feature that would need one uses a placeholder provider behind a trait and shows the "Simulado" badge.
- **Models, when agents do the work.** Sonnet writes all code. Opus or Fable only plan and review.

## Checkpoints

A checkpoint closes a phase. At a checkpoint `main` is demo ready: the product can be shown to an audience from start to finish with no workaround. The next phase does not open until the checkpoint passes.

| Checkpoint | Closes | Runs on | The demo in one line |
|---|---|---|---|
| A. First build works | Phase 1 | Local test stack, placeholders | A professor builds a campus and teaches a class; a student follows it |
| B. One product, live | Phase 0 | Test stack with the core, then `campusia.tech` | One sign-in by email code, both kinds of course, a real AI change |
| C. Records | Phase 2 | `campusia.tech` | A class leaves attendance and a summary; grades go to the secretary |
| D. Follow-up and closing | Phase 3 | `campusia.tech` | The secretary closes grades, sees who is at risk and exports the record |
| E. Student experience | Phase 4 | `campusia.tech` | A student studies from one page, answers the survey and gets a certificate |
| F. Final | Phase 5 | `campusia.tech`, on a phone | The whole story on a phone, with real slides and a calendar |

Phases 0 and 1 do not depend on each other, so A and B can be reached in either order. B also needs A.

**A checkpoint passes when all of this is true:**

1. Everything under "Needs" is merged. A feature that is not finished is left out of the screens; nothing half-working is shown.
2. The automated end-to-end tests of this checkpoint and of every earlier one pass on a fresh database with fake data.
3. The demo story has been run from the first step to the last twice, by two different people or agents, without help and without skipping a step.
4. There is no open finding of severity blocker or major.
5. Placeholder data shows the "Simulado" badge, and unconfirmed rules are marked as unconfirmed.
6. For a live checkpoint: it is deployed, the health check is green, and going back to the previous checkpoint's tag has been tried once.
7. `main` is tagged `checkpoint-a`, `checkpoint-b` and so on. A demo is always given from the latest tag, never from a branch.

**End-to-end tests.** They live in `pruebas/australis/checkpoint-<letter>/`, as Playwright tests in the style of `pruebas/fase-*`: `aceptacion/` for what must work and `ataque/` for what must be refused. Task M8 creates the folder and the tests for checkpoint A, so checkpoint A cannot pass before M8 is merged. From then on, every feature's pull request adds its own tests to the folder of the checkpoint that closes its phase.

### Checkpoint A: first build works

- **Needs:** T1, T2, T3, M8.
- **Demo story:**
  1. The secretary signs in and creates a professor.
  2. The professor signs in and creates a campus from a template.
  3. The professor asks the AI for a change, previews it and accepts it; then restores the earlier revision.
  4. The professor imports students from an Excel file, checks the preview and confirms.
  5. The professor adds graded items and pastes 30 grades from a spreadsheet.
  6. The professor creates today's class and uploads a PDF presentation.
  7. A student accepts the invite, signs in, and sees the course, the grades and the "join today's class" button.
  8. The professor presents; the student's page follows each slide, browses away, and comes back to the live slide.
  9. The professor ends the class; the recording and the transcript appear on the class page.
- **Must be refused:** a professor on another professor's campus; a student writing a grade; a student reading another student's grades; a request to the AI to change a grade; a suspended student.

### Checkpoint B: one product, live

- **Needs:** checkpoint A, M1 to M5, M7, M9 to M14. It passes first on a test stack that runs the core and Australis together. Then M6 switches production, and steps 1, 2 and 6 are repeated on `campusia.tech`.
- **Demo story:**
  1. A person signs in at `campusia.tech` with an email code. There is no password anywhere.
  2. The course list shows a campus with modules and a free course side by side, with the same look.
  3. A professor creates a campus with modules from the course list and lands in it without signing in again.
  4. The professor asks the AI for a change. The model answers through the core's proxy, the preview shows the change, and the token quota in the core goes down. On the local stack the model is the scripted fake one; on `campusia.tech` it is the real one.
  5. The professor imports students in the campus; the administrator sees those enrolments in the core.
  6. A university administrator opens the campus as secretary; a student of another campus is refused.
  7. A change merged to `main` is live within minutes, and a failed deploy goes back to the earlier version by itself. Locally this is not rehearsed by hand: it counts as done when the deploy tests in `pruebas/tramo-infraestructura/` pass. It is seen for real after M6.
- **Accepted, not findings:** the limit on sign-in codes per address is by design and is a setting; pull requests #32 and #35 were opened empty and are closed.
- **Must be refused:** a forged or expired identity header; a request that reaches Australis without going through the core; a person disabled in the core; a professor with no token quota left asking the AI; any model credential readable from Australis.

### Checkpoint C: records

- **Needs:** checkpoint B, K2, F10 to F17.
- **Demo story:**
  1. A student's home shows the next step: the class today.
  2. The professor ends the class and takes attendance from the session, then corrects one student with a reason.
  3. The professor generates the class summary, edits it and approves it; only then does the student see it.
  4. The student writes notes on two slides and exports them.
  5. The professor overrides the grading scale for this campus, then sends the grades to the secretary.
  6. The secretary finds the campus in the list of all campuses, checks the grades and returns them with a note.
  7. A student reports a problem from a campus page; the professor sees it in the inbox.
- **Must be refused:** a student changing attendance; an attendance correction with no reason; a student reading a summary that is not approved; one student reading another's notes; a professor opening the list of all campuses; an AI call past the summary quota.

### Checkpoint D: follow-up and closing

- **Needs:** checkpoint C, K3, F20 to F28.
- **Demo story:**
  1. The professor's home shows today's tasks: take attendance, enter grades, review a summary.
  2. The professor enters one grade for a group; every member gets it.
  3. The secretary sees which campuses have grades missing, sent, checked or closed, and closes one.
  4. The professor tries to change a closed grade and is refused; the secretary corrects it with a reason, and the log shows who, when and why.
  5. One student's record shows attendance and grades together.
  6. The secretary opens the dropout alerts, sees the reason for each, and marks one as handled.
  7. The secretary exports grades and attendance and opens the file in Excel.
  8. A student jumps from a slide to what was said on it in the transcript.
  9. The secretary filters a list and suspends three students at once with one reason.
- **Must be refused:** a teacher editing a closed gradebook; a secretary correction with no reason; a professor reading alerts or exports of another campus; a student opening another student's record.

### Checkpoint E: student experience

- **Needs:** checkpoint D, K4, F30 to F34.
- **Demo story:**
  1. During a live presentation the professor asks a poll; the results show on screen.
  2. After class the student opens study mode: slides, recording, transcript, summary and notes on one page.
  3. The student asks for an explanation and for practice questions; the questions appear only after the professor approves them.
  4. The course ends. The student cannot open the next course until the survey is answered, then can.
  5. The secretary sees the response rate, with no way to see who answered what.
  6. The student downloads an attendance certificate and a completion certificate, both marked "No oficial"; the secretary looks one up by its code.
- **Must be refused:** opening the next course with the survey pending; a completion certificate before grades are closed; study help past the student's daily quota; a survey answer traced to a student.

### Checkpoint F: final

- **Needs:** checkpoint E, K5, F40 to F43. F44 and F45 are not needed.
- **Demo story:**
  1. The stories of checkpoints A to E, shortened to ten minutes, run on a phone.
  2. The professor uploads a `.pptx` and presents it.
  3. The student subscribes to the class calendar from Outlook and sees the next class.
  4. A person signs in with the Microsoft option (simulated unless the university has allowed it).
- **Must be refused:** a calendar link guessed or reused after it was reset; everything refused at the earlier checkpoints, checked again.

## Dependency map

`A <- B` means B needs A.

```
CampusAi merge
  <- M1 deploy Australis on the server  <- M6 switch production to this repository
  <- M2 one sign-in                     <- M3 one course list, M4 real AI through the model proxy
  <- M5 one visual design
  <- M8 browser tests                   <- checkpoint A
  <- M9 joint stack and tests, M10 enrolments, M11 administrator views, M12 flaky test  <- checkpoint B
  <- M13 administrator is secretary of their university, M14 course template lockfile   <- checkpoint B
  <- M7 CI for the Campus IA folders    <- M6 switch production to this repository
M4 real AI <- F11 class summary and F33 study help stop being simulated (they can still be built on the placeholder)

First build
  <- F10 attendance        <- F22 student record, F23 export, F24 dropout alerts, F25 professor home, F31 certificates
  <- F11 class summary     <- F25 professor home, F32 study mode, F33 study help
  <- F12 submit grades     <- F20 closing grades <- F31 certificates
                           <- F21 pending grades
  <- F13 all campuses      <- F21 pending grades, F24 dropout alerts, F28 search and filters, F30 surveys
  <- F14 campus settings   <- F30 surveys
  <- F15 slide notes       <- F32 study mode
  <- F16 report a problem
  <- F17 next step card
  <- F26 group grades
  <- F27 transcript tied to slides <- F32 study mode
  <- F34 live polls
  <- F41 Microsoft sign-in, F42 calendar feed, F43 PowerPoint conversion
Everything with screens <- F40 phone pass
```

## Phase 0: join Australis and Campus IA

Both systems are in this repository but do not know about each other yet. Campus IA is live at `campusia.tech`; Australis runs only locally and on placeholders. This phase makes Australis run on the same server, behind the same sign-in, with the same model access and the same look.

How they fit together:

- **Campus IA stays the front door.** Caddy sends every request to the core (`nucleo`), which owns sign-in, universities, roles, enrolments and token quotas.
- **Australis becomes a service behind it.** The core forwards requests for one reserved address to the Australis backend and adds its signed identity header, the same way it already does for course containers (`contratos/identidad-cursos.md`). In production Australis trusts that header and nothing else.
- **A course has a kind.** "Campus with modules" is an Australis campus (gradebook, classes, recordings, slides, AI proposals). "Free course" is a Campus IA container shaped by the agent. Both appear in the same course list.
- **One model access.** Australis's `AiProvider` gets a real implementation that calls the core's model proxy, so the token quotas and usage records are shared. The placeholder stays for development and tests.

**Status: M1, M2, M3, M4, M5, M7 and M8 are merged (2026-11-13).** Checkpoint B was run once and did not pass; M9 to M12 are what it found, and they are merged. Building M9 showed two more gaps, M13 and M14. M6 is done by a person after checkpoint B passes on a local stack.

There is no kickoff. The tasks own different folders, except where a dependency is listed.

| Id | Task | Depends on | Owns |
|---|---|---|---|
| M1 | Deploy Australis on the server | CampusAi merge | `despliegue/**`, `infraestructura/servidor/**`, `pruebas/tramo-infraestructura*/**`, a new `contratos/tramo-australis.md` |
| M2 | One sign-in | CampusAi merge | `backend/crates/core/src/auth.rs` and `config.rs`, `backend/crates/server/src/**`, `nucleo/src/enrutador.rs` and `identidad.rs`, `tests/identity.rs`, `frontend/src/shared/auth/**` |
| M3 | One course list | M2 | `nucleo/src/cursos.rs` and `cuenta.rs`, `interfaz/src/MisCursos.tsx` and the create-course screen, `backend/crates/modules/campus/src/lib.rs` |
| M4 | Real AI through the model proxy | M2 | `backend/crates/core/src/ai.rs`, `nucleo/src/modelo.rs` and `cupos.rs` |
| M5 | One visual design | CampusAi merge | `frontend/src/shared/ui/**` |
| M6 | Switch production to this repository | M1, M7 | Operations. A person with the credentials does it |
| M7 | CI for the Campus IA folders | CampusAi merge | `.github/workflows/**` |
| M8 | Browser tests for Australis | CampusAi merge | a new `pruebas/australis/**` |
| M9 | Joint local stack and browser tests for checkpoint B | M2, M3, M4 | a new `pruebas/australis/checkpoint-b/**`, `pruebas/australis/comun/**`, the test images |
| M10 | Enrolments reach the core on every change | M3 | `backend/crates/modules/roster/src/**`, `nucleo/src/cursos/modulos/**` |
| M11 | Administrator and owner see campuses with modules | M3, M10 | `nucleo/src/cursos/modulos/**`, `nucleo/src/admin.rs`, `interfaz/src/Admin.tsx` |
| M12 | Stop the flaky AI proxy deadline test | M4 | `backend/crates/server/tests/ai_proxy.rs`, `backend/crates/core/src/ai.rs` |
| M13 | The administrator is secretary of their own university | M2, M11 | `contratos/identidad-australis.md`, `nucleo/src/identidad.rs` and `enrutador.rs`, `backend/crates/core/src/auth.rs`, `access.rs` and `directory.rs`, a core migration, `backend/crates/modules/campus/src/lib.rs`, `tests/identity.rs`, `pruebas/australis/checkpoint-b/**` |
| M14 | The course template installs with the SDK it was locked to | M9 | `plantilla-curso/pnpm-lock.yaml`, `sdk/package.json`, `despliegue/continuo/desplegar.sh`, `.github/workflows/campusia.yml`, `pruebas/australis/imagenes/**`, `pruebas/australis/checkpoint-b/**` |

- **M1 Deploy.** A second systemd service for the Australis backend on its own local port (the core already uses 8080), with its database and uploads under `/srv/campusia`. The continuous deploy builds, tests and installs `backend/` and `frontend/` next to the core, checks health, and rolls both back together. The daily backup and Litestream include the Australis database and uploads. Ansible installs all of it. Tests in the style of the existing infrastructure tests.
- **M2 One sign-in.** The core reserves one address for Australis, forwards to it, strips cookies and adds the signed identity header with the person's platform role. Australis gets a second way to identify the caller: verify the header (Ed25519 public key from the environment), create the account on first sight, and map roles (owner and university administrator to secretary, professor mark to professor, everyone else to student). A setting chooses the mode; password sign-in stays for local development and the tests. In header mode the password routes and invites are off. An account that is suspended or disabled in the core has no access in Australis.
- **M3 One course list.** Creating a course in Campus IA offers the two kinds. "My courses" lists both. A campus with modules belongs to a university. Enrolments made in either system reach the other through the platform API; the core is the record of who is enrolled.
- **M4 Real AI.** An `AiProvider` that calls the core's model proxy with a token that only works there, so no model credential enters Australis. Usage counts against the professor's token quota in the core; the Australis daily quota stays as a second limit. The "Simulado" badge disappears only when this provider is the one configured.
- **M5 One design.** The Australis design tokens take the palette, type and bar of `prototipo/campus.html`, so moving between the two does not look like changing product.
- **M6 Switch production.** Point the server's deploy at this repository (deploy key, webhook, `despliegue_origen` in Ansible). After this, every merge to `main` is live within 5 minutes, so it comes last and only when M1 and M7 are merged.
- **M7 CI.** GitHub jobs for `nucleo` (cargo test), `interfaz`, `sdk` and `plantilla-curso` (pnpm build and test), and a check that no secret is committed (`pruebas/tramo-infraestructura/test_secretos.py`).
- **M13 The administrator is secretary of their own university.** Today the core signs a university administrator as a student for Australis, because Australis does not know universities and a secretary there can act on every campus (`contratos/identidad-australis.md`). That breaks the agreed decision that the administrator is the secretary. Fix both sides: the identity payload carries the person's university and whether they administer it; a campus in Australis records the university it belongs to (set when it is created through the core); and access gives an administrator the secretary's rights only on campuses of that university, while the owner keeps them everywhere. Secretary-only screens that list across campuses show an administrator only their university. Update the contract, and turn the two expected-failure tests in `pruebas/australis/checkpoint-b/` for steps 5 and 6 into normal tests. Add attack tests: an administrator of one university is refused on another university's campus, through the screens and the API.
- **M14 The course template installs with the SDK it was locked to.** The integrity hash for `vendor/campusia-sdk-0.3.0.tgz` in `plantilla-curso/pnpm-lock.yaml` does not match the SDK that is packed at build time, and `plantilla-curso/Containerfile` installs with `--frozen-lockfile`. The checkpoint B test image rewrites the hash to get past this (`pruebas/australis/imagenes/fijar-sdk.mjs`), and the CI job installs with `--no-frozen-lockfile`, so nothing shows whether a free course can be built from a fresh checkout. Find out first, in a local container built the way `despliegue/continuo/desplegar.sh` builds it, whether a free course starts today. Then make it hold: the packed SDK is the same bytes every time or the lock is regenerated when the SDK changes, CI installs the template with `--frozen-lockfile`, the test image stops rewriting the hash, and the expected-failure test about the lockfile becomes a normal test.
- **M9 Joint stack and tests for checkpoint B.** One command starts the core, Australis and the fake model together on a fresh database, the way production wires them (the core in front, the signed identity header, the model proxy). The fake model gets a script that answers a campus-shaping request with real operations, so the preview can be shown without a model credential. The test image has `pnpm`, so a free course starts. Playwright tests in `pruebas/australis/checkpoint-b/` cover steps 1 to 6 of the checkpoint B story (`aceptacion/`) and its refusals (`ataque/`). Pull request #36 is closed in favour of fixing the image.
- **M10 Enrolments on every change.** Pull request #34 makes a confirmed import write the enrolments to the core. Finish the rest: suspending, reactivating, re-inviting and adding a guest teacher in Australis reach the core in the same request, and a failure to reach the core is shown, not swallowed. Start from `main` after #34 is merged.
- **M11 Administrator and owner views.** Finish pull request #33: start by merging `origin/fix/cb-campus`, then fix what its review left open (an owner with no university gets 403 or 404; the Australis backend checks fail). The administrator sees the campuses with modules of the university and their enrolments; the owner sees them for every university.
- **M12 Flaky test.** `a_call_dropped_by_the_caller_deadline_is_still_logged` in `tests/ai_proxy.rs` fails now and then in CI on pull requests that do not touch the backend. Make it independent of timing. It must be fixed before M6, because the server runs the tests before every deploy.
- **M8 Browser tests.** Playwright tests for checkpoint A in `pruebas/australis/checkpoint-a/`, in the style of `pruebas/fase-*`: acceptance (the demo story) and attack (what must be refused). They start their own stack on a fresh database and sign in with the password mode, so they do not wait for M2. One command runs them from nothing.

Decisions for phase 0 (agreed 2026-11-13):

1. **Address.** Australis is served on one reserved address, `campus.campusia.tech`. The core never gives that name to a course.
2. **Secretary.** The university administrator is the secretary in Australis; so is the owner. There is no separate secretary role to grant.
3. **Enrolments.** Australis keeps its student import (Excel, CSV or pasted list, with the preview). On confirm it writes the enrolments to the core, which is the record of who is enrolled.

## Phase 1: test and stabilise the first build

**Status: T1, T2, T3 and T4 are done (2026-11-13).** The test pass found one thing above minor: screens show the API's error messages in English. Decision: they stay in English for now (pull request #27 was closed, its branch `fix/p1-app` is kept). This is an accepted exception to "screen text is Spanish" and is not a finding at any checkpoint.

No new features. The goal is a first build that works in a browser, not only in automated tests.

| Id | Task |
|---|---|
| T1 | Merge pull request #19 (students follow the professor's slide again). It has never been tried in a browser |
| T2 | Drive the running app, one pass per area: sign-in and users, create a campus, AI shaping, import students, student home, gradebook, classes, recordings, synced slides, access by role, and screen text ("Simulado" badges, Spanish, the "unconfirmed" note on grading rules) |
| T3 | Fix every confirmed finding of severity major or higher, on branches `fix/p1-<module>`, one pull request per module |
| T4 | Remove the leftover agent worktrees under `.claude/worktrees/` (local only) |

Test on a separate Compose project (`docker compose -p australis-test`, other ports) so the data in the normal volumes is not touched.

## Phase 2: records and staff basics

Every feature here depends only on the first build.

**Kickoff K2 (`phase/2`):**
- Kernel: campus-scoped settings (`settings::get_for_campus` falls back to the global value; `grading_scale` and `final_rule` take a campus id; update the call sites in `grades`).
- Kernel: `ZoomProvider::fetch_participants`, with a placeholder that returns a made-up list built from the campus members.
- Kernel: `directory` functions the secretary lists need (all campuses with member counts, all members of a user).
- Kernel: a scripted placeholder reply for the class summary in `crates/core/scripts/`.
- New skeleton modules, backend and frontend: `admin`, `support`.
- Seams: `classes/attendance`, `classes/summary`, `grades/submission`, `campus/settings`, `slides/notes`, each with an empty router already merged and a slot in the page that will show it.
- Frontend shell: modules may export `globalWidgets` (shown on every page), used by F16.

| Id | Feature | Depends on | Owns |
|---|---|---|---|
| F10 | Attendance | First build | `classes/attendance` (backend and frontend), `tests/attendance.rs` |
| F11 | AI class summary | First build | `classes/summary`, `tests/class_summary.rs` |
| F12 | Submit grades to the secretary | First build | `grades/submission`, `tests/grades_submission.rs` |
| F13 | All campuses (secretary) | First build | module `admin`, `tests/admin.rs` |
| F14 | Settings per campus | First build | `campus/settings`, `tests/campus_settings.rs` |
| F15 | Notes per slide | First build | `slides/notes`, `tests/slide_notes.rs` |
| F16 | "Report a problem" button | First build | module `support`, `tests/support.rs` |
| F17 | "Next step" card | First build | `frontend/src/app/pages/**` |

- **F10 Attendance.** One record per student per class: present, absent, late or excused. "Take from the session" fills it from `fetch_participants`; the professor can then correct it. Every change after the first save needs a reason and writes an audit row. A student sees their own attendance. Teach to write, own record to read. The AI has no path to this table.
- **F11 AI class summary.** From the class transcript, through `ai::run` with its own daily quota setting (`ai.summary.daily_quota`) and usage log. The result is a draft with key points and tasks for the next class. The professor edits and approves it; students see it only after approval. "Simulado" badge.
- **F12 Submit grades.** A campus's grades have a status: draft, sent, checked. A teacher sends them; the secretary marks them checked or returns them with a note. Every status change is audited. Includes a secretary-only list of the status of every campus (used by F21). Closing is F20.
- **F13 All campuses.** One secretary screen listing campuses, professors and students, with text search and filters by role and status. Read-only; links into each campus and user.
- **F14 Settings per campus.** A "Configuración" tab (Manage) to override the grading scale, the final-grade rule and the attendance rule for one campus. Shows which values are inherited and which are still unconfirmed. Changes are audited.
- **F15 Notes per slide.** A student writes private notes on each page of a presentation and exports them all as text. Nobody else can read them.
- **F16 Report a problem.** A button on every page. The report stores the page, the campus if any, and the text. It goes to the campus's professors when it is about a campus and to the secretary otherwise. Simple inbox with open and resolved.
- **F17 Next step card.** On the student home: the single most urgent thing (class today, a new recording, a new grade). Frontend only, from what the modules already export.

## Phase 3: follow-up and closing

**Kickoff K3 (`phase/3`):**
- Kernel: `signals`, a table of per-student facts per campus (attendance rate, absences in a row, missing graded items, final grade, grades closed, last sign-in) that modules write through `australis_core::signals` in the same transaction as their change.
- Writers: `classes/attendance` and `grades` update their signals on every save. The kernel fills last sign-in itself.
- New skeleton modules: `followup` (backend and frontend), `record` and `study` (frontend only).
- Seams: `grades/closing`, `grades/export`, `grades/groups`, `classes/attendance/export`, `slides/timeline`.

| Id | Feature | Depends on | Owns |
|---|---|---|---|
| F20 | Closing grades | F12 | `grades/closing`, `tests/grades_closing.rs` |
| F21 | Pending grades (secretary) | F12, F13 | `admin/pending` (frontend) |
| F22 | Attendance and grades in the same record | F10 | frontend module `record` |
| F23 | Export grades and attendance | F10 | `grades/export`, `classes/attendance/export`, `tests/export.rs` |
| F24 | Dropout alerts | F10, F13, K3 | module `followup`, `tests/followup.rs` |
| F25 | Professor home | F10, F11 | `frontend/src/app/pages/**` |
| F26 | Group grades | First build | `grades/groups`, `tests/grades_groups.rs` |
| F27 | Transcript tied to slides | First build | `slides/timeline`, frontend module `study`, `tests/slide_timeline.rs` |
| F28 | Search, filters and bulk actions | F13 | new files in `frontend/src/shared/ui`, the lists in `admin` and `roster` |

- **F20 Closing grades.** The secretary closes a checked campus. After that only the secretary can correct a grade, always with a reason, and the correction is logged with who, when and why. Teachers get 409 on a closed gradebook. The closing rule is a setting.
- **F21 Pending grades.** A secretary list of which campuses have grades missing, sent, checked or closed.
- **F22 Same record.** One page per student per campus with attendance and grades together, for the teacher and the secretary, and "Mi registro" for the student.
- **F23 Export.** Grades and attendance as CSV that Excel opens directly (UTF-8 with BOM, `;` separator). A real `.xlsx` needs a new dependency and is left for phase 5.
- **F24 Dropout alerts.** Rules over the signals (absences in a row, missing work, no recent sign-in), with thresholds as settings marked unconfirmed. Each alert shows the reason and a suggested action, and the secretary can mark it handled with a note. No AI.
- **F25 Professor home.** Only today's tasks: take attendance, enter grades, review a summary.
- **F26 Group grades.** Define groups for a graded item and enter one grade that is applied to every member, with one audit row per student.
- **F27 Transcript tied to slides.** The slides module records when each page was shown during a live session. The study page lines up the transcript with that timeline so a student can jump to what was said on a slide.
- **F28 Search, filters and bulk actions.** A shared table with search, filters and row selection, applied to the secretary lists and the roster (bulk suspend with one reason, bulk re-invite).

## Phase 4: student extras

**Kickoff K4 (`phase/4`):**
- Kernel: `gates`, so a student with an unanswered required survey is refused on other campuses with a clear error code. `access::require_campus` checks it.
- New skeleton modules: `surveys`, `certificates`.
- Seams: `classes/tutor`, `slides/polls`.

| Id | Feature | Depends on | Owns |
|---|---|---|---|
| F30 | Course surveys | F13, F14 | module `surveys`, `tests/surveys.rs` |
| F31 | Certificates (unofficial) | F10, F20 | module `certificates`, `tests/certificates.rs` |
| F32 | Study mode | F11, F15, F27 | frontend module `study` |
| F33 | Study help | F11 | `classes/tutor`, `tests/tutor.rs` |
| F34 | Live polls | First build | `slides/polls`, `tests/polls.rs` |

- **F30 Surveys.** An end-of-course survey per campus. The student must answer it before their next course opens (the gate). Answers are stored without the student's identity; only "answered or not" is linked to the student. The secretary sees the response rate.
- **F31 Certificates.** Attendance and completion certificates as a print-ready page, built from the signals, marked "No oficial", with a code the secretary can look up. Completion needs closed grades.
- **F32 Study mode.** One page per class with slides, recording, transcript, approved summary and the student's notes.
- **F33 Study help.** "Explain this" and practice questions on a class's transcript and summary, through `ai::run` with a daily quota per student. Practice questions are shown to students only after the professor approves them. "Simulado" badge.
- **F34 Live polls.** A quick question during a live presentation, with results on screen. Answers are not graded.

## Phase 5: integrations and polish

**Kickoff K5 (`phase/5`):** kernel `IdentityProvider` trait with a placeholder; any new dependencies (for example an `.xlsx` writer).

| Id | Feature | Depends on | Owns | Note |
|---|---|---|---|---|
| F40 | Works well on a phone | Everything with screens | all of `frontend/src` | Run it alone, last |
| F41 | Microsoft sign-in | M2, K5 | `nucleo` sign-in | Sign-in now belongs to the Campus IA core (email code). A Microsoft option goes there and waits on open question 2 in `features.md` |
| F42 | Calendar feed | First build | `classes/calendar` | A private `.ics` link that Outlook can subscribe to. Needs no key |
| F43 | PowerPoint conversion | First build | kernel `SlideConverter`, backend image | LibreOffice in the image. Needs no key |
| F44 | Exams that allow AI | Not set | Not set | Blocked: the goal is still vague. Needs a product decision first |
| F45 | Real Zoom provider | Not set | kernel providers | Blocked: needs keys and open question 1 in `features.md`. Real AI is M4 |

## Running a phase with agents

`workflows/phase.js` is a Claude Code workflow script that runs one phase following this plan. It reads this file and GitHub, publishes the kickoff, then builds, reviews and fixes each free feature on its own branch and pull request. It never merges anything. Run it from a Claude Code session that has the Workflow tool:

```
Workflow({ scriptPath: "<repo>/workflows/phase.js", args: { phase: 2 } })
```

`phase: 0` runs the tasks that join the two systems (M6 is left for a person). `{ checkpoint: "A" }` runs a checkpoint in place of a phase: it starts a test stack, runs the end-to-end tests, walks the demo story twice, tries what must be refused, opens fix pull requests for what it finds, and reports whether the checkpoint passes. Optional arguments for a phase: `only: ["F10", "F13"]` to build some features, `max: 3` to cap how many features one run starts.
