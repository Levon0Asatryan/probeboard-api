# probeboard-api documentation

Documentation that belongs **with the code**: it would go stale if the code
changed and nobody updated it, so it is reviewed in the same pull request as
the change that affects it.

| Document                                     | Covers                                                     |
| -------------------------------------------- | ---------------------------------------------------------- |
| [../README.md](../README.md)                 | Running, developing, configuring, the layout and its rules |
| [tracker.md](tracker.md)                     | Status of every milestone, PR and follow-up — read first   |
| [handoff-template.md](handoff-template.md)   | How work is handed to a worker chat and reported back      |
| [../openapi.yaml](../openapi.yaml)           | The API surface, generated from the zod schemas            |
| [m0-verification.md](m0-verification.md)     | What was executed to accept M0 and what it produced        |
| [m1-plan.md](m1-plan.md)                     | The investigation and plan M1 was built from               |
| [m1-verification.md](m1-verification.md)     | What was executed to accept M1 and what it produced        |
| [social-login-plan.md](social-login-plan.md) | Google and GitHub sign-in: investigation and plan          |

## What is not here

Design and thesis material lives in
[probeboard-docs](https://github.com/Levon0Asatryan/probeboard-docs), because it
would still be true if this backend were rewritten in another language.

| Looking for                                   | Go to            |
| --------------------------------------------- | ---------------- |
| Why probeboard exists, what is in scope       | chapters 1 and 5 |
| What "API health" means, the formulas         | chapter 3        |
| How other systems solve this                  | chapter 4        |
| User stories and acceptance criteria          | chapter 6        |
| Architecture: components, scheduling, storage | chapter 7        |
| What is built next                            | chapter 8        |
| Why a decision was made                       | `en/adr/`        |

The rule deciding which side a document goes on is
[ADR-0009](https://github.com/Levon0Asatryan/probeboard-docs/blob/main/en/adr/0009-docs-split.md).

## Adding a document here

Only if it answers _how_, for someone who has this repository checked out, and
would be wrong if the code changed without it. Reference material — API
endpoints, database schema — should be **generated** from the code rather than
written, so it cannot drift.

`openapi.yaml` is the worked example: `npm run openapi` builds it from the same
zod schemas the request pipeline validates against, CI fails if the committed
file is stale, and a test compares it against Nest's own route metadata in both
directions, so neither an undocumented endpoint nor a documented one that does
not exist can survive. `API_DOCS_ENABLED=true` serves the same document as
Swagger UI at `/docs`; `docker compose` sets it.
