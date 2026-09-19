## What this changes

<!-- Behaviour, not a file list. Two to five lines. -->

## Why

<!-- The requirement, story, plan section or issue this serves. -->

## Evidence

- [ ] `npm run verify` passes
- [ ] `npm run test:coverage` stays at or above 90%
- [ ] `npm run test:int` passes (needs `docker compose up -d postgres`)

**Guards proved by removal** — each check, guard or filter this adds, and the
test that fails when it is removed:

| guard removed | test that failed |
| ------------- | ---------------- |
|               |                  |

<!-- Delete the table if the PR adds no guard. -->

**Real run** (for an HTTP, migration or database change): the requests sent
against `docker compose up -d --build`, and what they returned.

## Kept in step

- [ ] New or changed endpoint: `openapi.yaml` regenerated (`npm run openapi`)
- [ ] New or changed endpoint: request added to `http/<module>.http`
- [ ] New migration: `src/core/db/types.ts` updated in the same change
- [ ] Commits split by logical change; tests travel with their code

## Not verified

<!-- What you could not check, and why. "Nothing" is a valid answer. -->
