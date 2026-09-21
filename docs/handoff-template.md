# Handoff template

How work moves between the orchestrator session and worker chats. The
orchestrator fills in part 1 and gives it to Levon, who pastes it into a fresh
chat. The worker answers with part 2, which the orchestrator validates against
GitHub rather than taking on trust.

Both parts are fixed-shape on purpose: a report the orchestrator can check
line by line costs a fraction of re-reading a diff.

---

## Part 1 — prompt to the worker

```text
You are a worker chat on probeboard, a university diploma thesis: an API
monitoring dashboard. Repo: ~/Dev/university/probeboard/probeboard-api
(GitHub Levon0Asatryan/probeboard-api). Design docs:
~/Dev/university/probeboard/probeboard-docs (chapter 8 is the milestone plan).

Read first, in order: CLAUDE.md (how work is done, structure, naming),
AGENTS.md (review rules), docs/tracker.md (current state).

## Task
<one milestone or one plan step, e.g. "M2 — Registration" or
"Social login PR 4 — HTTP surface">

## Scope
<what is in, copied or cited from 08-plan.md / the plan doc>
<what is explicitly out>

## Starting point
<branch to start from, PRs that must be merged first, relevant files>

## Known constraints and decisions already made
<ADRs, plan decisions, anything the worker must not relitigate>

## Deliverables
<plan doc if not yet approved | PR(s) | verification record>

## Phase 1 — Investigation (before any plan or code)
Go deep; record findings in the plan doc with sources.
- Read every requirement and story in scope, and the architecture chapter.
  List contradictions or gaps between them.
- Read the code on main this work touches. Note the patterns to follow.
- Study how comparable systems solve it, and their published vulnerabilities
  and bug reports for this area. Each one becomes a test or a decision.
- <topic-specific questions the investigation must answer>

## Phase 2 — Implementation
Per the approved plan. Deviations go in the report under "Decisions made".

## Phase 3 — Revalidation (after implementing, before calling it done)
- Walk the plan line by line against the code: every decision, endpoint,
  constraint and test in the matrix exists. List any gap.
- Re-prove every guard by removal on the final code, not an earlier commit.
- Fresh clone of the branch (npm ci, build, verify, test:int) and a real
  docker compose run with psql checks: required for an HTTP surface, a
  migration, a database change, or the last PR of a milestone. For a
  pure-logic PR, CI plus the local suites are enough. Say which applied.
- Leave the machine clean: `docker compose down`, and `docker ps -a` checked
  for one-off containers a `docker run` started (use `--rm`). Leave
  `probeboard-postgres-1`. Say in the report what was running and that it is
  stopped.

## Phase 4 — Re-review (after revalidation)
- Phase 3 finishes **before the first push of code**. Codex reviewing work you
  have not checked yourself turns your own defects into review rounds at six
  minutes each. Push a PR you would merge.
- Review the whole PR diff yourself, line by line, as a hostile reviewer
  against AGENTS.md: security, concurrency, error paths, naming, dead code,
  stale comments, docs/http/openapi drift. Fix or justify each finding.
- After the last push, wait for Codex on the head SHA (a review whose
  commit_id is that SHA). Verify each finding against the code before acting:
  check the premise, and push back with evidence on a finding whose facts are
  wrong rather than implementing it.
- **Two rounds, then stop.** From round three, fix only a security hole, data
  loss, a wrong result or a broken build. Everything else gets a one-line
  reply saying it is deferred plus a tracker follow-up — never silence.
- **One push per round, carrying every finding of that round.** Read all the
  comments, decide on all of them, fix all of them, push once.
- **Every fix push re-runs the full gate**: verify, unit, integration, and the
  real run again if the fix touched HTTP, a migration, the database or
  concurrency. Then review the fix's blast radius — the guards it touches,
  re-proved by removal, and the callers of anything whose signature, timing or
  error behaviour changed. Re-read the whole diff only when a fix reaches
  outside the module the finding named.
- **Resolve each thread** when its fix is pushed and verified: reply with what
  changed and in which commit, then resolve. Leave a thread open only for a
  pushback awaiting Levon, or a deferral with a tracker row.
- Build for this thesis, not for a fleet: no deployment, no production data,
  no operator. Work that only pays off at unreachable scale is out of scope;
  say so and move on.

## Stop points
- After writing docs/mN-plan.md: stop and report. Do not implement until the
  plan is approved.
- Do not merge. Do not push to main.

## When to report, and when not to
One report per pull request, when it is finished: pushed, CI green, Codex's
rounds done, threads resolved, machine clean. Not per push, not per review
round, not per fix, not when the review finds something interesting.

Report mid-flight only for these, and immediately:
1. Blocked after diagnosing the cause, where clearing it needs a decision that
   is not yours: scope, a credential, dropping something the plan promised.
2. Something that invalidates the plan's **design** — a hole in its reasoning,
   not a deviation from its wording.
3. A defect in already-merged work.
4. Something needed outside your checkout: docs, the tracker, another repo.

Handle these yourself and put them in the report instead:
- A review round arriving. Decide fix-or-defer against AGENTS.md's severity
  contract, fix or post a one-line deferral, resolve the thread, carry on. A
  rejection with a constructed counter-case is a complete answer and needs no
  confirmation.
- Deviations from the plan's wording — one line each under "Decisions made";
  the orchestrator files them in the tracker.
- Tests breaking while fixing review findings. That is phase 3 working.
- Review tooling misbehaving: scratch files, stray processes, a lens reading a
  mid-mutation tree. Note it under "Regressions caught by the post-fix gate".
- Defects your own pre-push review caught. That is what it is for.
- Anything answerable from CLAUDE.md, AGENTS.md, the plan, or the tracker.

Fix-vs-defer, thread resolution, and moving from one pull request to the next
are yours to decide. A deferral costs one line of reasoning in the thread and
one line in the report — not a question.

When done, reply in the report format from docs/handoff-template.md, part 2.
```

