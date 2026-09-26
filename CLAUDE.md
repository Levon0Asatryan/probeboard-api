# probeboard-api — working conventions

Read before adding files. `AGENTS.md` holds the review rules (what to flag on a
pull request); this holds the conventions to follow while writing.

## How work is done

Work is split across chats. One **orchestrator** session tracks the project
and validates; **worker** chats implement one milestone or one plan step from a
handoff prompt (`docs/handoff-template.md`). `docs/tracker.md` is the status of
record — read it first. Levon approves plans and merges; no chat merges.

### Cost discipline — the loop must stay cheap

Added 2026-09-19, after one regex plus a maintenance script cost twelve
commits, four review rounds and two days. Rigour is kept where it caught real
defects; the loop around it is not.

- **Two review rounds per PR, then stop.** Round one and round two: fix what
  is real. After that, a finding is either **fix-now** or a tracker follow-up.
  Fix-now means only: a security hole, data loss, a wrong result, or a broken
  build. Everything else gets a one-line reply saying it is deferred, and a
  follow-up row. Answer every thread either way.
- **The cap limits what is fixed, not whether the head is reviewed.** The last
  fix push still gets one confirmation round on the head SHA, asked for
  explicitly and scoped to the commits since the previous round. Only the
  fix-now categories are acted on; anything else is a follow-up row, so the
  round cannot restart the loop. Without it a PR merges with its most recent —
  and often its subtlest — commits seen by nobody but their author: #23's open
  redirect shipped in exactly that position, and #61 sat there with the
  shutdown deadline and the loader's statement budget unreviewed until the
  round was asked for.
- **Push back on a wrong finding, with evidence, instead of implementing it.**
  Check the premise first — a review that cites a limit, a default or a
  standard is asserting a fact, and facts are checkable. Two of Codex's
  findings in M2 and M3 were wrong on their own numbers.
- **Build for this thesis, not for a fleet.** There is no deployment, no
  production data and no operator. Work that only pays off at a scale this
  system will never see — byte-budgeted batches, operator recovery tooling,
  migration paths for data nobody has — is out of scope by default. Say so in
  the plan and move on. Correctness, security and the evidence for both stay.
- **Two or three PRs per milestone**, not five to seven. One plan PR, then
  implementation in coherent chunks. A PR that only makes sense alongside the
  next one should have been one PR.
- **The orchestrator validates at milestone end**, not per PR. Per PR it
  checks only: CI green on the head SHA, Codex reviewed that SHA, threads
  answered. Deep validation happens once, against the finished milestone.

### The review loop — where the time actually goes

Measured on #49 (2026-09-20): the loop ran 89 minutes over nine pushes and
eight Codex rounds. Fixing took two to four minutes a round. **Codex's own
latency, five to seven minutes a round, was 48 of the 89 minutes.** Each round
carried about one defect. The cost is the number of rounds, not the work inside
one — so the rules below move finding earlier and make each round carry more.

1. **The first push is a finished PR, not a draft.** Phase 3 — the full suite,
   the guard-removal proofs, the real `docker compose` run — happens **before**
   the first push of code, not after it. Codex reviewing work the author has
   not yet checked converts the author's own defects into review rounds at six
   minutes each. Push once the PR is one you would merge.
2. **One push per round, carrying every finding of that round.** Read all of
   Codex's comments, decide on all of them, fix all of them, push once. A push
   per finding is what turns four defects into four rounds and twenty-four
   minutes of waiting.
3. **Every fix push re-runs the full automated gate, and a review of the fix's
   blast radius.** A review fix breaks other things — this has happened
   repeatedly. So after fixing, before pushing: `npm run verify`, the full unit
   and integration suites, and the real run again if the fix touched an HTTP
   surface, a migration, the database or concurrency. Then re-read the fix
   against what it could have broken: the guards it touches, re-proved by
   removal, and the callers of anything whose signature, timing or error
   behaviour changed. A **whole**-diff re-read is only required when a fix
   reaches outside the module the finding named — that is the case where the
   blast radius is not knowable from the fix alone.
4. **A plan PR gets one Codex round, then it merges.** A design document
   cannot be made correct by review — it has no tests, and each fix opens new
   surface. Fix only what changes the design; everything else becomes scope in
   the implementation PR. See `AGENTS.md`, "Reviewing a design document".
