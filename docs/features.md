# Features

Status: feature list agreed on 2026-11-10. Nothing here is built yet.

## What the system is

A standalone campus platform. It does not depend on the university's current campus or student-records system.

- A professor creates a campus, imports the students and shapes the campus with AI, starting from a template.
- Students get all their courses and all their grades in one place.
- Classes run on Zoom. Recordings and transcripts are published automatically.
- Presentations are synced inside the page during class.
- Secretaries are the administrators: they can see and do everything across all campuses.
- The university uses Zoom and the Microsoft suite, so the system works with both.

## Roles

| Role | What they do |
|---|---|
| Student | Follows courses, sees grades and attendance, joins classes, studies from recordings, transcripts and slides |
| Professor | Creates and shapes a campus, imports students, teaches, enters grades. Guest teachers are professors with access to one course |
| Secretary (administrator) | Everything a professor can do, on any campus. Also manages users and roles, checks and closes grades, follows students at risk, manages surveys |

Each person sees only what their role allows. A professor acts only on their own campuses and courses. A secretary can act on all of them.

## Zoom and Microsoft

| Tool | How the system uses it |
|---|---|
| Zoom | Meetings for each class, automatic recording, and Zoom's own transcript |
| Microsoft account | Sign-in with the university's Microsoft account, so there is no new password (later build) |
| Excel | Import students from an Excel file or CSV. Export grades and attendance to Excel |
| PowerPoint | Upload a PowerPoint file as the presentation that is synced during class |
| Outlook calendar | Classes appear in the student's and professor's calendar (later build) |

## First build: core features only

The first build has only the features below. Everything else in this document is for later builds and is marked **Later**.

1. **Simple sign-in:** email and password, with the three roles. No Microsoft sign-in, password reset or other account features yet.
2. **Create a campus** from a template.
3. **Shape the campus with AI:** propose, preview, accept or reject, with revision history.
4. **Import students** from Excel or CSV.
5. **Student home:** all courses on one page, and all grades in one place.
6. **Gradebook** with fast grade entry.
7. **Zoom integration:** a meeting per class and a "join today's class" button.
8. **Automatic recording and Zoom transcript** published to the class page.
9. **Synced presentations:** students' pages follow the professor's current slide.

Sign-in is kept simple in the first build, because a full sign-in brings no value to users by itself. Sign-in with a Microsoft account comes in a later build.

## Evidence labels

Each feature names the problem it solves and how solid the evidence is.

- **Strong:** stated clearly by the postgraduate experience lead at the kickoff.
- **Weak:** one garbled or second-hand remark in an interview.
- **Brief:** comes from the organizers, not from a user.
- **Team:** a product decision by the team, with no user evidence yet.

The source for all evidence is `misc/transcripciones-ideas-clave.md` in the parent folder.

---

## 1. Create and shape a campus

| Feature | Build | Problem it solves | Evidence |
|---|---|---|---|
| **Create a campus:** a professor names it and gets a working site in minutes | First | Professors depend on others to set up a course space | Team |
| **Templates:** starting points such as weekly topics, case-method seminar, workshop with assignments, thesis group | First | Many professors are not comfortable with technology and come only 1–2 h a week | Brief |
| **Shape it with AI:** the professor describes a change in plain words, the AI proposes it, the professor previews it and accepts or rejects it | First | Same as above; a professor can adapt the campus without learning an editor | Team (pattern taken from the demo app in `misc/campus`) |
| **Revision history:** every change to the campus is saved and can be restored | First | An AI change or a mistake must be easy to undo | Team |
| **Limits on the AI:** it changes layout, sections and content. It never changes grades, attendance or closed records | First | A missed compliance item sinks the project | Brief |
| **Import students:** upload an Excel file or CSV, or paste a list, check a preview that flags duplicates and errors, then confirm. Students get an invite link | First | Students register in one system and wait for staff to enrol them by hand in another, so courses are missing on day one | Strong |
| **Settings per campus:** grading scale, attendance rules and survey rules on top of shared defaults | Later | A change that helps one program can break another | Brief |

## 2. Courses and grades in one place

| Feature | Build | Problem it solves | Evidence |
|---|---|---|---|
| **Student home:** all courses on one page, one click to enter each | First | Information is split across two systems and Excel files | Strong |
| **"Next step" card:** the single most urgent thing for the student (class today, assignment due) | Later | Same; students have to look in several places to know what to do | Strong |
| **All grades in one place:** a student sees every grade across every course on one page | First | Same | Strong |
| **Professor home:** only today's tasks (take attendance, enter grades, review a summary) | Later | Professors with little time and little comfort with technology | Brief |
| **Gradebook:** as many graded items as needed, with the final grade calculated from them | First | Grade entry today allows only one grade plus the partial exam | Weak |
| **Fast grade entry:** a grid to type or paste into, or a file import | First | Entering grades is a chore | Brief |
| **Group grades:** one grade applied to every member of a group | Later | Each group member's grade is entered one by one | Weak |
| **Submit grades to the secretary:** inside the system, with a status (sent / checked / closed) | Later | Grades go to the secretary with an extra email | Weak |
| **Closing grades:** the secretary checks and closes a course's grades. After that, any correction is logged with who, when and why | Later | Official grade records need checking, closing and safe correction | Brief |
| **Export:** grades and attendance to Excel or CSV | Later | Staff are employed to retype data between systems | One lecturer's remark |
| **Works well on a phone** | Later | Postgraduate students are older and have other commitments | Brief |

