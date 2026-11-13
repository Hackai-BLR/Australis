export const meta = {
  name: 'australis-phase',
  description: 'Run one phase of docs/plan.md (kickoff, then build, review and fix each free feature on its own branch and pull request), or run one checkpoint (end-to-end tests and the demo story on a test stack). Nothing is merged.',
  whenToUse: 'Start or continue a phase of the Australis build plan. args: { phase: 0-5 } or { checkpoint: "A"-"F" }; with a phase also { only?: ["F10"], max?: number }',
  phases: [
    { title: 'Scout', detail: 'read docs/plan.md and GitHub: what is done, taken and free', model: 'sonnet' },
    { title: 'Kickoff', detail: 'publish phase/N: kernel additions, module skeletons, seams', model: 'sonnet' },
    { title: 'Test', detail: 'phase 1 and checkpoints: start a test stack, run the end-to-end tests and drive the app', model: 'sonnet' },
    { title: 'Implement', detail: 'one agent per feature or fix, in its own worktree; claims the branch, opens the PR', model: 'sonnet' },
    { title: 'Review', detail: 'read-only adversarial review of each PR', model: 'opus' },
    { title: 'Fix', detail: 'fix blocker and major findings, push to the same PR', model: 'sonnet' },
    { title: 'Integrate', detail: 'local-only merge of every branch of the phase plus full checks; nothing pushed', model: 'sonnet' },
  ],
}

// Model rule (user decision): Sonnet writes all code. Opus only reviews. Nothing here runs on Fable.
const CODER = 'sonnet'
const REVIEWER = 'opus'

const A = args || {}
const N = Number(A.phase)
const CP = A.checkpoint === undefined ? null : String(A.checkpoint).trim().toUpperCase()
if (CP === null && (A.phase === undefined || !(N >= 0 && N <= 5))) return { error: 'Pass args.phase as a number from 0 to 5, e.g. { phase: 2 }, or args.checkpoint as a letter, e.g. { checkpoint: "A" }.' }
const ONLY = Array.isArray(A.only) ? A.only.map(s => String(s).toUpperCase()) : null
const MAX = Number(A.max) > 0 ? Number(A.max) : Infinity

// ---------- shared prompt blocks ----------

const CONTRACT = `## Contract
- The plan is docs/plan.md on origin/main (or on origin/docs/plan while that pull request is open). Read the section for your item and the "Phases" rules before anything else. docs/features.md says why the feature exists. CLAUDE.md holds the architecture rules and the check commands; you already have it.
- Build only what your item says. Nothing from a later phase.
- Nothing calls an outside service: placeholder providers behind traits, with the "Simulado" badge wherever placeholder data shows.
- Production is off limits. Never contact the real server, campusia.tech, Cloudflare, Brevo or any real account, never run Ansible, OpenTofu or a deploy script against anything but a local container, and never read or use credentials (~/.config/campusia, a vault password, a real .env). Everything runs and is tested locally with fake data. If a task seems to need production, stop and report it.
- Product rules that a review will check: the AI never changes grades, attendance or closed records (no such operation may exist); a removed student is suspended, never deleted; every change to grades or attendance writes an audit row (who, when, why) in the same transaction; every AI call goes through ai::run with a per-user quota and a usage log; scales, thresholds and similar rules are settings, never constants, and unconfirmed ones are marked as such on screen; store only the personal data the feature needs; fake data only.
- Screen text is Spanish (es-AR). Code, comments, commits and docs are English.
- Stay inside the paths your item owns. Only a kickoff, or a phase-0 task whose "Owns" line names them, edits the frozen shared files. If you truly cannot finish without touching one, make the smallest change and report it as a deviation.
- Write a test for every behaviour your item's description promises.`

const GH = `GitHub CLI: \`gh\`. On Windows, if it is not on PATH, use "/c/Program Files/GitHub CLI/gh.exe" (Bash) or & "C:\\Program Files\\GitHub CLI\\gh.exe" (PowerShell).`

const GIT = (branch, start, merges, title) => `## Git and pull request procedure (follow exactly)
- You run in your own isolated git worktree. Work only inside your current directory. Never touch the main checkout or another worktree.
- ${GH}
- Start: \`git fetch origin --prune\`, then \`git checkout --detach origin/${start}\`${merges.length ? `, then ${merges.map(m => `\`git merge --no-edit origin/${m}\``).join(', ')}. If a merge conflicts, resolve it minimally and run the full checks before feature work` : ''}.
- Claim before you write code: if \`git ls-remote --heads origin ${branch}\` already shows the branch, someone else has it: stop and report pushed=false with that reason. Otherwise \`git commit --allow-empty -m "Start ${title}"\`, \`git push origin HEAD:refs/heads/${branch}\`, and \`gh pr create --draft --head ${branch} --base main --title "${title}" --body "In progress."\`.
- Commit in small logical commits. Commit messages and the PR body carry NO attribution: no Co-Authored-By, no "Generated with" line, no trailers.
- Publish with \`git push origin HEAD:refs/heads/${branch}\`. Never force-push.
- When the checks pass: replace the PR body (what it adds, how it was checked, what is a placeholder, known gaps, deviations) and run \`gh pr ready\`.
- NEVER merge a pull request. Never push to main or to any branch other than ${branch}. Never close or edit another pull request.
- Watch CI once: \`gh pr checks <number> --watch --interval 30\` (give up after about 15 minutes). Fix a failure your code caused and push again, at most 2 rounds. If CI is still queued, say so.`

