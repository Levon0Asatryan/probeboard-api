# Tracker

Status of record for probeboard work. The orchestrator session updates it after
validating a worker's report; workers read it and propose changes in their
report rather than editing it, so two chats never edit it at once.

Last updated: 2026-09-16, by the orchestrator, after validating #37 and #38.

## Now

- **M2 — Registration is done.** Five milestone PRs (#28–#35) plus two fix PRs
  (#37 review findings and the verification record, #38 the tag-filter hang).
  `main` is green at 5f22da3.
- **Next:** M3 — Probe executor. The worker's first deliverable is
  `docs/m3-plan.md` only; implementation starts after Levon approves it.
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

## Milestones

From `probeboard-docs/en/08-plan.md`. Social login is an extension of Epic A
added between M1 and M2; it is not in the thesis acceptance criteria.

| Milestone | Name                   | Status                | Plan                                         | Verification                             |
| --------- | ---------------------- | --------------------- | -------------------------------------------- | ---------------------------------------- |
| M0        | Skeleton               | done                  | —                                            | [m0-verification.md](m0-verification.md) |
| M1        | Accounts               | done                  | [m1-plan.md](m1-plan.md)                     | [m1-verification.md](m1-verification.md) |
| —         | Social login           | code done; F2–F5 open | [social-login-plan.md](social-login-plan.md) | stub only — F3 pending                   |
| M2        | Registration           | done                  | [m2-plan.md](m2-plan.md)                     | [m2-verification.md](m2-verification.md) |
| M3        | Probe executor         | next — plan           | —                                            | —                                        |
| M4        | Scheduler              | not started           | —                                            | —                                        |
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

| Source         | Item                                                                                                                                                                                                             | Kind    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| #18            | Drift test reads routes from decorator metadata rather than the running application. Judgement call — reply with a decision or fix it.                                                                           | decide  |
| #37            | The SSRF blocklist is hand-maintained, so an IANA change needs a code change. Codex asked for a generated classifier; pushed back as out of scope. Decide whether to generate it from the registries before M10. | decide  |
| #38            | No per-user cap on service count: only `ENDPOINT_QUOTA_PER_USER` exists, and `ServicesService.createExplicit` checks nothing. B-8 names only endpoints, so this is a gap in resource limits, not in the story.   | decide  |
| process        | #18–#23, #29 and #34 merged before Codex finished reviewing. See the merge gate above.                                                                                                                           | process |
| #24 validation | Workers missed Codex's no-findings signal: a 👍 reaction on the PR, not a review. `CLAUDE.md` now says where to look.                                                                                            | process |

Closed since last update: the two #18 fixes and F1 (#27); seven unanswered
Codex threads, the missing verification record, `AggregateError` causes, the
broken OpenAPI `$ref`, header/tag replace atomicity, `http/` consolidation and
the SSRF registry audit (#37); the tag-filter hang (#38).
