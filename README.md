# probeboard-api

Backend for **probeboard**, an API monitoring dashboard. This repository holds
**two processes built from one codebase**:

| Process    | Entrypoint           | Responsibility                                                                                                   |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **api**    | `src/api/main.ts`    | Serves the REST API. Never probes anything.                                                                      |
| **worker** | `src/worker/main.ts` | Does the monitoring: schedules probes, executes them, rolls up statistics, opens incidents, sends notifications. |

They are deployed as **separate containers and scaled independently** — one api,
N workers — but share this repository because they share the configuration
schema, database types, migrations, failure taxonomy and domain logic. The
reasoning, including why a published SDK across two repositories was rejected,
is in
[ADR-0006](https://github.com/Levon0Asatryan/probeboard-docs/blob/main/en/adr/0006-one-repo-split-ready.md).

Design documents live in
[probeboard-docs](https://github.com/Levon0Asatryan/probeboard-docs); this
README covers only how to run and extend this repository.

---

## Quick start

Requires Docker and Node 22+.

```bash
cp .env.example .env
docker compose up -d --build     # postgres + migrations + api + worker
curl localhost:3000/healthz      # {"status":"ok"}
curl localhost:3000/readyz       # {"status":"ok","database":"ok"}
```

Run several workers, which is what the scheduling design exists to support:

```bash
docker compose up -d --scale worker=3
```

Tear down, including the database volume:

```bash
docker compose down -v
```

## Local development

Run Postgres in Docker and the processes on the host, so restarts are instant:

```bash
docker compose up -d postgres
npm install
npm run migrate
npm run dev:api        # http://localhost:3000
npm run dev:worker     # separate terminal
```

### Scripts

| Script                               | Does                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `npm run dev:api` / `dev:worker`     | Run with reload, loading `.env`                          |
| `npm run build`                      | Compile to `dist/`, including the `.sql` migration files |
| `npm run start:api` / `start:worker` | Run the compiled output                                  |
| `npm run migrate` / `migrate:down`   | Apply / roll back one migration                          |
| `npm test`                           | Unit tests                                               |
| `npm run typecheck`                  | Types only, no emit                                      |

## Configuration

Every variable is declared in [`src/core/config.ts`](src/core/config.ts) and
validated by a zod schema **before anything else is constructed**. An invalid or
missing value stops the process at boot with a message naming every offending
key, rather than surfacing as a confusing failure later.

`DATABASE_URL` is the only variable without a default. See
[`.env.example`](.env.example) for the full list.

Two worth understanding:

- **`WORKER_ID`** must be unique per running instance. It is written to
  `leased_by` when a worker claims work, so an ambiguous value makes it
  impossible to tell which worker holds a claim or which one died. It defaults
  to `<hostname>-<pid>`; a pid-only default would give every container the same
  identity, because every container runs its process as PID 1.
- **`SSRF_GUARD_ENABLED`** must stay `true` outside tests. Users supply the URLs
  that this server then fetches, which is a textbook SSRF primitive.

## Database

PostgreSQL is the **only** infrastructure dependency. Leases, aggregates and the
notification outbox all live in it, so there is one transaction boundary and one
backup, and the whole system starts with one command.

Access is through [Kysely](https://kysely.dev), a typed query builder — **not an
ORM**. The core mechanisms of this system are raw SQL that ORMs abstract away
badly: `SELECT … FOR UPDATE SKIP LOCKED` for claiming work, `ON CONFLICT DO
UPDATE` with array-subscript increment for aggregates, and declarative
partitioning for retention.

### Migrations

Plain `.sql` files in [`src/core/db/migrations/`](src/core/db/migrations), applied in
filename order, each inside one transaction, recorded in `schema_migrations`.
A failure rolls that migration back and stops the run rather than applying later
migrations onto a half-built schema.

Adding one:

```bash
# create both halves; the down file is not optional
touch src/core/db/migrations/0002_users.up.sql src/core/db/migrations/0002_users.down.sql
npm run migrate
```

Then update the types in [`src/core/db/schema.ts`](src/core/db/schema.ts) to match — the
migrations are the source of truth, the types follow them.

## Health endpoints

| Endpoint       | Meaning                                                   | Fails when                          |
| -------------- | --------------------------------------------------------- | ----------------------------------- |
| `GET /healthz` | Liveness — the process is running. Touches no dependency. | the process is dead                 |
| `GET /readyz`  | Readiness — it can serve traffic. Runs `SELECT 1`.        | the database is unreachable → `503` |

They are genuinely different: a load balancer needs liveness, a deployment needs
readiness. A readiness check that cannot fail is decoration, so the failure path
is tested.

## Layout and the dependency rule

```
src/
  core/                     shared by both processes
    config/                   environment schema + loader, validated at boot
    errors/                   error types, description, HTTP mapping
    logging/                  redaction list + pino options
    db/                       pool, Kysely, types, module
      migrator/                 registry, file discovery, runner, CLI
      migrations/               *.up.sql / *.down.sql
  api/                      api only
    main.ts                   entrypoint
    bootstrap.ts              prefix, filters, body limit, shutdown hooks
    common/
      filters/                  one response shape for every failure
      pipes/                    zod validation at the trust boundary
      controllers/              JSON catch-all for unmatched routes
    health/                   liveness and readiness
  worker/                   worker only
    main.ts                   entrypoint
    lifecycle/                keep-alive and graceful shutdown
  architecture.test.ts      enforces the rule below
```

```
        core        depends on nothing else in src/
        /  \
      api  worker   may depend on core, never on each other
```

This is **checked, not merely documented**:
[`src/architecture.test.ts`](src/architecture.test.ts) parses every relative
import — including bare side-effect imports and `require()`, not only `from`
clauses — and fails on any edge that breaks the rule. An unenforced convention
decays, and splitting this repository later must stay a directory move rather
than an untangling exercise
([ADR-0006](https://github.com/Levon0Asatryan/probeboard-docs/blob/main/en/adr/0006-one-repo-split-ready.md)).

Structure follows two rules, documented with their evidence in
[CLAUDE.md](CLAUDE.md): **feature modules** at the `api/` level, and **a folder
per role inside a module** — the layout `nest g resource` scaffolds. Role
folders are used even when they hold one file, because consistency is what
makes the tree readable.

Planned modules, in milestone order: `worker/probing/` (M3),
`worker/scheduler/` (M4), `worker/rollup/` (M5), `worker/incidents/` (M6),
`worker/notifications/` (M7), `core/stats/` (M8, shared — the worker writes
buckets, the api interpolates percentiles from them).

`probing/` will depend on nothing but `core` — keeping the probe executor a
pure function is what makes it testable against a local server that hangs,
resets, or serves a bad certificate.

## HTTP surface

Everything is served under **`/v1`**, except the health endpoints, which an
orchestrator's probe should not have to version.

Every failure returns the same shape, and never internal detail:

```json
{ "code": "NOT_FOUND", "message": "route not found" }
```

Unmatched routes included — otherwise Express answers with an HTML page, which
is the wrong content type for a JSON API and carries no code a client can
branch on.

Request bodies are capped at `API_BODY_LIMIT` (default 64kb) and rejected with
`413` beyond it.

## Conventions

- **Logging** is structured: the message is a static string, variable data goes
  in fields. Credentials and monitor request headers are redacted, since a
  monitor's headers routinely carry API keys.
- **Errors** are described through
  [`describeError()`](src/core/errors.ts), because Node reports connection
  failures as `AggregateError`, whose own `.message` is empty — reading
  `err.message` naively loses the cause entirely.
- **The database pool must keep its `error` listener.** pg emits `error` on the
  pool when an _idle_ connection dies, and Node escalates an unhandled `error`
  event into a fatal exception — so removing it makes every database restart
  terminate the api and every worker at once. Covered by a test.
- **Failures are never swallowed.** Detail goes to the log; responses carry a
  stable machine-readable `code` and nothing internal.
- **Tests**: every bug fix ships with the test that fails without it. No focused
  or skipped tests get committed.

## Quality gates

`pre-commit` formats and lints staged files, then typechecks and tests the
whole tree. `pre-push` runs `npm run verify`. CI repeats all of it on every
pull request, plus migrations against a real PostgreSQL and the full container
stack.

Coverage thresholds are a floor that cannot silently slip, not an aspiration.
Files excluded from coverage each carry the reason in
[`vitest.config.mts`](vitest.config.mts) — generally because they are covered
by the CI stack or migrations job instead.

## Status

**M0 complete** — skeleton, config validation, database, migrations, health
endpoints, both entrypoints, containerised stack, lint/format/hooks/CI,
versioned HTTP surface with uniform error handling.

Next: **M1 — accounts**. See
[chapter 8](https://github.com/Levon0Asatryan/probeboard-docs/blob/main/en/08-plan.md).