const CHECKS = (key) => `## Checks (must pass before you mark the PR ready)
- Backend: the Docker command under "Backend checks" in CLAUDE.md, with the target volume australis-target-${key} and \`-j 4\` on clippy and test (other agents build at the same time). The first build is cold: allow 10 minutes and run it in the background if needed. While iterating run only your own test file, then the full command once.
- Frontend: in frontend/: npm ci, npm run format:check, npm run lint, npm run build, npm test.
- Report which checks you ran and their real result. Never claim a check you did not run.`

const IMPL_SCHEMA = { type: 'object', required: ['pushed', 'summary'], properties: {
  pushed: { type: 'boolean', description: 'true only if the branch is on origin with real work on it' },
  pr_number: { type: 'integer' }, pr_url: { type: 'string' },
  backend_checks: { type: 'string', description: 'passed | failed | not_run, with one line of detail' },
  frontend_checks: { type: 'string', description: 'passed | failed | not_run, with one line of detail' },
  ci: { type: 'string', description: 'passed | failed | pending | not_run' },
  summary: { type: 'string' },
  placeholders: { type: 'array', items: { type: 'string' } },
  deviations: { type: 'array', items: { type: 'string' }, description: 'edits outside owned paths or departures from the plan, each with its reason' },
  not_done: { type: 'array', items: { type: 'string' } },
} }
const FINDING = { type: 'object', required: ['severity', 'area', 'summary', 'failing_scenario'], properties: {
  severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
  area: { type: 'string', description: 'module the fault most likely lives in: auth, campus, roster, grades, classes, slides, app, core or infra' },
  file: { type: 'string' }, line: { type: 'integer' },
  summary: { type: 'string' },
  failing_scenario: { type: 'string', description: 'exact steps or inputs, the expected result and the actual result' },
} }
const FINDINGS_SCHEMA = { type: 'object', required: ['findings'], properties: {
  findings: { type: 'array', items: FINDING },
  covered: { type: 'string', description: 'what was actually exercised, and how (browser, HTTP, code reading)' },
  not_covered: { type: 'array', items: { type: 'string' } },
} }
const FIX_SCHEMA = { type: 'object', required: ['pushed', 'summary'], properties: {
  pushed: { type: 'boolean' }, fixed: { type: 'array', items: { type: 'string' } },
  skipped: { type: 'array', items: { type: 'string' }, description: 'findings not fixed, each with the reason' },
  backend_checks: { type: 'string' }, frontend_checks: { type: 'string' }, ci: { type: 'string' }, summary: { type: 'string' },
} }

// ---------- review and fix, shared by features, kickoffs and phase-1 fixes ----------

const REVIEW_FOCUS = `Look for, in order: access-control holes (every route against every role, non-members, suspended users, guest against professor, fields that must not reach students); broken product rules from the contract; data loss or races (transactions, concurrent requests, stale versions); promised behaviour with no test, or a test that does not test it; a real provider call or key where a placeholder was required; edits outside the owned paths that will collide with sibling branches; work from a later phase that crept in; anything that breaks the build, CI or the production nginx build. Trace the code; do not guess. Report only findings you can state as a concrete failing scenario. blocker = security, data loss, broken build or a broken product rule; major = a promised behaviour is wrong or untested; minor = everything else. At most 12 findings, most severe first. An empty list is a valid answer.`

async function reviewAndFix(item, impl) {
  const review = await agent(`You are an adversarial reviewer of one Australis pull request (${item.title}, branch ${item.branch}). READ-ONLY: do not edit, commit, push, comment on or merge anything, and do not check out branches in the main checkout. Use only: \`git fetch origin\`, \`git diff origin/main...origin/${item.branch}\`, \`git show origin/${item.branch}:<path>\`, \`git ls-tree -r --name-only origin/${item.branch}\`.

What it was meant to build: ${item.what}

${CONTRACT}

The implementer reported: ${JSON.stringify(impl)}

${REVIEW_FOCUS}`,
    { label: `review:${item.key}`, phase: 'Review', model: REVIEWER, schema: FINDINGS_SCHEMA })
  const all = (review && review.findings) || []
  const todo = all.filter(f => f.severity !== 'minor')
  if (!review) log(`${item.branch}: the review did not return; no fixes were made`)
  if (all.length - todo.length) log(`${item.branch}: ${all.length - todo.length} minor finding(s) reported, not fixed`)
  let fix = null
  if (todo.length) {
    fix = await agent(`You are fixing review findings on the Australis branch ${item.branch} (PR: ${impl.pr_url || 'find it with gh pr list --head ' + item.branch}).

What the branch builds: ${item.what}

${CONTRACT}

Findings to fix. Check each against the code first; if one is wrong, skip it and say why:
${JSON.stringify(todo, null, 1)}

For each real finding write a failing test first, then the fix.

## Git procedure
- You run in your own isolated worktree. Work only there. ${GH}
- \`git fetch origin\`, \`git checkout --detach origin/${item.branch}\`, fix, commit (no attribution trailers), run the checks, then \`git push origin HEAD:refs/heads/${item.branch}\`. Never force-push.
- NEVER merge a PR or push to another branch. Add one PR comment listing what was fixed. Watch CI once (\`gh pr checks <number> --watch --interval 30\`, about 15 minutes) and fix a failure this branch caused.

${CHECKS(item.key)}`,
      { label: `fix:${item.key}`, phase: 'Fix', model: CODER, isolation: 'worktree', schema: FIX_SCHEMA })
    log(`${item.branch}: ${fix ? `${(fix.fixed || []).length} fixed, ${(fix.skipped || []).length} skipped` : 'the fix agent did not return'}`)
  }
  return { findings: all, fix }
}

