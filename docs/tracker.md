# Tracker

Status of record for probeboard work. The orchestrator session updates it after
validating a worker's report; workers read it and propose changes in their
report rather than editing it, so two chats never edit it at once.

Last updated: 2026-09-13, by the orchestrator, after validating Step A (#21).

## Now

- **In progress:** social login PR 4 (HTTP surface) — worker resumes Step B from
  `origin/main`. Step B also carries the two unanswered #21 findings (below).
- **Merge gate:** three PRs in a row (#18, #19, #21) were merged before Codex
  finished reviewing, each leaving threads unanswered. Codex posts a few
  minutes after each push. Wait for its review, and for the orchestrator's
  validation, before merging.

- **Decided (2026-09-13):**
  - Worker chats run **one at a time** in this checkout; no parallel
    worktrees. The backend is a dependency chain anyway.
  - Branch protection on `main` stays **off**. `CLAUDE.md` forbids chats from
    pushing to it; the orchestrator checks for direct pushes when validating.
  - Social login is verified against the **local test provider** until the
    end. Real Google and GitHub OAuth apps are registered at final testing —
    tracked as a follow-up below.

## Milestones

From `probeboard-docs/en/08-plan.md`. Social login is an extension of Epic A
added between M1 and M2; it is not in the thesis acceptance criteria.

| Milestone | Name                   | Status              | Plan                                         | Verification                             |
| --------- | ---------------------- | ------------------- | -------------------------------------------- | ---------------------------------------- |
| M0        | Skeleton               | done                | —                                            | [m0-verification.md](m0-verification.md) |
| M1        | Accounts               | done                | [m1-plan.md](m1-plan.md)                     | [m1-verification.md](m1-verification.md) |
| —         | Social login           | in progress, 3 of 5 | [social-login-plan.md](social-login-plan.md) | —                                        |
| M2        | Registration           | not started         | —                                            | —                                        |
| M3        | Probe executor         | not started         | —                                            | —                                        |
| M4        | Scheduler              | not started         | —                                            | —                                        |
| M5        | Storage                | not started         | —                                            | —                                        |
| M6        | Incidents              | not started         | —                                            | —                                        |
| M7        | Alerting               | not started         | —                                            | —                                        |
| M8        | Statistics             | not started         | —                                            | —                                        |
| M9        | Web (`probeboard-web`) | not started         | —                                            | —                                        |
| M10       | Evaluation             | not started         | —                                            | —                                        |

M2 → M6 is a dependency chain; run it in order.

## Social login

| Step | Content                                                        | PR                                                                                                                               | Status      |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1    | Schema, repositories, password-less account                    | [#16](https://github.com/Levon0Asatryan/probeboard-api/pull/16)                                                                  | merged      |
| 2    | Linking policy (CVE-2026-53516 as a test)                      | [#17](https://github.com/Levon0Asatryan/probeboard-api/pull/17)                                                                  | merged      |
| 3    | Provider strategies, local identity provider; review fixes     | [#19](https://github.com/Levon0Asatryan/probeboard-api/pull/19), [#21](https://github.com/Levon0Asatryan/probeboard-api/pull/21) | merged      |
| 4    | HTTP surface: start, callback, link, unlink, `http/oauth.http` | —                                                                                                                                | in progress |
| 5    | Config, callback URLs out of logs, identities on `/me`         | —                                                                                                                                | not started |

## Other merged work

| PR                                                              | What                                      |
| --------------------------------------------------------------- | ----------------------------------------- |
| [#13](https://github.com/Levon0Asatryan/probeboard-api/pull/13) | Reproducible build from a clean tree      |
| [#14](https://github.com/Levon0Asatryan/probeboard-api/pull/14) | `http/` request collection                |
| [#15](https://github.com/Levon0Asatryan/probeboard-api/pull/15) | Social login plan                         |
| [#18](https://github.com/Levon0Asatryan/probeboard-api/pull/18) | `openapi.yaml` generated, Swagger UI      |
| [#20](https://github.com/Levon0Asatryan/probeboard-api/pull/20) | Workflow rules, tracker, handoff template |

## Follow-ups

Items found while validating, not yet scheduled.

| Source      | Item                                                                                                                                                                                                               | Kind        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| #18 #19 #21 | Merged before Codex finished reviewing, threads left unanswered. See the merge gate above.                                                                                                                         | process     |
| #18         | `POST /v1/auth/password` omits the 413 the body limit produces; register and login document it.                                                                                                                    | fix         |
| #18         | `openapi:check` reports any read failure as "missing", discarding the cause; only `ENOENT` means missing.                                                                                                          | fix         |
| #18         | Drift test reads routes from decorator metadata rather than the running application. Judgement call — reply with a decision or fix it.                                                                             | decide      |
| plan        | Docs repo: ADR-0010 (linking policy), ADR-0011 (cookie and domain), stories A-7 and A-8, a milestone-table row. `social-login-plan.md` §11.                                                                        | docs        |
| plan        | Deploy web and api under one registrable domain, decided before M9, or `SameSite=Lax` breaks the SPA. `social-login-plan.md` §10.                                                                                  | decide      |
| decision    | Register a Google OAuth client and a GitHub OAuth app (callback `http://127.0.0.1:3000/v1/auth/oauth/<provider>/callback`) and verify social login against the real providers. Deferred by Levon to final testing. | verify      |
| #21         | GitHub body limit (`maxResponseBytes`, default 1 MiB) is a strategy option, not validated config. Folded into Step B.                                                                                              | fix         |
| #21         | Token-endpoint body cap has no test that fails without it; only the `/user` cap was proved. Folded into Step B.                                                                                                    | test        |
| #21 report  | `oauth-identity.service.int.test.ts` concurrency test flaked once locally under load, passed on retry. A flaky race test can mask a real race: identify the test and reproduce or explain.                         | investigate |
