# probeboard-api — working conventions

Read before adding files. `AGENTS.md` holds the review rules (what to flag on a
pull request); this holds the conventions to follow while writing.

## File and folder structure

Two rules, applied at two different levels. Mixing them up is the mistake this
section exists to prevent.

### Level 1 — feature modules, not technical layers

Inside `api/` and `worker/`, group by **feature**: `auth/`, `health/`,
`monitors/`. Never `controllers/`, `services/`, `repositories/` at this level —
that scatters one feature across four folders so every change touches all of
them, and the tree stops saying what the system does.

Deleting a feature should be deleting one folder.

### Level 2 — inside a module, a folder per role

This is the standard NestJS module layout. `nest g resource` scaffolds
`<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts` at the module
root plus `dto/` and `entities/`; the framework's own `19-auth-jwt` sample adds
`decorators/`; Novu's production `auth` module uses `dtos/`, `services/` and
`e2e/`.

```
api/auth/
  auth.module.ts            the module's own three files stay at the root
  auth.controller.ts
  auth.service.ts
  dto/                      request shapes, one per file
    register.dto.ts
    login.dto.ts
    change-password.dto.ts
    fields.ts               pieces shared between them
  guards/
    session.guard.ts
  decorators/
    current-user.decorator.ts
  services/                 every service except the module's own
    password.service.ts
    rate-limit.service.ts
    auth-maintenance.service.ts
  repositories/
    session.repository.ts
    auth-attempt.repository.ts
  utils/                    pure helpers with no framework role
    session-token.ts
    session-cookie.ts
    client-ip.ts
  e2e/                      tests exercising the module end to end
    auth-http.int.test.ts
    auth-flow.int.test.ts
    change-password.int.test.ts
```

Use the role folder even when it holds a single file. Consistency is what makes
the tree readable — a reader looking for a guard should never have to check
whether this module happened to have only one.

Add `strategies/`, `interfaces/`, `entities/` or `constants.ts` when they
appear; do not invent new role names when a NestJS one fits.

### Naming

`<subject>.<role>.ts`, where role is a NestJS construct: `module`, `controller`,
`service`, `repository`, `guard`, `decorator`, `pipe`, `filter`, `interceptor`,
`middleware`, `strategy`, `dto`.

Pure helpers with no framework role take a plain kebab-case name —
`session-token.ts`, `client-ip.ts`.

Keep the subject prefix even inside a folder that repeats it:
`repositories/session.repository.ts` stays findable by fuzzy search,
`repositories/repository.ts` does not.

### Tests

- `<file>.test.ts` beside the file it tests — unit, no I/O.
- `<file>.int.test.ts` for anything needing PostgreSQL. Separate vitest config,
  separate CI job.
- Tests that span the whole module go in `e2e/`, named
  `<subject>.int.test.ts`, because they belong to no single file.

### Requests

`http/` holds a runnable request collection: one `.http` file per module, plus
the `.env` those files read. **An endpoint is not finished until its request is
in there**, in the same change — a collection that lags the code is worse than
none, because a missing request reads as "this endpoint does not exist".

A new module gets a new `<module>.http`. Include the failure cases worth having
at hand, not only the happy path. Anything needing repetition or concurrency —
rate limits, caps — stays a shell snippet in a comment, because no interactive
client produces it.

### Top level

Only the deployment layers: `core/` (shared by both processes), `api/`,
`worker/`, `testing/`. `core` depends on nothing; `api` and `worker` depend on
`core` and never on each other. Enforced by `src/architecture.test.ts`.

### When files move

Update the coverage exclusion paths in `vitest.config.mts`. They are literal
paths, so a move silently re-admits an excluded file and the threshold then
fails for a reason unrelated to the change.

## Other conventions

- **Configuration** is injected through `APP_CONFIG`, never read from a
  module-level singleton. A parameter decorator cannot read injected config, so
  policy that depends on configuration belongs in a service.
- **Logging** uses a static message with variable data in fields. Credentials
  and monitor request headers are redacted.
- **Errors** carry a stable machine-readable `code`. Internal detail goes to the
  log, never to a response.
- **Every guard, filter or check ships with a test that proves it fails** when
  it should. This repository has shipped three that silently did nothing.