// ---------- test stack and fixes, shared by phase 1 and checkpoints ----------

const STACK_SCHEMA = { type: 'object', required: ['up'], properties: {
  up: { type: 'boolean' }, frontend_url: { type: 'string' }, api_url: { type: 'string' },
  built_from: { type: 'string', description: 'commit and what was merged into it' },
  accounts: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } } } },
  notes: { type: 'string', description: 'how to sign in, how to read sign-in codes or mails, anything a tester must know' },
} }
async function startStack(what) {
  const stack = await agent(`Start a throwaway test copy of the product for other agents to test. You run in your own worktree; work only there.

- \`git fetch origin\`, \`git checkout --detach origin/main\`. ${what}
- Write a .env in the worktree with fake seed accounts (SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_DEMO=true) and APP_BASE_URL set to the test frontend URL. Fake data only, on a fresh database.
- It must NOT touch the normal stack or its data: use the Compose project name australis-test (\`docker compose -p australis-test ...\`) and a small override file that maps other host ports (frontend 3100, backend 8180). Remove a leftover australis-test project first (\`docker compose -p australis-test down -v\`) so the database is fresh. Never run \`down -v\` on, or remove volumes of, the project "australis".
- If what you were asked to run includes the Campus IA core (nucleo), start it the way its contracts and handoffs describe for development: mails written to a file (PROVEEDOR_EMAIL=archivo), Cloudflare's public Turnstile test keys, DOMINIO_BASE=localhost, and the fake model unless a real one is asked for. No real secret is used or needed.
- If Docker is not running, start Docker Desktop and wait for the daemon (up to 5 minutes). Then build and start in the background, and wait until the health check answers.
- Sign in once as each role to confirm the accounts work.
Report the URLs, the accounts, how a tester signs in, and the commit you built. Leave the stack running.`,
    { label: 'test:stack', phase: 'Test', model: CODER, isolation: 'worktree', schema: STACK_SCHEMA })
  if (stack && stack.up) log(`Test stack up at ${stack.frontend_url} (built from ${stack.built_from})`)
  return stack
}

// One fix branch per module, so two fixes never edit the same files.
async function fixFindings(serious, stack, prefix, source) {
  const byArea = {}
  for (const f of serious) (byArea[f.area || 'app'] = byArea[f.area || 'app'] || []).push(f)
  return pipeline(Object.keys(byArea),
    async (area) => {
      const key = `${prefix}-${area}`
      const item = { key, branch: `fix/${key}`, title: `Fixes from ${source}: ${area}`, what: `Fixes for the findings of ${source} in the ${area} area: ${JSON.stringify(byArea[area])}` }
      const impl = await agent(`You are fixing findings from ${source} of Australis, all in the "${area}" area, on the branch ${item.branch}.

Findings (each was seen on the running app at ${stack.frontend_url}; reproduce each one first, against that app or in a test, and if one does not reproduce, skip it and say why):
${JSON.stringify(byArea[area], null, 1)}

For each real finding write a failing test first, then the smallest fix. Add no features. A fix may touch a frozen shared file only if the fault is there; report it as a deviation.

${CONTRACT}

${GIT(item.branch, 'main', [], item.title)}

${CHECKS(key)}`,
        { label: `fix:${key}`, phase: 'Implement', model: CODER, isolation: 'worktree', schema: IMPL_SCHEMA })
      if (!impl || !impl.pushed) { log(`${item.branch}: no branch was published`); return { area, ok: false, impl } }
      const rf = await reviewAndFix(item, impl)
      return { area, branch: item.branch, ok: true, impl, ...rf }
    })
}

// ---------- Checkpoint mode ----------