5. **Resolve a thread when its fix is pushed and verified.** Reply saying what
   changed and in which commit, then resolve it. A thread stays open only when
   it is a pushback awaiting Levon's judgement, or a deferral with a tracker
   row. "Answered" is not the same as "resolved": an open thread should mean
   something is still owed.

### Every task runs four phases — not optional

Applies to every chat, with or without a handoff prompt. The report
(`docs/handoff-template.md`, part 2) has a section for each.

1. **Investigation**, before any plan or code. Requirements and stories in
   scope, the code on `main` it touches, how comparable systems solve it
   (`../references/`), and published vulnerabilities and bug reports in that
   area — each becomes a test or a decision. Findings go in the plan, with
   sources.
2. **Implementation**, only after the plan is approved.
3. **Revalidation**, after implementing, scaled to what the PR touches. Always:
   walk the plan against the code and close every gap, and re-prove every
   guard by removal on the final code. The fresh clone (`npm ci`,
   `npm run build`, `npm run verify`, `npm run test:int`) and the real
   `docker compose` run with `psql` checks are required for an HTTP surface,
   a migration, a database change or the last PR of a milestone — for a PR
   that only changes pure logic, CI plus the local suites are enough. Say in
   the report which applied. Clone from the local repository
   (`git clone <checkout> <dir> && git -C <dir> checkout <branch>`), never
   by pushing first to have something to clone: a push is where the review
   gate runs, and `--no-verify` to get a clone source skips it for
   convenience.
4. **Re-review**, after revalidation. Review the whole diff yourself as a
   hostile reviewer against `AGENTS.md`, and separately **walk the plan's
   normative sentences** — every "must", "is anchored on", "is excluded from"
   — and point at the line that implements each. Reading the diff for smells
   finds lifetime and resource bugs; it does not find a measurement that
   deviates from a sentence already written in the plan. On #49 both the
   `dns_ms` and `total_ms` defects were that kind, and Codex found them. Then wait for Codex on the head SHA
   (see "Before calling it done", step 4), and answer every thread. A fix push
   repeats the checks it affects — but only for two rounds, after which the
   fix-now rule in "Cost discipline" decides what is fixed and what is
   deferred to a follow-up.

### Before writing code

- Plan first: `docs/mN-plan.md` (investigation, decisions, data model, HTTP
  surface, security properties and how each is proved, PR breakdown). The
  orchestrator validates it, Levon approves it. No implementation before that.
  Before opening the plan PR, self-review it against `AGENTS.md`'s "Design
  docs / plans" section — the same mistake shapes recur across milestones,
  and catching them before Codex does is cheaper than nine review rounds.
- Check `git config user.email` is `levonasatryan1098@gmail.com`.
- Branch from the latest `origin/main`, then `npm ci`. Dependencies differ
  between branches, and a stale `node_modules` fails the pre-commit typecheck
  with a missing module that has nothing to do with the change. One chat per
  working tree at a time — two chats in one checkout corrupt each other's
  state.
- New migration: take the next free number on `main`, and update
  `src/core/db/types.ts` in the same change.

### While writing

- Never push to `main`. One PR per coherent step.
- **Check the branch is still live before committing to it.** A branch whose
  pull request is merged or closed is dead: commits on it are stranded and have
  to be cherry-picked onto a fresh branch. This has happened twice in one
  session, both times after Levon merged while work continued on the branch. So
  every commit goes either to a branch with an **open** pull request, or to a
  branch just cut from the current `origin/main` — never to yesterday's branch,
  and never to one whose pull request has landed. `scripts/check-branch.sh`
  enforces it on `git push`; run it by hand when committing with
  `--no-verify`, or in a worktree with no `node_modules` where hooks do not
  run. After a merge, `git fetch origin` and cut a new branch before writing
  anything else.
- **Split commits by logical change — never one commit for a whole PR.** A PR
  with several parts is several commits, for example: migration + `types.ts`;
  repository + its tests; service + its tests; controller + `http/` +
  `openapi.yaml`; docs. Tests travel with the code they test. Each commit
  builds and passes the pre-commit hook on its own. Review fixes are their own
  commits, named for the finding, never squashed into the feature commit. A
  single-commit PR for multi-part work is sent back at validation.