Target for grade entry, from the organizers' example: a guest teacher enters 30 grades in under 5 minutes without help.

## 3. Live classes: Zoom, recordings, transcripts, synced presentations

| Feature | Build | Problem it solves | Evidence |
|---|---|---|---|
| **Zoom integration:** the professor connects their Zoom account once. Each class gets a meeting, and students see one "join today's class" button | First | Class times, rooms and video links live in three different places | Observed on the real pages |
| **Automatic recording:** when the class ends, the recording is published to that class's page. Status is visible: pending, available, transcript ready | First | Recordings take at least 72 h through a manual chain of ticket, link, Excel, video upload and secretary | Strong |
| **Transcript from Zoom:** Zoom's own transcript is attached to every class, searchable and downloadable as text | First | Videos can't be downloaded, so students ask for transcripts | Strong, second-hand |
| **AI class summary:** key points and tasks for the next class, generated from the transcript. The professor reviews it before students see it | Later | The lead asked for exactly this | Strong |
| **Synced presentations:** the professor uploads a PowerPoint file or builds slides in the campus. During class, each student's page follows the professor's current slide | First | Team decision, taken from the demo app | Team |
| **Transcript tied to slides:** a student can jump to what was said on any slide | Later | Makes transcripts usable for study | Team |
| **Notes per slide:** students write notes on each slide and export them all | Later | Team decision, taken from the demo app | Team |
| **Study mode:** after class, slides, recording, transcript, summary and the student's notes sit together on one page | Later | Students study from material spread across places | Team |
| **Attendance from the session:** taken from who joined. The professor can correct it or mark an absence as excused | Later | Taking attendance in virtual classes is cumbersome | Weak |
| **Attendance and grades in the same record** | Later | Attendance is kept in one system and grades in another | Strong |
| **Live polls (optional):** quick questions during class, with results on screen | Later | Team decision, taken from the demo app | Team |

Target for recordings: time from class end to recording visible, from a baseline of 72 h down to hours.

## 4. Secretary view

| Feature | Build | Problem it solves | Evidence |
|---|---|---|---|
| **All campuses:** one list of campuses, courses, professors and students, with search and filters | Later | Data is scattered and secretaries piece it together by hand | Strong |
| **Dropout alerts:** automatic signals from absences, missed work and no recent activity, with a suggested action per student | Later | Academic follow-up and dropout alerts are done by hand | Strong |
| **Pending grades:** which courses have grades sent, checked or still missing | Later | Grades arrive by email with no shared status | Weak |
| **Course surveys:** an end-of-course survey the student must answer before the next course opens, with the response rate shown | Later | Course surveys get few responses | Strong (the lead's own proposed fix) |
| **Search, filters and bulk actions** on every list | Later | Users complain about filters and the ways to view, select and enter things | Weak |

## 5. Other student features

| Feature | Build | Problem it solves | Evidence |
|---|---|---|---|
| **Certificates (unofficial):** attendance and completion certificates downloaded on demand, generated from the campus record and marked as not official | Later | Certificates have to be requested | Strong |
| **Study help:** "explain this" and practice questions on course material, with a daily limit per student. The professor approves practice questions first | Later | The lead asked for a tutor available at any hour | Strong, but the organizers named a chatbot as an example of output without value |
| **Exams that allow AI:** exam formats that assume AI is available, plus misuse signals in place of screen locking | Later | The exam lock-down browser is cumbersome and easy to bypass | Strong, but the goal is still vague |
| **"Report a problem" button:** on every page, attaches the page and context and goes to the right person | Later | Help-desk tickets arrive in the wrong category and all get forwarded to Systems | One interview |

Certificates are unofficial for now. Making them official would need the university's sign-off and may change later.

## 6. Rules for every feature

- **Cost:** the university's budget is zero. Every AI feature (shaping the campus, summaries, study help) has a quota per user and a usage log, so the cost per campus per month can be stated. Transcription uses Zoom's own transcript, which the Zoom licence already covers.
- **Records:** a removed student is suspended, never deleted. Every change to grades or attendance is logged with who, when and why.
- **Personal data:** importing students means holding personal data. Import only the fields needed (name, email, ID if required), in line with Ley 25.326.
- **Real rules, not invented ones:** grading scales, grade-closing rules and retention periods are settings confirmed by the program, not values written into the code.
- **Each feature needs a user, a problem, a baseline and a target**, or it gets cut. This is what the hackathon is judged on.

## Open questions

1. Does the university's Zoom licence have cloud recording and transcripts turned on, and in Spanish?
2. Will the university's IT team allow sign-in with Microsoft accounts for a new system? This matters only for the later build that adds sign-in.