if (CP !== null) {
  phase('Scout')
  const cp = await agent(`Read-only scout for checkpoint ${CP} of the Australis build plan. Change nothing.

1. \`git fetch origin --prune\`. Read the "Checkpoints" section of docs/plan.md with \`git show origin/main:docs/plan.md\` (if the plan is not on main yet, try origin/merge/campusai, then origin/docs/plan). Report the ref you used.
2. Copy verbatim, for checkpoint ${CP}: its title, its "Runs on" cell, every numbered step of its demo story, and every item of "Must be refused". Copy the numbered list "A checkpoint passes when" as well.
3. For every id under "Needs" (expand ranges such as "F10 to F17"; an earlier checkpoint counts as done if the tag checkpoint-<letter> exists on origin), say whether it is done: its pull request is merged, or the plan itself states it is done. Use \`gh pr list --state all --limit 200 --json number,title,state,headRefName,mergedAt\` and \`git ls-remote --tags origin\`. ${GH}
4. List the end-to-end test folders that exist on that ref for this checkpoint and every earlier one (pruebas/australis/checkpoint-*), and say how the folder's own files say to run them.`,
    { label: `scout:checkpoint-${CP}`, phase: 'Scout', model: CODER, effort: 'low', schema: { type: 'object', required: ['title', 'steps', 'needs'], properties: {
      plan_ref: { type: 'string' }, title: { type: 'string' }, runs_on: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } }, refused: { type: 'array', items: { type: 'string' } },
      passes_when: { type: 'string' },
      needs: { type: 'array', items: { type: 'object', required: ['id', 'done'], properties: { id: { type: 'string' }, done: { type: 'boolean' }, detail: { type: 'string' } } } },
      suites: { type: 'array', items: { type: 'string' }, description: 'existing end-to-end test folders, this checkpoint and earlier' },
      how_to_run_suites: { type: 'string' },
    } } })
  if (!cp) return { error: 'The scout did not return; nothing was tested.' }
  const waiting = cp.needs.filter(n => !n.done).map(n => n.id)
  if (waiting.length && !A.force) {
    log(`Checkpoint ${CP} (${cp.title}) cannot pass yet. Not merged: ${waiting.join(', ')}. Pass force: true to test what is on main anyway.`)
    return { checkpoint: CP, passes: false, waiting_for: waiting, tested: false }
  }
  if (waiting.length) log(`Checkpoint ${CP}: testing main although these are not merged: ${waiting.join(', ')}. It cannot pass in this run.`)

  phase('Test')
  const stack = await startStack(`This is for checkpoint ${CP} (${cp.title}). The plan says it runs on: ${cp.runs_on || 'a local test stack'}. Always use a LOCAL test stack here, never the live site: if that line names campusia.tech, start the Campus IA core and Australis together locally instead.${A.real_model ? ' The person running this asked for the real model: use it only if its credential is already configured on this machine outside the repo; otherwise use the fake model and say so.' : ''}`)
  if (!stack || !stack.up) return { checkpoint: CP, passes: false, scout: cp, stack, error: 'The test stack did not start; nothing was tested.' }
  const APP = `App: ${stack.frontend_url} (API ${stack.api_url}). Accounts: ${JSON.stringify(stack.accounts)}. Notes from setup: ${stack.notes || 'none'}.`
  const BROWSER = `Drive the screens in a real browser if you have a browser tool (find one with ToolSearch). If you have none, exercise the same flows through the HTTP API with a cookie jar and read the frontend code for the screen logic, and say plainly in "covered" that the screens were not driven.`
  const WALK_SCHEMA = { type: 'object', required: ['steps', 'findings'], properties: {
    steps: { type: 'array', items: { type: 'object', required: ['n', 'ok'], properties: { n: { type: 'integer' }, ok: { type: 'boolean' }, note: { type: 'string' } } } },
    findings: { type: 'array', items: FINDING }, covered: { type: 'string' }, minutes: { type: 'number', description: 'rough time the story took, leaving out your own thinking' },
  } }
  const walker = (run) => () => agent(`You are rehearsing a product demo of Australis as the presenter would give it, run ${run} of 2. Do NOT edit any repo file and do not open pull requests.

${APP}

The demo story of checkpoint ${CP} (${cp.title}). Do every step in order, as the role the step names, exactly as an audience would see it. Do not skip a step, and do not work around a problem: if a step cannot be done as written, mark it not ok, say what happened, and go on to the next step if you can.
${cp.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

- ${BROWSER}
- Use names starting "demo-${run}" for anything you create, so the other rehearsal on the same app is not disturbed.
- Exceptions the plan records as accepted (for example a "Status" or "Decision" note in the plan) are not findings. Read the plan's notes for the phases this checkpoint closes before reporting.
- Also note anything an audience would notice: a raw error, English text on a screen, a missing "Simulado" badge on simulated data, a dead link, a long wait.
- Report each step, and a finding for every failed step and every such problem, with exact steps to reproduce. blocker = the story cannot continue, data is lost, or a security hole; major = a step fails or shows something wrong; minor = cosmetic.`,
    { label: `test:demo-${run}`, phase: 'Test', model: CODER, schema: WALK_SCHEMA })

  const [suite, walk1, walk2, attack] = await parallel([
    () => agent(`Run the automated end-to-end tests for checkpoint ${CP} of Australis against a running test stack. Do NOT edit any repo file. You run in your own worktree at origin/main.

${APP}

Test folders the scout found (this checkpoint and earlier ones): ${JSON.stringify(cp.suites || [])}. How they say to run: ${cp.how_to_run_suites || 'not stated; read the folder'}.
Also run backend/crates/server/tests/demo_flow.rs with the backend check image (see "Backend checks" in CLAUDE.md; run only that test file, target volume australis-target-checkpoint).
If there is no end-to-end folder for this checkpoint, say so in "missing": that alone means the checkpoint cannot pass. Install test dependencies only inside the test folder. The stack above is in use by other agents at the same time: never run pila.sh bajar, never stop, remove or rebuild containers, images, networks or volumes you did not start yourself, and never remove a stack labelled checkpoint-b that is not yours. If the suite needs its own stack, let its script start one under its own prefix and leave cleanup of the assigned stack to the person. Report totals and one finding per failing test (name, what it expected, what happened); do not fix anything.`,
      { label: 'test:e2e-suite', phase: 'Test', model: CODER, isolation: 'worktree', schema: { type: 'object', required: ['ran', 'passed', 'failed'], properties: {
        ran: { type: 'boolean' }, passed: { type: 'integer' }, failed: { type: 'integer' },
        missing: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: FINDING }, detail: { type: 'string' } } } }),
    walker(1), walker(2),
    () => agent(`You are attacking the running Australis app to check that what must be refused is refused. Do NOT edit any repo file and do not open pull requests.

${APP}

For checkpoint ${CP} (${cp.title}) each of these must be refused, through the screens AND directly through the API:
${(cp.refused || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '(the plan lists none; test access by role on every screen and route the demo story touches)'}

Also try, on every route the demo story of this checkpoint uses: no session, a student of another campus, a guest teacher on manage-only actions, a suspended member, and ids that belong to another campus. Create your own data with names starting "attack-".
Report only what you reproduced: the exact request or steps, what should have happened and what did. blocker = anything refused in the list above that went through; major = other wrong access; minor = a refusal with a confusing message. An empty list is a valid answer.`,
      { label: 'test:attack', phase: 'Test', model: CODER, schema: FINDINGS_SCHEMA }),
  ])

  const raw = [suite, walk1, walk2, attack].filter(Boolean).flatMap(r => r.findings || [])
  const serious = raw.filter(f => f.severity !== 'minor')
  const walkOk = (w) => !!w && w.steps.length >= cp.steps.length && w.steps.every(s => s.ok)
  const checks = {
    needs_merged: waiting.length === 0,
    e2e_suite_exists: !!suite && suite.ran && !(suite.missing || []).length,
    e2e_suite_green: !!suite && suite.ran && suite.failed === 0,
    demo_run_1: walkOk(walk1),
    demo_run_2: walkOk(walk2),
    refusals_tested: !!attack,
    no_blocker_or_major: serious.length === 0,
  }
  const passes = Object.values(checks).every(Boolean)
  log(`Checkpoint ${CP} (${cp.title}): ${passes ? 'PASSES the automated part' : 'does NOT pass'} | ${Object.entries(checks).map(([k, v]) => `${k}=${v ? 'yes' : 'NO'}`).join(', ')}`)
  log(`${raw.length} finding(s): ${serious.length} blocker or major, ${raw.length - serious.length} minor (minor ones are reported, not fixed)`)

  const fixes = serious.length ? await fixFindings(serious, stack, `c${CP.toLowerCase()}`, `checkpoint ${CP}`) : []
  return { checkpoint: CP, title: cp.title, passes, checks, scout: cp, stack, suite, demo_runs: [walk1, walk2], attack,
    minor: raw.filter(f => f.severity === 'minor'), fixes,
    left_for_a_person: [
      serious.length ? 'Read and merge the fix pull requests, then run this checkpoint again: it passes only on a clean run' : null,
      passes ? `Tag main: git tag checkpoint-${CP.toLowerCase()} origin/main && git push origin checkpoint-${CP.toLowerCase()}` : null,
      /campusia\.tech/.test(cp.runs_on || '') ? 'This checkpoint is live: after the tag, check the deploy and the health check on campusia.tech, and try going back to the previous checkpoint tag once. This run tested a local stack only' : null,
      `The test stack is still running (Compose project australis-test, ${stack.frontend_url}); stop it with: docker compose -p australis-test down`,
    ].filter(Boolean) }
}

