# Tracker

Status of record for probeboard work. The orchestrator session updates it after
validating a worker's report; workers read it and propose changes in their
report rather than editing it, so two chats never edit it at once.

Last updated: 2026-09-13, by the orchestrator.

## Now

- **In review:** [#19](https://github.com/Levon0Asatryan/probeboard-api/pull/19)
  Social login PR 3, provider strategies. CI green on all five jobs; no review
  threads yet (Codex may still post).
- **Next handoff:** social login PR 4 (HTTP surface) and PR 5 (config, log
  sanitising, identities on `/me`), then the #18 follow-ups below.
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
| —         | Social login           | in progress, 2 of 5 | [social-login-plan.md](social-login-plan.md) | —                                        |
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

| Step | Content                                                        | PR                                                              | Status      |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| 1    | Schema, repositories, password-less account                    | [#16](https://github.com/Levon0Asatryan/probeboard-api/pull/16) | merged      |
| 2    | Linking policy (CVE-2026-53516 as a test)                      | [#17](https://github.com/Levon0Asatryan/probeboard-api/pull/17) | merged      |
| 3    | Provider strategies, local identity provider                   | [#19](https://github.com/Levon0Asatryan/probeboard-api/pull/19) | in review   |
| 4    | HTTP surface: start, callback, link, unlink, `http/oauth.http` | —                                                               | not started |
| 5    | Config, callback URLs out of logs, identities on `/me`         | —                                                               | not started |

## Other merged work

| PR                                                              | What                                 |
| --------------------------------------------------------------- | ------------------------------------ |
| [#13](https://github.com/Levon0Asatryan/probeboard-api/pull/13) | Reproducible build from a clean tree |
| [#14](https://github.com/Levon0Asatryan/probeboard-api/pull/14) | `http/` request collection           |
| [#15](https://github.com/Levon0Asatryan/probeboard-api/pull/15) | Social login plan                    |
| [#18](https://github.com/Levon0Asatryan/probeboard-api/pull/18) | `openapi.yaml` generated, Swagger UI |

## Follow-ups

Items found while validating, not yet scheduled.

| Source   | Item                                                                                                                                                                                                               | Kind    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| #18      | Merged with three review threads unanswered (below). The orchestrator now validates before merge.                                                                                                                  | process |
| #18      | `POST /v1/auth/password` omits the 413 the body limit produces; register and login document it.                                                                                                                    | fix     |
| #18      | `openapi:check` reports any read failure as "missing", discarding the cause; only `ENOENT` means missing.                                                                                                          | fix     |
| #18      | Drift test reads routes from decorator metadata rather than the running application. Judgement call — reply with a decision or fix it.                                                                             | decide  |
| plan     | Docs repo: ADR-0010 (linking policy), ADR-0011 (cookie and domain), stories A-7 and A-8, a milestone-table row. `social-login-plan.md` §11.                                                                        | docs    |
| plan     | Deploy web and api under one registrable domain, decided before M9, or `SameSite=Lax` breaks the SPA. `social-login-plan.md` §10.                                                                                  | decide  |
| decision | Register a Google OAuth client and a GitHub OAuth app (callback `http://127.0.0.1:3000/v1/auth/oauth/<provider>/callback`) and verify social login against the real providers. Deferred by Levon to final testing. | verify  |
