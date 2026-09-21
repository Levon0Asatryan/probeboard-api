# Tracker

Status of record for probeboard work. The orchestrator session updates it after
validating a worker's report; workers read it and propose changes in their
report rather than editing it, so two chats never edit it at once.

Last updated: 2026-09-21, by the orchestrator, after validating M4 PR 2 (#59)
and recording its deviations from the merged plan.

## Now

- **M2 — Registration is done.** Five milestone PRs (#28–#35) plus two fix PRs
  (#37 review findings and the verification record, #38 the tag-filter hang).
  `main` is green at 5f22da3.
- **M3 — Probe executor is done.** Three PRs: #43 (the shared `json_path`
  grammar and the save-time contract), #48 (probing pure logic and the
  connect-time SSRF pin), #49 (the executor). `main` is green at ec246b2.
  Eight Codex rounds on #49 found seven real defects, three of them wrong
  results that would have reached the database — see
  [m3-verification.md](m3-verification.md).
- **M4 — Scheduler is in progress.** The plan merged as #52. PR 1 was the
  process work; **#59** (PR 2) carries `endpoint_runtime`, the claim statement,
  reconcile and their configuration — CI 5/5 green on `7ca431e`, Codex round 1
  answered and resolved, awaiting merge. PR 3 is the tick loop, lease release
  and expiry, the exit test and compose `stop_grace_period`.
  Its pre-push review found three defects before Codex saw the branch, two of
  them deadlocks, and six tests that passed for the wrong reason — the first
  evidence that the review-before-push ordering (#53, #57) pays for itself.
- **Before the scheduler probes for real:** run
  `npm run audit:json-path-assertions` once against each deployed database
  (D48/D50/D51). Nothing persists a probe result until M5.
- **Merge gate:** merge a code PR only after Codex has reviewed or 👍'd the
  **head SHA** and the orchestrator has validated. Small docs-only PRs (this
  tracker, `CLAUDE.md`, templates) skip the Codex wait — Levon merges them
  directly (decided 2026-09-14). The gate exists because #18, #19, #21, #23,
  #29 and #34 each merged early: #23's unreviewed last commit shipped an open
  redirect, and #34's left seven threads unanswered until #37.

- **Decided (2026-09-13):**
  - Worker chats run **one at a time** in this checkout; no parallel
    worktrees. The backend is a dependency chain anyway.
  - Branch protection on `main` stays **off**. `CLAUDE.md` forbids chats from
    pushing to it; the orchestrator checks for direct pushes when validating.
  - Social login is verified against the **local test provider** for now.
    Real Google and GitHub verification is **required, not optional** —
    scheduled in "Finish social login" below, and it blocks M9.

- **Decided (2026-09-20):**
  - **No Sentry and no Datadog.** Both are hosted services carrying an account,
    a DSN or API key, and an agent, for a thesis project that runs on one
    machine and is demonstrated, not operated. Failures are read from the logs
    and from probe results, which are the product itself.
  - **Grafana is not a dependency.** After `/metrics` exists (NFR-20) it can be
    added as an **optional `docker compose` profile in M10** — off by default,
    scraping the app's own endpoint, nothing to sign up for. Decide then, not
    now.
  - **GitHub community standards** are in place on `probeboard-api`:
    `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `CONTRIBUTING.md`,
    `SECURITY.md`, issue forms with a security contact link, and a PR template
    mirroring the evidence a review asks for. Pushed to `main` directly
    (`2f1207d..253cc33`) at Levon's explicit instruction — the one exception to
    the never-push-to-`main` rule. Private vulnerability reporting is enabled,
    because `SECURITY.md` routes reports through it. `probeboard-docs` (28%)
    and `probeboard-web` (14%) have not had the same treatment.

## Milestones

From `probeboard-docs/en/08-plan.md`. Social login is an extension of Epic A
added between M1 and M2; it is not in the thesis acceptance criteria.

| Milestone | Name                   | Status                | Plan                                         | Verification                             |
| --------- | ---------------------- | --------------------- | -------------------------------------------- | ---------------------------------------- |
| M0        | Skeleton               | done                  | —                                            | [m0-verification.md](m0-verification.md) |
| M1        | Accounts               | done                  | [m1-plan.md](m1-plan.md)                     | [m1-verification.md](m1-verification.md) |
| —         | Social login           | code done; F2–F5 open | [social-login-plan.md](social-login-plan.md) | stub only — F3 pending                   |
| M2        | Registration           | done                  | [m2-plan.md](m2-plan.md)                     | [m2-verification.md](m2-verification.md) |
| M3        | Probe executor         | done                  | [m3-plan.md](m3-plan.md)                     | [m3-verification.md](m3-verification.md) |
| M4        | Scheduler              | in progress (PR 3)    | [m4-plan.md](m4-plan.md)                     | —                                        |
| M5        | Storage                | not started           | —                                            | —                                        |
| M6        | Incidents              | not started           | —                                            | —                                        |
| M7        | Alerting               | not started           | —                                            | —                                        |
| M8        | Statistics             | not started           | —                                            | —                                        |
| M9        | Web (`probeboard-web`) | not started           | —                                            | —                                        |
| M10       | Evaluation             | not started           | —                                            | —                                        |

M2 → M6 is a dependency chain; run it in order.

## M2 — Registration

| Step | Content                                                     | PR                                                              | Status |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| 1    | Schema and repositories: services, endpoints, headers, tags | [#28](https://github.com/Levon0Asatryan/probeboard-api/pull/28) | merged |
| 2    | Save-time SSRF guard                                        | [#29](https://github.com/Levon0Asatryan/probeboard-api/pull/29) | merged |
| 3    | Secret header encryption                                    | [#30](https://github.com/Levon0Asatryan/probeboard-api/pull/30) | merged |
| 4    | CRUD HTTP surface                                           | [#34](https://github.com/Levon0Asatryan/probeboard-api/pull/34) | merged |
| 5    | Tags and filtering                                          | [#35](https://github.com/Levon0Asatryan/probeboard-api/pull/35) | merged |
| fix  | Seven unanswered threads, CI flake, verification record     | [#37](https://github.com/Levon0Asatryan/probeboard-api/pull/37) | merged |
| fix  | Tag-filter query hang: `LATERAL` join + composite indexes   | [#38](https://github.com/Levon0Asatryan/probeboard-api/pull/38) | merged |

Twelve defects found by running it, recorded in
[m2-verification.md](m2-verification.md). Two are worth carrying forward as
lessons: SSRF/DNS validation held a row lock while resolving, and the tag
filter's plan depended on statistics that do not exist immediately after a
bulk insert — `EXISTS` let the planner start from `tags`, `LATERAL` removes
that choice. The SSRF blocklist now covers the full IANA IPv4 and IPv6
special-purpose registries, with 86 tests and a comparison table.

## M4 — Scheduler

Deviations from the merged plan (#52), found while implementing #59. The plan
is not rewritten; these are the record of where the code and the document
differ and why.

| Plan | Deviation                                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.7 | The release fence binds PostgreSQL's own text form cast with `::timestamptz`, not a JavaScript `Date`.                       | `timestamptz` keeps microseconds and node-postgres parses to millisecond `Date`s, so `scheduled_at = $slot` matched **zero rows, always**: no lease ever cleared and every monitor probed once, then blocked until expiry. A zero-row write is not an error, so it failed open and silently. The plan's form cannot work.                                                                                                                            |
| §3.2 | `claim_log`'s foreign key to `endpoints` is dropped.                                                                         | The plan says "Deletion needs nothing: `ON DELETE CASCADE`" — true for `endpoint_runtime`, fatal here. An insert against a referencing column takes `FOR KEY SHARE` on the parent, so a claim locked `endpoint_runtime` first and `endpoints` last, the inverse of a cascading delete: 20/20 deadlocks with the FK and 0/20 without, with `DELETE /services/:id` the victim 9 times in 20. It also made §3.1's "a claim cannot block the API" false. |
| §3.3 | `reconcile` selects rows in an ordered CTE with `FOR UPDATE OF r SKIP LOCKED` instead of a bare `UPDATE ... FROM endpoints`. | The bare form took row locks in nested-loop order, so two workers' ticks deadlocked each other: 18 spontaneous `40P01`s in 15s with six workers over 200 endpoints.                                                                                                                                                                                                                                                                                  |
| §3.1 | "`endpoints` is read but never locked" now holds for the whole statement, not only for the `FOR UPDATE OF r` clause.         | It was true of the clause and false of the statement while the `claim_log` FK existed.                                                                                                                                                                                                                                                                                                                                                               |
| §5   | `PROBE_MAX_TIMEOUT_MS` and `PROBE_DEFAULT_TIMEOUT_MS` are capped at five minutes.                                            | At the int4 ceiling the shutdown-grace floor was unsatisfiable at every legal value of every other key.                                                                                                                                                                                                                                                                                                                                              |

## Social login

| Step | Content                                                        | PR                                                                                                                               | Status |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1    | Schema, repositories, password-less account, §8 changes        | [#16](https://github.com/Levon0Asatryan/probeboard-api/pull/16)                                                                  | merged |
| 2    | Linking policy (CVE-2026-53516 as a test)                      | [#17](https://github.com/Levon0Asatryan/probeboard-api/pull/17)                                                                  | merged |
| 3    | Provider strategies, local identity provider; review fixes     | [#19](https://github.com/Levon0Asatryan/probeboard-api/pull/19), [#21](https://github.com/Levon0Asatryan/probeboard-api/pull/21) | merged |
| 4    | HTTP surface: start, callback, link, unlink, `http/oauth.http` | [#23](https://github.com/Levon0Asatryan/probeboard-api/pull/23), [#24](https://github.com/Levon0Asatryan/probeboard-api/pull/24) | merged |
| 5    | Config, callback URLs out of logs, identities on `/me`         | landed in [#23](https://github.com/Levon0Asatryan/probeboard-api/pull/23)                                                        | merged |

Security properties added by #23/#24, each proved by removing its guard:
provider-bound single-use state (OAuth mix-up), redirect URI from config never
`Host`, `returnTo` parsed and re-checked after dot-segment resolution, link
re-checks the originating session under a users-then-sessions lock so
`logout-all` cannot be raced, authorization code absent from every log line.

### Finish social login

Social login is not done until every row is. Each has a deadline; the
orchestrator checks this list at every milestone handoff and puts overdue rows
into that handoff.

| #   | Item                                                                                                                                                                                                                                                                                                                                                        | Who                 | Deadline                           | Status         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------- | -------------- |
| F1  | `docker-compose.yml` reads `GOOGLE_*` / `GITHUB_*` from the gitignored `.env` via `${VAR:-placeholder}` instead of hardcoded placeholders, so real credentials never need a committed edit. `.env.example` documents it.                                                                                                                                    | M2 worker           | with M2's #18 fixes PR             | **done (#27)** |
| F2  | Register a Google OAuth client (Web application, consent screen with Levon as test user, scopes `openid email profile`) and a GitHub OAuth app. Callbacks `http://127.0.0.1:3000/v1/auth/oauth/google/callback` and `.../github/callback` (use `localhost` consistently if Google refuses `127.0.0.1`). Secrets go into `.env` by Levon, never into a chat. | Levon               | before F3                          | open           |
| F3  | Real-provider run, recorded in `docs/social-login-verification.md`: sign up with Google, sign in again, link GitHub, `/me` shows both, unlink, last-credential refusal, logout-all, denied consent → `/login?error=`, `docker compose logs` free of `code=`.                                                                                                | worker chat         | **before M9 starts** (blocking)    | open           |
| F4  | Docs repo: ADR-0010 (linking policy), ADR-0011 (cookie and domain), stories A-7 and A-8, a milestone-table row. `social-login-plan.md` §11.                                                                                                                                                                                                                 | docs-only chat      | before M9 starts                   | open           |
| F5  | Decide: web and api under one registrable domain, or `SameSite=Lax` breaks the SPA. `social-login-plan.md` §10. Recorded in ADR-0011.                                                                                                                                                                                                                       | Levon, orchestrator | before M9 plan approval (blocking) | open           |

## Other merged work

| PR                                                              | What                                           |
| --------------------------------------------------------------- | ---------------------------------------------- |
| [#13](https://github.com/Levon0Asatryan/probeboard-api/pull/13) | Reproducible build from a clean tree           |
| [#14](https://github.com/Levon0Asatryan/probeboard-api/pull/14) | `http/` request collection                     |
| [#15](https://github.com/Levon0Asatryan/probeboard-api/pull/15) | Social login plan                              |
| [#18](https://github.com/Levon0Asatryan/probeboard-api/pull/18) | `openapi.yaml` generated, Swagger UI           |
| [#20](https://github.com/Levon0Asatryan/probeboard-api/pull/20) | Workflow rules, tracker, handoff template      |
| [#22](https://github.com/Levon0Asatryan/probeboard-api/pull/22) | Tracker after social login Step A              |
| [#25](https://github.com/Levon0Asatryan/probeboard-api/pull/25) | Tracker after PR 4; handoff phases             |
| [#26](https://github.com/Levon0Asatryan/probeboard-api/pull/26) | M2 plan                                        |
| [#27](https://github.com/Levon0Asatryan/probeboard-api/pull/27) | #18 follow-ups; OAuth credentials from `.env`  |
| [#31](https://github.com/Levon0Asatryan/probeboard-api/pull/31) | Four work phases and commit splitting as rules |
| [#32](https://github.com/Levon0Asatryan/probeboard-api/pull/32) | Dependabot twice weekly, Mondays and Thursdays |
| [#36](https://github.com/Levon0Asatryan/probeboard-api/pull/36) | Review rules distilled from the PR history     |

## Follow-ups

Items found while validating, not yet scheduled.

| Source         | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Kind    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| #18            | Drift test reads routes from decorator metadata rather than the running application. Judgement call — reply with a decision or fix it.                                                                                                                                                                                                                                                                                                                                                                                 | decide  |
| #37            | The SSRF blocklist is hand-maintained, so an IANA change needs a code change. Codex asked for a generated classifier; pushed back as out of scope. Decide whether to generate it from the registries before M10.                                                                                                                                                                                                                                                                                                       | decide  |
| #38            | No per-user cap on service count: only `ENDPOINT_QUOTA_PER_USER` exists, and `ServicesService.createExplicit` checks nothing. B-8 names only endpoints, so this is a gap in resource limits, not in the story.                                                                                                                                                                                                                                                                                                         | decide  |
| process        | #18–#23, #29 and #34 merged before Codex finished reviewing. See the merge gate above.                                                                                                                                                                                                                                                                                                                                                                                                                                 | process |
| #24 validation | Workers missed Codex's no-findings signal: a 👍 reaction on the PR, not a review. `CLAUDE.md` now says where to look.                                                                                                                                                                                                                                                                                                                                                                                                  | process |
| #49 / D69      | The stalled-pipe reproduction is committed `it.skip` on `main`: D69's shipped fix does not release a pending write, and only `process.exit()` returns. Needs a bounded exit for the audit's stalled reader.                                                                                                                                                                                                                                                                                                            | fix     |
| #46            | The production-group Dependabot bump breaks `bootstrap.e2e` and `docs.e2e` with server-start timeouts, reproduced on rerun. Suspects `@nestjs/platform-express` and `nestjs-pino` 5.2.0. Bisect or supersede.                                                                                                                                                                                                                                                                                                          | decide  |
| M3 process     | Three of seven Codex defects on #49 were wrong results in failure classification that a green suite missed, because it fed synthetic error objects. `CLAUDE.md` now requires a real-transport row per class.                                                                                                                                                                                                                                                                                                           | process |
| M3 process     | Two tests passed for the wrong reason and only the removal proof caught it. `CLAUDE.md` now applies the removal proof to every new test, not only to guards.                                                                                                                                                                                                                                                                                                                                                           | process |
| M3 process     | Hostile self-review found one defect to Codex's seven, and missed three plain deviations from sentences in the plan. `CLAUDE.md` now makes re-review walk the plan's normative sentences.                                                                                                                                                                                                                                                                                                                              | process |
| #59            | D2's paused-row re-measurement: a row paused and resumed keeps the slot computed before the pause. Decide whether resume re-measures or inherits.                                                                                                                                                                                                                                                                                                                                                                      | decide  |
| #59            | `claim_log` has no retention policy. It exists for disjointness evidence; size it or prune it in M5.                                                                                                                                                                                                                                                                                                                                                                                                                   | fix     |
| #59            | D17's M6 columns are not in `endpoint_runtime` yet. M6 needs them; confirm the shape when M6 is planned, not before.                                                                                                                                                                                                                                                                                                                                                                                                   | decide  |
| #59            | `reconcile` scans the whole fleet every tick. Fine at thesis scale, measured at 50,000 rows; revisit only if M8's load work says so.                                                                                                                                                                                                                                                                                                                                                                                   | decide  |
| #59            | M5's `probe_results` key should be `(endpoint_id, scheduled_at)` — the claim already returns the slot as PostgreSQL text for exactly this.                                                                                                                                                                                                                                                                                                                                                                             | fix     |
| #59            | Compose `stop_grace_period` is untouched; it belongs to M4 PR 3 with the exit test.                                                                                                                                                                                                                                                                                                                                                                                                                                    | fix     |
| #59 / Codex    | Narrowing `PROBE_ALLOWED_INTERVALS_S` does not re-validate `endpoints.interval_s` rows written under the wider set. `interval_s` is checked on write only (`endpoints.service.ts:44-49`) and carries no database constraint, by rule #1. Raising the entry floor 1→10 is one instance; narrowing `30,60` to `60` strands 30s rows identically. What should happen to an existing row — silently clamped, rejected, disabled, or surfaced to its owner — is a design decision. Decide when M5 touches endpoint storage. | decide  |
| #59 / Codex    | Codex asked the claim to exclude rows whose `scheduled_interval_s` differs from the live interval. Deferred: reconcile now uses `SKIP LOCKED`, so that predicate makes a skipped row unclaimable and turns one early probe into an unprobed endpoint. Revisit if M5 gives reconcile a guaranteed-completion path.                                                                                                                                                                                                      | decide  |
| M3 process     | A Docker socket at `~/.docker/run/docker.sock` was reported as a blocker twice before being diagnosed. An environment failure is diagnosed to its cause before it is reported as blocking.                                                                                                                                                                                                                                                                                                                             | process |

Closed since last update: `jvONd` and `jp9DY`, both answered on #43; the two
#18 fixes and F1 (#27); seven unanswered
Codex threads, the missing verification record, `AggregateError` causes, the
broken OpenAPI `$ref`, header/tag replace atomicity, `http/` consolidation and
the SSRF registry audit (#37); the tag-filter hang (#38).