// ---------- Scout ----------

phase('Scout')
const SCOUT_SCHEMA = { type: 'object', required: ['plan_ref', 'phase_title', 'kickoff', 'items'], properties: {
  plan_ref: { type: 'string', description: 'git ref the plan was read from, e.g. origin/main' },
  phase_title: { type: 'string' },
  earlier_not_merged: { type: 'array', items: { type: 'string' }, description: 'ids from earlier phases, and earlier kickoffs, that are not merged into main' },
  kickoff: { type: 'object', required: ['status'], properties: {
    status: { type: 'string', enum: ['none', 'missing', 'published', 'merged'], description: 'none = this phase has no kickoff; missing = phase/N is not on origin; published = on origin, not merged; merged = in main' },
    branch: { type: 'string' }, what: { type: 'string', description: 'the kickoff bullet list from the plan, verbatim' } } },
  items: { type: 'array', items: { type: 'object', required: ['id', 'title', 'slug', 'status', 'deps'], properties: {
    id: { type: 'string', description: 'e.g. F10 or T2' }, title: { type: 'string' },
    slug: { type: 'string', description: 'kebab-case, for the branch name' },
    what: { type: 'string', description: 'the plan text for this item (table row and description), verbatim' },
    owns: { type: 'string' },
    status: { type: 'string', enum: ['free', 'taken', 'done', 'blocked'] },
    taken_by: { type: 'string' }, branch: { type: 'string', description: 'existing origin branch for this item, if any' },
    deps: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: {
      id: { type: 'string' }, status: { type: 'string', enum: ['done', 'taken', 'free'] },
      branch: { type: 'string', description: 'origin branch of a taken dependency' } } },
      description: 'feature ids only; leave out "First build" and kickoffs' } } } },
  open_pr_19: { type: 'boolean', description: 'true if pull request #19 (fix/slides-follow) is still open' },
} }
const scout = await agent(`Read-only scout for phase ${N} of the Australis build plan. Change nothing: no edits, commits, pushes or PR changes.

1. \`git fetch origin --prune\`. Read docs/plan.md with \`git show origin/main:docs/plan.md\`; if it is not on main yet, use \`git show origin/docs/plan:docs/plan.md\`. Report which ref you used.
2. List what exists: \`git branch -r\`, and \`gh pr list --state all --limit 200 --json number,title,state,isDraft,headRefName,author,mergedAt\`. ${GH}
3. For every item of phase ${N} (features F.., tasks T.. or M..), copy its plan text verbatim and set its status by the plan's own rule: done = its pull request is merged; taken = a branch feat/<id in lower case>-... (any slug) exists on origin and is not merged; blocked = the plan marks it blocked, or says a person does it; free otherwise. For each feature dependency give its status the same way, and the branch if it is taken.
4. Kickoff of phase ${N}: none if the plan lists none; otherwise missing, published or merged, judged from origin/phase/${N} and its pull request. Copy its bullet list verbatim.
5. List every feature and kickoff of EARLIER phases that is not merged into main.
6. Say whether pull request #19 is still open.`,
  { label: `scout:phase-${N}`, phase: 'Scout', model: CODER, effort: 'low', schema: SCOUT_SCHEMA })
