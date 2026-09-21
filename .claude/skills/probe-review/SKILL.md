---
name: probe-review
description: Review probeboard changes against this repository's own mined rules in .review/rules/, before pushing. Three passes — mechanical checks, the rule corpus, then an architecture pass that traces one request end to end across api/worker/core and checks the change against the milestone plan and the ADRs. Use before the first push of a PR, and after fixing review findings. Lighter than /code-review and scoped entirely to this repository.
---

# probe-review

The review that runs **before** the first push, so Codex reviews finished work.

`#49` cost 89 minutes over eight Codex rounds, and the fixes took two to four
minutes each — the waiting was the cost. Everything this skill finds is a round
that never happens.

**Scope.** This skill reads `.review/rules/` in this repository, `AGENTS.md`,
`CLAUDE.md`, the milestone plan in `docs/mN-plan.md` and the ADRs in
`../probeboard-docs/en/adr/`. It does not read or write any rule corpus outside
this repository. probeboard is a separate environment on this machine; its
rules stay in it.

Invoked:

- `/probe-review` — the branch diff against `origin/main`
- `/probe-review --fix-round` — after fixing review findings: pass 0 plus the
  blast radius of the fix only
- `/probe-review <path>` — one file or directory

---

## Pass 0 — mechanical (always, seconds)

Run these first and report failures as a block. No LLM judgment.

```bash
npm run verify                 # format, lint, types, unit
npm run test:coverage          # must stay >= 90
npm run test:int               # needs docker compose up -d postgres
```

Then the `**Check:**` patterns in `.review/rules/probeboard.md` against the
changed files. Each one is an ERE with a remediation message; report
`file:line` plus the message.

If pass 0 fails, stop and report. There is no point reviewing code that does
not build.

## Pass 1 — the rule corpus

Read `.review/rules/probeboard.md`. For each rule, ask whether this diff could
violate it, and check the ones that apply. These 20 rules were each caught by a
reviewer in this repository already — a repeat is a round we are paying for
twice.

Weight the four that produced wrong results in production code:

- **#6** — the clock stops when the measured work ends, not after teardown
- **#7** — a partial result keeps what it established; a discarded status
  becomes `UNKNOWN`, and M6 excludes `UNKNOWN` from uptime
- **#13** — the test fails for the reason it names, not another one
- **#1** — no limit is a literal or a database default

## Pass 2 — architecture, end to end

The part a diff review cannot do. Four questions, answered concretely:

**Trace one request or one probe end to end.** Name the path: controller →
guard/pipe → service → repository → SQL, or tick → claim → loader → `probe()` →
release. At each hop say what this change alters. A change that cannot be
traced this way is in the wrong place.

**Check the boundaries the architecture fixes.**

- `api` serves HTTP and never probes; `worker` probes and never serves HTTP.
- Logic both processes need lives in `core` (rule #15).
- A module owns its role folders; a repository owns its SQL.
- Kysely is a query builder, not an ORM — raw SQL for the mechanisms the
  thesis examines is deliberate (ADR-0001), not something to abstract away.

**Check the change against the plan and the ADRs.** Walk the normative
sentences of `docs/mN-plan.md` — every "must", "is anchored on", "is excluded
from" — and point at the line implementing each. Contradicting an accepted ADR
is a finding; so is silently doing what an ADR rejected. On #49 both wrong
measurements were plain deviations from sentences already written in the plan,
and reading the diff for smells did not find them.

**Check what the next milestone needs.** A column, an export or a contract M5
or M6 depends on is part of this change's correctness. `docs/tracker.md` lists
the follow-ups already owed.

## Pass 3 — the adversarial pass

Re-read your own findings and try to knock each one down:

- **Is the premise true?** A finding asserting a limit, a default, a
  specification or a library's behaviour is asserting a fact. Check it. Two of
  Codex's findings in M2 and M3 were wrong on their own numbers.
- **Would the test actually fail?** For every guard the change adds, name the
  test and say what removing the guard makes fail. If the answer is "the test
  still passes", that is a finding in the test (rule #13).
- **Is this a nit?** Report only what `AGENTS.md`'s severity contract allows:
  wrong results, security holes, data loss, concurrency defects, broken or
  unfailable tests, resource leaks, violated documented contracts. Style,
  "consider…", and fleet-scale hardening are not findings here.

## Output

```
PASS 0  verify / coverage / int / checks   ✅ or the failures
PASS 1  rules            N applicable, M violated
PASS 2  architecture     trace, boundaries, plan conformance, next milestone
PASS 3  survived         findings that held up, ranked

FINDINGS
  1. [wrong-result] file:line — one sentence, then the concrete failure:
     input → wrong output.
  2. ...

NOT CHECKED  what this pass could not establish, and why.
```

Rank by severity, not by file order. "Nothing" is a valid finding list and is
worth saying plainly.

## The receipt — this is what unblocks the push

The last step of every run writes `.review/.last-review.json`:

```json
{
  "sha": "<git rev-parse HEAD>",
  "at": "<ISO timestamp>",
  "findings_open": 0,
  "method": "probe-review"
}
```

`method` is `probe-review` from this skill, `probe-review-workflow` from the
workflow, or a short name you choose when the passes were run another way. Any
other value still opens the gate, but the push output says the receipt was not
written by the tool and the PR must name the method and say which passes ran —
an attestation is allowed, a silent one is not.

`scripts/require-review.sh` runs from the `pre-push` hook and refuses the push
unless that file exists, its `sha` is exactly the commit being pushed, and
`findings_open` is `0`. So the review is not something to remember — a code
push without one is blocked, and a push after new commits is blocked until the
review is re-run. Docs-only pushes are exempt. `SKIP_REVIEW_GATE=1` overrides
it and must then be named in the PR's "Not verified".

`findings_open` is the count the author still has to act on. Deferring a
finding is a decision to record, not a way to reach zero.

## The deeper version

`/probe-review` is one reviewer doing every lens in turn. `/probe-review`'s
workflow twin, `.claude/workflows/probe-review.js`, runs six independent
reviewers — measurement, concurrency, security, tests, contract, architecture —
then has a **separate** agent attack each finding before it is reported, and
writes the same receipt. Use it before the first push of a PR that touches
concurrency, a migration or a measurement; use this skill for a fix round.

## After the review

- Findings that hold up get fixed **before** the first push (`CLAUDE.md`, "The
  review loop", rule 1).
- A recurring finding that is not yet in `.review/rules/probeboard.md` gets
  added there, with its `**Why:**` and its source PR. That is how the corpus
  grows — never into a corpus outside this repository.
- On a `--fix-round`, re-run pass 0 in full plus pass 1 and 2 over the fix's
  blast radius: the guards it touches, and the callers of anything whose
  signature, timing or error behaviour changed.