- Commit messages end with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; PR bodies end with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Prove every guard by removing it** and watching its test fail. A passing
  test is not evidence until it has been seen failing against the bug — and
  this applies to **every new test, not only to guards**. On #49 two tests
  passed for the wrong reason: a loopback server is itself in the SSRF
  blocklist, so a guard-enabled row returned `ADDRESS_NOT_ALLOWED` whether or
  not the guard ran, and a listener test passed identically with and without
  its fix. Force
  races with an explicit barrier (commit the competing write on a second
  connection) rather than hoping `Promise.all` interleaves; measure timing at
  production Argon2 cost.
- **A mapping table from external signals is untested until one real row per
  class has flowed through the real transport.** Every wrong-result defect on
  #49 lived in failure classification, and all three survived a green suite
  that fed it synthetic error objects: reality disagreed with the documented
  signals on `UND_ERR_SOCKET`, `ERR_SSL_*`, and `authorizationError` being a
  string. Drive the real client against a real server — one case per class —
  before the table counts as covered.
- An environment failure is **diagnosed to its actual cause** before it is
  reported as blocking. "Cannot connect to the Docker daemon" meant the socket
  was at `~/.docker/run/docker.sock` while the CLI looked in `/var/run`; it
  cost two rounds of reporting a blocker that was one env var.
  On this machine that fix is
  `export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`.
- Keep in step, same change: `http/<module>.http` for every endpoint,
  `npm run openapi` for every route or schema change, coverage exclusion paths
  when files move, and a `:dist` twin in `package.json` for every new CLI
  script — `migrate`/`migrate:dist` — or it cannot be run inside the image.

### Before calling it done

1. `npm run verify`, `npm run test:coverage` (≥ 90), and `npm run test:int`
   against `docker compose up -d postgres` with
   `TEST_DATABASE_URL=postgres://probeboard:probeboard@127.0.0.1:5432/probeboard`.
2. A **real run**: `docker compose up -d --build`, then exercise every changed
   endpoint over HTTP and check stored state with `psql`. Tests alone are not
   done.
3. CI green on all five jobs, and `gh pr view <n> --json mergeable` says
   `MERGEABLE` — green checks do not mean no conflicts, `gh pr checks` doesn't
   report that field.
4. Codex reviews every push. Read findings with
   `gh api repos/Levon0Asatryan/probeboard-api/pulls/<n>/comments --paginate`
   (a PR with more comments than one page reads as "everything answered" with
   an older thread still open if you drop `--paginate`). Verify each against
   the code before acting: fix what is real, push back with evidence on what
   is not, and **reply on every thread**. Re-check after each push.
   Codex is done with a push only when `pulls/<n>/reviews` has an entry whose
   `commit_id` is the head SHA. The 👍 (`+1`) reaction on `issues/<n>/reactions`
   is not proof by itself — the reaction has no `commit_id`, so a reaction from
   reviewing an older push can look like it postdates a new one. 👀 means still
   reviewing.
5. **Leave the machine clean.** Everything a run started is stopped before the
   task is reported done: `docker compose down` for the stack, and
   `docker ps -a` checked for one-off containers the compose file does not
   know about — `docker run` for a version check, a throwaway server, a
   reproduction. M3 left a `node:22-alpine` container from a D40 check running
   for 24 hours; the `timeout` was inside the container, so nothing stopped the
   container. A `--rm` flag on every one-off `docker run` prevents most of it.
   Remove scratch volumes and images the task created; leave
   `probeboard-postgres-1` and `probeboard_pgdata`, which the integration
   suite uses. The one exception is an evidence run, which starts from
   `docker-compose down -v` so stale rows cannot leak into its numbers — M5's
   first attempt reported misleading claim counts from exactly that. The
   volume holds only test data, so wiping it is safe; say in the report that
   it was recreated empty. Say in the report what was running and that it is
   stopped.
6. At milestone end, `docs/mN-verification.md`: what was executed and what it
   produced, including defects found by running it.
7. Report back in the format in `docs/handoff-template.md`. Say plainly what
   was not verified.

Style: laconic — same facts, fewer words.

## File and folder structure

Two rules, applied at two different levels. Mixing them up is the mistake this
section exists to prevent.

### Level 1 — feature modules, not technical layers