if (!scout) return { error: 'The scout did not return; nothing was started.' }
log(`Phase ${N} (${scout.phase_title}), plan read from ${scout.plan_ref}: ${scout.items.map(i => `${i.id} ${i.status}`).join(', ')}`)
if ((scout.earlier_not_merged || []).length) log(`Not merged from earlier phases: ${scout.earlier_not_merged.join(', ')}. Features that need them will merge their branches or be skipped.`)

// ---------- Phase 1: test and stabilise ----------

if (N === 1) {
  phase('Test')
  const stack = await startStack(`Build from origin/main.${scout.open_pr_19 ? ' Pull request #19 is still open: also \`git merge --no-edit origin/fix/slides-follow\` locally so the test covers it. Do not push that merge.' : ''}`)
  if (!stack || !stack.up) return { scout, stack, error: 'The test stack did not start; no testing was done.' }

  const AREAS = [
    ['sign-in', 'Feature 1: sign-in, sign-out, wrong password, invite acceptance, the secretary user screen (create, suspend with reason, reactivate), a suspended user losing an open session'],
    ['campus', 'Feature 2: create a campus from each template, the campus page for teacher and student, revision history and restore, a stale save'],
    ['ai-shaping', 'Feature 3: propose a change, preview, accept, reject, history, the quota counter running out, a request to change a grade being refused, the "Simulado" badge'],
    ['roster', 'Feature 4: import from .xlsx, from CSV (; and , separators, accents) and from pasted text; every preview flag; confirm; invite links; suspend and reactivate with a reason; adding a guest teacher'],
    ['student-home', 'Feature 5: the home page for each role, course cards, the join-class button only when there is a class today, the entry to all grades'],
    ['gradebook', 'Feature 6: add items, type and paste 30 grades, decimal commas, out-of-scale values, overwriting needing a reason, the audit list, the student grades page, the "unconfirmed" note on the grading rules'],
    ['classes', 'Feature 7: connect Zoom (simulated), create a class, a pasted meeting link, the join and start buttons by role, today across campuses around midnight'],
    ['recordings', 'Feature 8: end a class, the status moving to transcript ready, transcript search and download as text and VTT, the elapsed time against the 72 h baseline'],
    ['slides', 'Feature 9: upload a PDF, a .pptx being refused with a clear message, present, and a student in a second session following the page, browsing away, coming back to the live page and following again, and "Volver al vivo". This is the area pull request #19 changed: test it hardest'],
    ['access', 'Across every area: each role against each screen and API route. A professor on another professor\'s campus, a guest teacher (can teach, cannot manage), a student of another campus, a suspended student, a signed-out request. Check that the teacher-only start link and members\' emails never reach a student'],
    ['screens', 'Across every area: all screen text is Spanish, placeholder data carries the "Simulado" badge, empty, loading and error states exist, no dead links, no raw error text or JSON shown to a user, and the browser console has no errors'],
  ]
  const tests = await parallel(AREAS.map(([key, what]) => () => agent(`You are testing the running Australis app as a real user would. Do NOT edit any repo file and do not open pull requests: your only output is findings.

App: ${stack.frontend_url} (API ${stack.api_url}). Accounts: ${JSON.stringify(stack.accounts)}. Notes from setup: ${stack.notes || 'none'}.

Your area: ${what}

- Drive the screens in a real browser if you have a browser tool (find one with ToolSearch). If you have none, exercise the same flows through the HTTP API with a cookie jar and read the frontend code for the screen logic, and say plainly in "covered" that the screens were not driven.
- Create your own campus and data with a name starting "test-${key}" so you do not disturb other testers on the same app.
- Compare what you see with docs/features.md (first-build features) and the rules in CLAUDE.md.
- Report only what you reproduced, with exact steps, expected and actual result. blocker = data loss, a security hole, or a first-build feature that cannot be used; major = a promised behaviour is wrong; minor = cosmetic. Name the module the fault most likely lives in. An empty list is a valid answer.`,
    { label: `test:${key}`, phase: 'Test', model: CODER, schema: FINDINGS_SCHEMA })))
  const raw = tests.filter(Boolean).flatMap(t => t.findings || [])
  const missing = AREAS.filter((_, i) => !tests[i]).map(a => a[0])
  if (missing.length) log(`Testers that did not return (areas NOT covered): ${missing.join(', ')}`)
  const serious = raw.filter(f => f.severity !== 'minor')
  log(`${raw.length} finding(s): ${serious.length} blocker or major, ${raw.length - serious.length} minor (minor ones are reported, not fixed)`)

  const fixes = await fixFindings(serious, stack, 'p1', 'the phase-1 test pass')
  return { phase: 1, scout, stack, tests: AREAS.map((a, i) => ({ area: a[0], result: tests[i] })), minor: raw.filter(f => f.severity === 'minor'), fixes,
    left_for_a_person: ['Merge pull request #19 and the fix pull requests after reading them', 'Remove leftover worktrees under .claude/worktrees/ (git worktree remove)', `The test stack is still running (Compose project australis-test, ${stack.frontend_url}); stop it with: docker compose -p australis-test down`] }
}