---

## Part 2 — report from the worker

```text
## Task
<as given>

## Status
done | blocked | plan ready for approval

## Pull requests
- #<n> <title> — <url> — CI: <green/red per job> — review threads: <open/total>

## Investigation
<key findings and sources; what each changed in the plan or tests>

## What changed
<3–8 lines: behaviour, not file lists>

## Revalidation
- Plan vs code: <gaps found, and fixed or not>
- Fresh clone run: <commands and results>

## Re-review
- Self-review findings: <fixed n, justified n — one line each>
- Rounds: <n>. Threads: <resolved>/<total>, <open> left open and why.
- Regressions caught by the post-fix gate: <what broke while fixing, or none>
- Codex: reviewed SHA <sha>, <review | 👍> at <time>, <n> rounds
- Deferred to follow-ups: <finding — why it is not fix-now; one line each>

## Decisions made
<anything not already in the plan, with the reason>

## Evidence
- Tests: unit <n>, integration <n>, coverage <stmts>% / <branches>%
- Guards proved by removal:
  | guard removed | test that failed |
- Real run: <commands run against docker compose, and what they returned>
- Review findings: <fixed n, pushed back n (with reason), outstanding n>

## Not verified
<what could not be checked, and why>

## Defects found
<bugs found while doing this, fixed or not>

## Open questions for Levon
<decisions that are his>
```

---

## How the orchestrator validates a report

Cheap checks first, and only spot-check code where a claim is load-bearing:

1. PR exists, is mergeable, CI green on all five jobs (`gh pr checks <n>`).
2. Every review thread has a reply (`gh api .../pulls/<n>/comments`).
3. Each guard-removal row names a test that exists in the diff.
4. The real-run evidence names concrete requests and results, not "tested".
5. `npm run openapi:check` would pass, `http/` has requests for new routes, a
   migration has its `.down.sql` and `types.ts` change.
6. Anything under "not verified" is either acceptable or becomes a follow-up in
   the tracker.

Then update `docs/tracker.md`.