Inside `api/` and `worker/`, group by **feature**: `auth/`, `health/`,
`monitors/`. Never `controllers/`, `services/`, `repositories/` at this level —
that scatters one feature across four folders so every change touches all of
them, and the tree stops saying what the system does.

Deleting a feature should be deleting one folder.

### Level 2 — inside a module, a folder per role

This is the standard NestJS module layout. `nest g resource` scaffolds
`<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts` at the module
root plus `dto/` and `entities/`; the framework's own `19-auth-jwt` sample adds
`decorators/`; Novu's production `auth` module uses `dtos/`, `services/` and
`e2e/`.

```
api/auth/
  auth.module.ts            the module's own three files stay at the root
  auth.controller.ts
  auth.service.ts
  dto/                      request shapes, one per file
    register.dto.ts
    login.dto.ts
    change-password.dto.ts
    fields.ts               pieces shared between them
  guards/
    session.guard.ts
  decorators/
    current-user.decorator.ts
  services/                 every service except the module's own
    password.service.ts
    rate-limit.service.ts
    auth-maintenance.service.ts
  repositories/
    session.repository.ts
    auth-attempt.repository.ts
  utils/                    pure helpers with no framework role
    session-token.ts
    session-cookie.ts
    client-ip.ts
  e2e/                      tests exercising the module end to end
    auth-http.int.test.ts
    auth-flow.int.test.ts
    change-password.int.test.ts
```

Use the role folder even when it holds a single file. Consistency is what makes
the tree readable — a reader looking for a guard should never have to check
whether this module happened to have only one.

Add `strategies/`, `interfaces/`, `entities/` or `constants.ts` when they
appear; do not invent new role names when a NestJS one fits.

### Naming

`<subject>.<role>.ts`, where role is a NestJS construct: `module`, `controller`,
`service`, `repository`, `guard`, `decorator`, `pipe`, `filter`, `interceptor`,
`middleware`, `strategy`, `dto`.

Pure helpers with no framework role take a plain kebab-case name —
`session-token.ts`, `client-ip.ts`.

Keep the subject prefix even inside a folder that repeats it:
`repositories/session.repository.ts` stays findable by fuzzy search,
`repositories/repository.ts` does not.

### Tests

- `<file>.test.ts` beside the file it tests — unit, no I/O.
- `<file>.int.test.ts` for anything needing PostgreSQL. Separate vitest config,
  separate CI job.
- Tests that span the whole module go in `e2e/`, named
  `<subject>.int.test.ts`, because they belong to no single file.

### Requests

`http/` holds a runnable request collection: one `.http` file per module, plus
the `.env` those files read. **An endpoint is not finished until its request is
in there**, in the same change — a collection that lags the code is worse than
none, because a missing request reads as "this endpoint does not exist".

A new module gets a new `<module>.http`. Include the failure cases worth having
at hand, not only the happy path. Anything needing repetition or concurrency —
rate limits, caps — stays a shell snippet in a comment, because no interactive
client produces it.

### Top level

Only the deployment layers: `core/` (shared by both processes), `api/`,
`worker/`, `testing/`. `core` depends on nothing; `api` and `worker` depend on
`core` and never on each other. Enforced by `src/architecture.test.ts`.

### When files move

Update the coverage exclusion paths in `vitest.config.mts`. They are literal
paths, so a move silently re-admits an excluded file and the threshold then
fails for a reason unrelated to the change.

## Other conventions

- **Configuration** is injected through `APP_CONFIG`, never read from a
  module-level singleton. A parameter decorator cannot read injected config, so
  policy that depends on configuration belongs in a service.
- **Logging** uses a static message with variable data in fields. Credentials
  and monitor request headers are redacted.
- **Errors** carry a stable machine-readable `code`. Internal detail goes to the
  log, never to a response.
- **Every guard, filter or check ships with a test that proves it fails** when
  it should. This repository has shipped three that silently did nothing.
- Never cache a rejected promise (e.g. a timing-safe dummy-hash constant) as
  its resolved value. One transient failure poisons the cache permanently —
  every later call fails the same way until process restart.
- Local e2e servers bind `127.0.0.1` explicitly, never `listen(0)` on the
  default host. On macOS an ephemeral port picked against `0.0.0.0` can
  collide with another process already bound to `127.0.0.1` on that port,
  producing flaky, unrelated-looking failures.