// ---------- Phases 2 to 5: kickoff, then one pipeline per feature ----------

const startRef = scout.kickoff.status === 'merged' || scout.kickoff.status === 'none' ? 'main' : `phase/${N}`
if (scout.kickoff.status === 'missing') {
  phase('Kickoff')
  const kitem = { key: `phase-${N}`, branch: `phase/${N}`, title: `Phase ${N} kickoff`, what: `The kickoff of phase ${N}: ${scout.kickoff.what}` }
  const kimpl = await agent(`You are publishing the kickoff of phase ${N} of the Australis build plan on the branch phase/${N}. Every feature of the phase will start from your branch, in parallel, so your job is to make them independent of each other.

The plan says the kickoff holds:
${scout.kickoff.what}

Read the whole phase ${N} section of docs/plan.md (ref ${scout.plan_ref}) and each feature's "Owns" paths first. Then:
- Make the kernel additions listed, with tests in tests/core.rs or a new kernel test file. Kernel migrations use the core range (next free number from 0002).
- Create each new module as a skeleton exactly as CLAUDE.md "Adding a further backend module" describes, with its FULL [dependencies] so no feature edits a Cargo.toml, and the matching frontend module folder wired into src/app/routes.tsx. Commit Cargo.lock.
- For every "seam", add an empty submodule whose router is already merged into its crate's router, and a placeholder component already mounted where the feature will show, so the feature only fills in its own folder.
- You are the one package allowed to edit the frozen shared files. Keep each change the smallest that lets the features proceed. Do not build any feature.
- Update CLAUDE.md where a rule changed (new kernel API, new modules, the per-feature migration ranges) and set this phase's status to "Open" in docs/plan.md. Keep both short.

${CONTRACT}

${GIT(`phase/${N}`, 'main', [], `Phase ${N} kickoff`)}

${CHECKS(`phase-${N}`)}`,
    { label: `kickoff:phase-${N}`, phase: 'Kickoff', model: CODER, effort: 'high', isolation: 'worktree', schema: IMPL_SCHEMA })
  if (!kimpl || !kimpl.pushed) return { phase: N, scout, kickoff: kimpl, error: `The kickoff branch phase/${N} was not published; no feature was started.` }
  log(`phase/${N} published: ${kimpl.pr_url || '(no PR url reported)'}`)
  // Features build on the kickoff, so its review and fixes finish before they start.
  const krf = await reviewAndFix(kitem, kimpl)
  scout.kickoff.result = { impl: kimpl, ...krf }
}

