# Build plan

This is the main plan. It lists every feature that is still to be built, grouped into phases, with what each one depends on. `docs/features.md` says why each feature exists; this file says in what order it is built and who owns which files.

The first build (features 1 to 9) is merged. Everything below comes after it.

## How to pick up a feature

Anyone on the team can do this, with or without Claude. With Claude, say: "read the main plan, check what is being worked on, and start a free feature on your own branch".

1. **Read** this file and `CLAUDE.md` on `origin/main`.
2. **Check what is taken.** GitHub is the record of who works on what, not this file:
   ```
   git fetch origin --prune
   git branch -r --list "origin/feat/f*" "origin/phase/*" "origin/fix/p1-*"
   gh pr list --state all --limit 100 --json number,title,state,isDraft,headRefName,author
   ```
   A feature is **done** when its pull request is merged, **taken** when a branch `feat/f<NN>-...` exists on origin, and **free** otherwise.
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
| 1 | Test and stabilise the first build | First build | Next |
| 2 | Records and staff basics | Phase 1 | Not open |
| 3 | Follow-up and closing | Phase 2 | Not open |
| 4 | Student extras | Phase 3 | Not open |
| 5 | Integrations and polish | Phase 4 | Not open |

Rules for every phase:

- **Kickoff first.** Before a phase starts, one person publishes `phase/<N>` and opens its pull request to `main`. The kickoff holds the kernel additions, the new module skeletons, and an empty submodule (a "seam") for each feature that shares a crate with another feature. The kickoff is the only package in a phase that edits the frozen shared files.
- **One branch and one pull request per feature**, named `feat/f<NN>-<slug>`.
- **Migrations.** Each feature has its own range of ten numbers: feature `F<NN>` uses `0600 + (NN - 10) * 10` onwards (F10 is 0600 to 0609, F20 is 0700 to 0709). Kickoffs use the core range (0002 to 0049).
- **Placeholders.** Nothing calls an outside service. A feature that would need one uses a placeholder provider behind a trait and shows the "Simulado" badge.
- **Models, when agents do the work.** Sonnet writes all code. Opus or Fable only plan and review.

## Dependency map

`A <- B` means B needs A.

```
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

## Phase 1: test and stabilise the first build

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
| F41 | Microsoft sign-in | First build, K5 | `auth/microsoft` | Placeholder provider. A real one waits on open question 2 in `features.md` |
| F42 | Calendar feed | First build | `classes/calendar` | A private `.ics` link that Outlook can subscribe to. Needs no key |
| F43 | PowerPoint conversion | First build | kernel `SlideConverter`, backend image | LibreOffice in the image. Needs no key |
| F44 | Exams that allow AI | Not set | Not set | Blocked: the goal is still vague. Needs a product decision first |
| F45 | Real AI and Zoom providers | Not set | kernel providers | Blocked: needs keys and open question 1 in `features.md` |

## Running a phase with agents

`workflows/phase.js` is a Claude Code workflow script that runs one phase following this plan. It reads this file and GitHub, publishes the kickoff, then builds, reviews and fixes each free feature on its own branch and pull request. It never merges anything. Run it from a Claude Code session that has the Workflow tool:

```
Workflow({ scriptPath: "<repo>/workflows/phase.js", args: { phase: 2 } })
```

Optional arguments: `only: ["F10", "F13"]` to build some features, `max: 3` to cap how many features one run starts.
