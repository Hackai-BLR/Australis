# Findings: phase 2 and checkpoint C

Status on 2026-11-13, with `main` at `adb15d2`. This file lists everything the reviews and the checkpoint runs found during phase 2, and what happened to each item.

## Where checkpoint C stands

Checkpoint C does not pass yet. One finding of severity major is open, and its fix is in pull request #65.

| Check | Run 1 (`main` at `baadb11`) | Run 2 (`main` at `adb15d2`) |
|---|---|---|
| Everything under "Needs" is merged | Yes | Yes |
| The end-to-end suite exists | No | Yes |
| The end-to-end suite is green | Not applicable | Yes, 18 of 18 |
| Demo story, first rehearsal | Failed at step 5 | Passed |
| Demo story, second rehearsal | Failed at step 5 | Passed |
| The six refusals are tested | Yes | Yes |
| No open blocker or major | No | No (one major, fixed in #65) |

To close the checkpoint:

1. Merge #65 after its CI finishes.
2. Run the checkpoint again: `workflows/phase.js` with `{ checkpoint: "C" }`.
3. If it passes, tag `main` as `checkpoint-c`.

Checkpoint C is planned to run on `campusia.tech`. Both runs used the local joint stack only (core, Australis and the fake model). The live part has not been done.

## Before a live demo

These three are minor in the code, but an audience would see them.

| What the audience sees | Cause | What to do |
|---|---|---|
| The "join today's class" button opens a dead page | The Zoom placeholder builds its links from `APP_BASE_URL`, which defaults to `http://localhost:5173` (`backend/crates/core/src/config.rs:115`) | Set `APP_BASE_URL` to the public address of the app where the demo runs |
| The class summary reads "respuesta del modelo falso: no tengo una propuesta preparada", with no "Simulado" badge | The test stack uses `AI_PROVIDER=proxy` with the fake model, which has no reply for a summary | Run the demo with `AI_PROVIDER=placeholder` (scripted summary, with the badge) or with the real model |
| The secretary's lists may show the university as "1" | `/api/admin/campuses` and `/api/grades/submissions` return the university id as text, not its name | Check the screen before the demo. Not confirmed on screen: the rehearsals used the API only |

## Open: major

| Area | Finding | Status |
|---|---|---|
| classes, grades, roster | A reason made only of an invisible character (U+200B, zero-width space) is accepted where a reason is required: an attendance correction, overwriting a grade, suspending a member. The change is audited with a reason that shows as blank | Fixed in #65, not merged. The fix adds `audit::trim_reason` in the kernel and uses it in every reason check. Tests cover attendance, grades overwrite, campus settings and member suspension |

Notes on #65:

- It edits `crates/core/src/audit.rs` and `directory.rs`, which are frozen files. The shared reason check lives there.
- The tests were written with the fix, not before it. Nobody saw them fail first.
- Its CI had not reported when this file was written.

## Fixed and merged

| Area | Finding | Severity | Fixed in |
|---|---|---|---|
| app | The student home coloured each final grade against the global pass mark, not the course's own scale | Major | #53 (kickoff), commit `67d223a` |
| core | `set_for_campus` accepted a grading scale that left stored grades outside it | Major | #53, commit `67d223a`. The kernel now reads `grades_entries` and `grades_items` to check this, which breaks the rule that the kernel only reads `core_` tables |
| classes | Generating a summary overwrote the professor's saved edits, on a second click and when an edit landed during the AI call | Major | #59. Regenerating over an edited draft needs confirmation (409 without it). The race during the AI call has no test |
| campus | F14 (settings per campus) was not on `main`: pull request #54 was merged into `phase/2` after `phase/2` had already been merged | Major | #63 |
| tests | No end-to-end suite existed for checkpoint C | Check failed | #64, `pruebas/australis/checkpoint-c/`, 18 tests |

## Open: minor

None of these was fixed. The workflow only fixes blockers and majors.

### Kernel

| Finding | Where |
|---|---|
| A campus override stores the `confirmed` flag the manager sends, so a professor can hide the "not confirmed by the program" note | `backend/crates/core/src/settings.rs:354` |
| `set_for_campus` stores the caller's raw JSON, so unknown extra keys of any size are saved and served to every student | `backend/crates/core/src/settings.rs:376` |
| `trim_reason` (in #65) uses a fixed list of invisible characters. A reason made only of others is still accepted: U+2800, U+3164, U+115F, U+1160, U+FFA0, variation selectors, tag characters | `backend/crates/core/src/audit.rs:33` |

### Attendance (F10)

| Finding | Where |
|---|---|
| Taking attendance from the session a second time reapplies Zoom's status to every student and undoes earlier manual corrections | `backend/crates/modules/classes/src/attendance/mod.rs:432` |
| A student's own record shows no "Simulado" badge when its status came from the placeholder list | `frontend/src/modules/classes/attendance/AttendancePanel.tsx:112` |
| "Tomar de la sesión" is always enabled, even for a class with no Zoom meeting, and it does not ask for a reason as the manual path does | `frontend/src/modules/classes/attendance/AttendancePanel.tsx:195` |
| No test covers the secretary reading and writing attendance on a campus she is not a member of | `backend/crates/server/tests/attendance.rs` |
| A class ended the instant it is created shows an end time earlier than its start time | `backend/crates/modules/classes/src/lib.rs` |

### Class summary (F11)

| Finding | Where |
|---|---|
| Approve takes no version, so a teacher can publish a text they never saw | `backend/crates/modules/classes/src/summary/mod.rs:295` |
| The "Simulado" badge stays on a summary the professor has fully rewritten by hand | `backend/crates/modules/classes/src/summary/mod.rs:269` |
| The quota of 20 summaries a day is easy to use up in rehearsals, and the professor then sees a raw English error | Setting `ai.summary.daily_quota` |

### Grade submission (F12)

| Finding | Where |
|---|---|
| A "sent" or "checked" status stays when a teacher edits grades afterwards, so the secretary's check no longer describes the gradebook | `backend/crates/modules/grades/src/submission/mod.rs:120` |
| A new send keeps the previous return note. The migration comment says the opposite | `backend/crates/modules/grades/src/submission/mod.rs:75` |
| The secretary can send grades to herself | `backend/crates/modules/grades/src/submission/mod.rs:122` |
| No test covers the status list being limited to the campuses of a university-scoped secretary | `backend/crates/server/tests/grades_submission.rs` |
| The frontend tests check which buttons render. None clicks send, check or return | `frontend/src/modules/grades/submission/submission.test.tsx` |
| The top-level `scale` in `/api/grades/mine` is the global one while each course carries its own. Harmless unless a screen reads the top-level value | `grades` module |

### All campuses (F13)

| Finding | Where |
|---|---|
| The frontend tests never check the text search box | `frontend/src/modules/admin/admin.test.tsx` |
| `PersonPage` never clears its error state: after one failed load the error stays and the spinner never returns | `frontend/src/modules/admin/PersonPage.tsx:19` |
| The university is returned as the id in text, not as a name | `/api/admin/campuses`, `/api/grades/submissions` |

### Settings per campus (F14)

| Finding | Where |
|---|---|
| Save errors in the "Configuración" dialog show on the page behind the dialog, in the server's English wording. No test covers this path | `frontend/src/modules/campus/settings/SettingsTab.tsx:113` |
| An empty number field is sent as 0, so a cleared field becomes a valid value | `frontend/src/modules/campus/settings/SettingsTab.tsx:82` |

### Seen by the attack test, not filed as findings

- A non-manager gets 404 on `POST /campuses/{id}/members/{uid}/invite`. The other manage-only roster routes answer 403.
- Several 403 bodies say "not allowed" in English under a Spanish interface. The plan accepts English API errors.
- A student can call `POST /classes/{cid}/recording/sync`. It returns 200 and only refreshes the recording status.
- Grades can be entered for a suspended student.

## What was not tested

- **Screens in the rehearsals.** Both demo rehearsals and the attack test used the HTTP API, because the agents have no browser tool. The Playwright suite does drive the screens, but it ran once per stack and was not repeated to look for unstable tests.
- **`campusia.tech`.** Nothing was deployed or checked live. Going back to the previous tag was not tried.
- **Real providers.** Zoom is the placeholder. The AI went through the core's proxy to the fake model only.
- **File uploads.** Oversized files and non-PDF files were not attacked. Spreadsheet and CSV import parsing was not attacked.
- **The earlier suites on the new `main`.** The checkpoint A and B suites were not run again in these two runs.
- **Local checks on some features.** The disk filled up during the phase 2 build. F12 and F13 did not finish their local backend checks; CI on GitHub passed for both, and the combined tree passed 277 backend tests and 168 frontend tests in the integration check.

## Debts taken on purpose

| Debt | Why |
|---|---|
| The kernel reads `grades_entries` and `grades_items` (#53) | To refuse a campus scale that excludes stored grades. No module could do this check |
| The `slides` module reads `classes_classes` (#52, checkpoint B) | To refuse a presentation linked to a class of another campus. No kernel function exists for it |
| The summary-quota test writes the setting straight into the test database (#64) | No route changes `ai.summary.daily_quota`. The test restores the value afterwards |
| The repository is public | The organization used all its GitHub Actions minutes for the month. The whole history was searched for secrets first; only fake test values were found |
