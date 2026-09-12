# probeboard-api — working conventions

Read before adding files. `AGENTS.md` holds the review rules (what to flag on a
pull request); this holds the conventions to follow while writing.

## File and folder structure

The pattern is **feature slices, not technical layers** — the consensus for
NestJS and the point of vertical-slice/"screaming architecture": a folder tree
should say what the system does, not what framework it uses. A layered tree
(`controllers/`, `services/`, `repositories/`) scatters one feature across four
folders, and every change touches all of them.

### The rules

1. **Top level is the deployment layer**, and only these:
   `core/` (shared), `api/`, `worker/`, `testing/`.
   `core` depends on nothing; `api` and `worker` depend on `core` and never on
   each other. Enforced by `src/architecture.test.ts`.

2. **Inside a layer, group by feature slice** — `auth/`, `health/`, `users/` —
   never by technical type. Deleting a feature should be deleting a folder.

3. **Inside a slice, subfolder only when two or more files share a purpose.**
   A single file stays at the slice root. A folder holding one file is noise,
   and it hides the file rather than organising it.

4. **Everything that touches an HTTP request or response lives in `http/`** —
   controller, request schemas, guards, decorators, cookie handling, address
   extraction. "How is a request handled?" must be answerable from one folder.
   A guard sitting beside a repository is the mistake this rule exists to stop.

5. **Data access lives with its subject**, named `<subject>.repository.ts`, and
   stays out of `http/`.

6. **Split a folder when it passes roughly eight source files** (tests not
   counted). Earlier if clear groupings already exist.

7. **Integration tests that span a whole slice go in `flows/`**, because they
   belong to no single part of it. Tests of one file sit beside that file.

8. **Naming**: `<subject>.<role>.ts` where the role is a NestJS construct —
   `module`, `controller`, `service`, `repository`, `guard`, `decorator`,
   `pipe`, `filter`. Pure helpers with no framework role take a plain
   descriptive name (`session-token.ts`, `client-ip.ts`). Keep the subject
   prefix even inside a folder that repeats it: `sessions/session.repository.ts`
   stays findable by fuzzy search, `sessions/repository.ts` does not.

9. **Tests**: `<file>.test.ts` for unit, `<file>.int.test.ts` for anything
   needing PostgreSQL. The integration suite has its own config and CI job.

### Worked example

```
api/auth/
  auth.module.ts                  entry point
  auth.service.ts                 register, log in, change password
  password.service.ts             single file, so no folder
  auth-maintenance.service.ts     single file, so no folder
  http/                           everything touching a request
    auth.controller.ts
    auth.schemas.ts
    session.guard.ts
    current-user.decorator.ts
    session-cookie.ts
    client-ip.ts
  sessions/                       what a session is, and where it lives
    session-token.ts
    session.repository.ts
  rate-limiting/
    rate-limit.service.ts
    rate-limit.repository.ts
  flows/                          integration tests spanning the slice
```

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