const wanted = scout.items.filter(i => !ONLY || ONLY.includes(i.id.toUpperCase()))
const free = wanted.filter(i => i.status === 'free')
for (const i of wanted.filter(i => i.status !== 'free')) log(`${i.id} ${i.title}: ${i.status}${i.taken_by ? ` (by ${i.taken_by})` : ''}, not started`)
const run = free.slice(0, MAX)
if (free.length > run.length) log(`max=${MAX}: not started this run: ${free.slice(MAX).map(i => i.id).join(', ')}`)

const done = {}
async function runFeature(f) {
  const num = f.id.replace(/\D/g, '')
  const key = f.id.toLowerCase()
  const isFeature = /^F\d+$/i.test(f.id)
  const branch = `feat/${key}-${f.slug}`
  const item = { key, branch, title: `${f.id} ${f.title}`, what: `${f.what || f.title}${f.owns ? `\nOwns: ${f.owns}` : ''}` }

  // Dependencies: merged ones are already in the start ref; unmerged ones are merged in by branch.
  const merges = []
  for (const d of f.deps || []) {
    if (d.status === 'done') continue
    if (done[d.id]) { const r = await done[d.id]; if (r && r.ok) { merges.push(r.branch); continue } }
    else if (d.status === 'taken' && d.branch) { merges.push(d.branch.replace(/^origin\//, '')); continue }
    log(`${f.id}: skipped, dependency ${d.id} has no published branch`)
    return { id: f.id, ok: false, skipped: true, reason: `dependency ${d.id} not available` }
  }

  const impl = await agent(`You are implementing one feature of the Australis build plan on its own branch (${branch}) and opening its pull request.

FEATURE ${f.id}: ${f.title}
${item.what}
${isFeature ? `Migration range for this feature: ${600 + (Number(num) - 10) * 10} to ${609 + (Number(num) - 10) * 10} (four digits, zero-padded).` : 'This task joins the Australis and Campus IA trees. Each tree keeps its own rules: CONVENCIONES.md for the Campus IA folders (Spanish, no code comments, pnpm, a new handoff file per piece of work), CLAUDE.md for backend/ and frontend/. Read the contracts in contratos/ that your task touches before changing either side, and run the tests of every tree you change.'}

Read the phase ${N} section of docs/plan.md (ref ${scout.plan_ref}) for the kickoff your work builds on, and read the code you start from before writing anything: it is the real contract.${merges.length ? `\nYou build on unmerged work (${merges.join(', ')}); say so in the PR body.` : ''}

${CONTRACT}

${GIT(branch, startRef, merges, item.title)}

${CHECKS(key)}

Finish only when the PR is ready and the checks pass, or when you hit a blocker you cannot work past. In that case push what is sound, leave the PR as a draft, and say exactly what is missing.`,
    { label: `build:${f.id}`, phase: 'Implement', model: CODER, isolation: 'worktree', schema: IMPL_SCHEMA })
  if (!impl || !impl.pushed) { log(`${f.id}: no branch was published${impl ? `: ${impl.summary}` : ''}`); return { id: f.id, branch, ok: false, impl } }
  log(`${f.id}: ${impl.pr_url || '(no PR url)'} | backend ${impl.backend_checks || '?'} | frontend ${impl.frontend_checks || '?'}`)
  const rf = await reviewAndFix(item, impl)
  return { id: f.id, branch, ok: true, impl, ...rf }
}
for (const f of run) done[f.id] = runFeature(f)
const results = await Promise.all(run.map(f => done[f.id]))

phase('Integrate')
const okBranches = results.filter(r => r && r.ok).map(r => r.branch)
const integration = okBranches.length > 1 ? await agent(`Local-only integration check for phase ${N} of Australis. You run in your own worktree; work only there. NOTHING is pushed and no PR is opened, merged, commented on or changed: your only output is the report.

\`git fetch origin\`; \`git checkout --detach origin/${startRef}\`; then merge these branches one at a time with \`git merge --no-edit origin/<branch>\`: ${okBranches.join(', ')}. If a merge conflicts, record the files and the cause, resolve it the obvious way to keep going (or abort that merge and skip the branch), and continue. Then run the full checks on the combined tree.

${CHECKS(`phase-${N}-integration`)}

Report in markdown: which branches merged cleanly; each conflict (files, cause, how a person should resolve it and in which PR); the result of every check, with failing test names and the branch most likely responsible; migration-number or route collisions between branches; and a recommended merge order for the open pull requests.`,
  { label: `integrate:phase-${N}`, phase: 'Integrate', model: CODER, isolation: 'worktree' }) : null

return { phase: N, scout, start_ref: startRef, results, integration,
  left_for_a_person: [scout.kickoff.status === 'merged' || scout.kickoff.status === 'none' ? null : `Merge the phase/${N} kickoff pull request first`, 'Read and merge the feature pull requests in the recommended order', 'Nothing was merged by this run'].filter(Boolean) }
