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

## Stop points
- After writing docs/mN-plan.md: stop and report. Do not implement until the
  plan is approved.
- Do not merge. Do not push to main.

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

## What changed
<3–8 lines: behaviour, not file lists>

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
