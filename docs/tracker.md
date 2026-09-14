# Tracker

Status of record for probeboard work. The orchestrator session updates it after
validating a worker's report; workers read it and propose changes in their
report rather than editing it, so two chats never edit it at once.

Last updated: 2026-09-14, by the orchestrator, after validating #23 and #24.

## Now

- **Ready to merge:** [#24](https://github.com/Levon0Asatryan/probeboard-api/pull/24)
  — fixes two defects #23 merged with. Validated; CI green; Codex 👍 on the
  head commit.
- **Next:** M2 — Registration. The worker's first deliverable is
  `docs/m2-plan.md` only; implementation starts after approval.
- **Merge gate:** four PRs in a row (#18, #19, #21, #23) merged before Codex
  finished. #23's unreviewed last commit shipped an open redirect. Merge only
  after Codex has reviewed or 👍'd the **head SHA** and the orchestrator has
  validated.

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

| Milestone | Name                   | Status               | Plan                                         | Verification                             |
| --------- | ---------------------- | -------------------- | -------------------------------------------- | ---------------------------------------- |
| M0        | Skeleton               | done                 | —                                            | [m0-verification.md](m0-verification.md) |
| M1        | Accounts               | done                 | [m1-plan.md](m1-plan.md)                     | [m1-verification.md](m1-verification.md) |
| —         | Social login           | done once #24 merges | [social-login-plan.md](social-login-plan.md) | stub only; real providers deferred       |
| M2        | Registration           | next — plan          | —                                            | —                                        |
| M3        | Probe executor         | not started          | —                                            | —                                        |
| M4        | Scheduler              | not started          | —                                            | —                                        |
| M5        | Storage                | not started          | —                                            | —                                        |
| M6        | Incidents              | not started          | —                                            | —                                        |
| M7        | Alerting               | not started          | —                                            | —                                        |
| M8        | Statistics             | not started          | —                                            | —                                        |
| M9        | Web (`probeboard-web`) | not started          | —                                            | —                                        |
| M10       | Evaluation             | not started          | —                                            | —                                        |

M2 → M6 is a dependency chain; run it in order.

## Social login

| Step | Content                                                        | PR                                                                                                                               | Status   |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1    | Schema, repositories, password-less account, §8 changes        | [#16](https://github.com/Levon0Asatryan/probeboard-api/pull/16)                                                                  | merged   |
| 2    | Linking policy (CVE-2026-53516 as a test)                      | [#17](https://github.com/Levon0Asatryan/probeboard-api/pull/17)                                                                  | merged   |
| 3    | Provider strategies, local identity provider; review fixes     | [#19](https://github.com/Levon0Asatryan/probeboard-api/pull/19), [#21](https://github.com/Levon0Asatryan/probeboard-api/pull/21) | merged   |
| 4    | HTTP surface: start, callback, link, unlink, `http/oauth.http` | [#23](https://github.com/Levon0Asatryan/probeboard-api/pull/23), [#24](https://github.com/Levon0Asatryan/probeboard-api/pull/24) | #24 open |
| 5    | Config, callback URLs out of logs, identities on `/me`         | landed in [#23](https://github.com/Levon0Asatryan/probeboard-api/pull/23)                                                        | merged   |

Security properties added by #23/#24, each proved by removing its guard:
provider-bound single-use state (OAuth mix-up), redirect URI from config never
`Host`, `returnTo` parsed and re-checked after dot-segment resolution, link
re-checks the originating session under a users-then-sessions lock so
`logout-all` cannot be raced, authorization code absent from every log line.

## Other merged work

| PR                                                              | What                                      |
| --------------------------------------------------------------- | ----------------------------------------- |
| [#13](https://github.com/Levon0Asatryan/probeboard-api/pull/13) | Reproducible build from a clean tree      |
| [#14](https://github.com/Levon0Asatryan/probeboard-api/pull/14) | `http/` request collection                |
| [#15](https://github.com/Levon0Asatryan/probeboard-api/pull/15) | Social login plan                         |
| [#18](https://github.com/Levon0Asatryan/probeboard-api/pull/18) | `openapi.yaml` generated, Swagger UI      |
| [#20](https://github.com/Levon0Asatryan/probeboard-api/pull/20) | Workflow rules, tracker, handoff template |
| [#22](https://github.com/Levon0Asatryan/probeboard-api/pull/22) | Tracker after social login Step A         |

## Follow-ups

Items found while validating, not yet scheduled.

| Source         | Item                                                                                                                                                                                                               | Kind    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| #18–#23        | Merged before Codex finished reviewing. See the merge gate above.                                                                                                                                                  | process |
| #18            | `POST /v1/auth/password` omits the 413 the body limit produces; register and login document it. Scheduled with M2.                                                                                                 | fix     |
| #18            | `openapi:check` reports any read failure as "missing", discarding the cause; only `ENOENT` means missing. Scheduled with M2.                                                                                       | fix     |
| #18            | Drift test reads routes from decorator metadata rather than the running application. Judgement call — reply with a decision or fix it.                                                                             | decide  |
| plan           | Docs repo: ADR-0010 (linking policy), ADR-0011 (cookie and domain), stories A-7 and A-8, a milestone-table row. `social-login-plan.md` §11.                                                                        | docs    |
| plan           | Deploy web and api under one registrable domain, decided before M9, or `SameSite=Lax` breaks the SPA. `social-login-plan.md` §10.                                                                                  | decide  |
| decision       | Register a Google OAuth client and a GitHub OAuth app (callback `http://127.0.0.1:3000/v1/auth/oauth/<provider>/callback`) and verify social login against the real providers. Deferred by Levon to final testing. | verify  |
| #24 validation | Workers missed Codex's no-findings signal: a 👍 reaction on the PR, not a review. `CLAUDE.md` now says where to look.                                                                                              | process |

Closed since last update: #21 body limit to config and token-cap test (#23),
flaky race test — app vs database clock (#23), `WEB_BASE_URL` https rule (#23).
