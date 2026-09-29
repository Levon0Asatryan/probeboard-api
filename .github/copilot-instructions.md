# Review instructions for probeboard-api

A university thesis on a deadline: an API monitoring dashboard whose product is
numbers a user trusts. Every review round costs the author several minutes of
waiting, so the bar is deliberately high. The full contract is `AGENTS.md`,
"Code Review Rules"; this is its core.

## Report a finding only if it is one of these

- a **wrong result**: a number, status or verdict a user would trust that the
  code does not actually compute, such as uptime, latency, a failure class or
  an incident time;
- a **security hole**: SSRF, a secret in a log or response, an authorization
  gap, injection;
- **data loss or corruption**, including a lost update or a broken invariant;
- a **concurrency defect**: a duplicate, a lost claim, a race, a deadlock;
- a **broken build, broken test, or a test that cannot fail**, including a
  test that passes for a reason other than the behaviour it names;
- a **resource leak** a long-running process would accumulate;
- a **documented contract violated**: the code contradicts `docs/mN-plan.md`,
  an ADR, `openapi.yaml` or the requirements.

## Do not report

- formatting, import order, naming style or type errors, because Prettier,
  ESLint and `tsc` already block on them in CI;
- "consider…", "it might be cleaner", "a more idiomatic way", or a preference
  between two correct spellings;
- defensive code for inputs the types or validated config already exclude;
- hardening or generality that only pays off at a scale this system will never
  reach: there is no deployment, no production data and no operator;
- missing tests for a case another test already covers, or coverage as a
  number;
- anything already recorded as a follow-up in `docs/tracker.md`.

## Shape of a finding

One comment per defect, not per occurrence. State the concrete failure: the
input, the wrong behaviour that follows, and why. A finding that asserts a fact
(a limit, a default, a specification, a library's behaviour) must cite it,
because the author checks the premise and pushes back when it is wrong.

## Design documents

On a plan (`docs/mN-plan.md`), report only what changes the design: a
contradiction with a requirement, ADR or measured evidence; an arithmetic or
logical error in a stated invariant or bound; a missing security property; or
a specified test that could not fail. Do not report wording, completeness or
ordering. A plan gets one review round.

## What this codebase gets wrong most often

- Locks taken in inconsistent order, or a value read before the lock that
  decides the outcome. A foreign key takes a hidden share lock on the parent.
- A guard whose predicate can silently match zero rows fails open.
- A race "proved" with a sleep instead of a barrier.
- A failure signal mapped to `UNKNOWN`, which is excluded from uptime, so the
  outage goes unrecorded rather than mislabelled.
- Internal detail (a stack trace, SQL, an internal address) reaching an HTTP
  response.
