# HTTP request collection

Every endpoint the API serves, as runnable requests. One file per module, named
after the module it exercises, so the collection stays findable the same way
the source does.

| File                                   | Module             | Covers                                                                                                                                                                               |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [auth.http](auth.http)                 | `api/auth`         | register, login, me, change password, logout, logout-all                                                                                                                             |
| [oauth.http](oauth.http)               | `api/auth`         | sign in with Google/GitHub, link, unlink, identities                                                                                                                                 |
| [health.http](health.http)             | `api/health`       | liveness, readiness                                                                                                                                                                  |
| [common.http](common.http)             | `api/common`       | not-found fallback, error shapes, validation, version prefix, limits                                                                                                                 |
| [openapi.http](openapi.http)           | `api/openapi`      | the Swagger UI page, the document it renders from                                                                                                                                    |
| [registration.http](registration.http) | `api/registration` | services: create (explicit and B-3 implicit), list, get, update, delete, SSRF rejections; endpoints: create, list, get, update, delete, pause, resume, duplicate/interval rejections |

A module added later gets a file here in the same pull request. A file that
does not list every route its module serves is worse than no file, because the
gap reads as "this endpoint does not exist".

## Running them

Install the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
extension — it is in `.vscode/extensions.json`, so VSCode offers it — then
click **Send Request** above any request.

Start the stack first:

```sh
docker compose up -d --scale worker=2
```

### If every request comes back `404`

Check whether something else on your machine already holds port 3000:

```sh
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Two listeners means the host port is shared, and your requests may be answered
by that other process rather than by the container — the container can be
perfectly healthy while every request from the host misses it.

**Do not change `docker-compose.yml` for this.** Which ports are free is a
property of your machine, not of the project. Map a free host port with a local
override file instead, and point `baseUrl` in `.env` at it:

```yaml
# probeboard-port.yml, kept outside the repo
services:
  api:
    ports: !override
      - '3100:3000'
```

`!override` is load-bearing, not decoration. Compose merges `ports` as a
_unique sequence_: entries whose published port differs are **appended**, not
replaced, so a plain `ports:` list leaves the base `3000:3000` in place and
publishes both. The container then still binds the port you were trying to get
away from, and the workaround silently does nothing:

```text
probeboard-api-1   0.0.0.0:3000->3000/tcp, 0.0.0.0:3100->3000/tcp
```

`!override` replaces the whole list instead of merging into it. (`!reset []`
clears a key outright; it needs Compose 2.24+, as does `!override`, and
`docker compose version` will tell you.)

```sh
docker compose -f docker-compose.yml -f /path/to/probeboard-port.yml up -d api
```

Check it took effect — exactly one published port, and not 3000:

```sh
docker ps --filter name=probeboard-api --format '{{.Names}}\t{{.Ports}}'
```

`auth.http` is written to be run top to bottom the first time: the first
request creates the account every later request uses, and the login puts the
session cookie in the extension's cookie jar, so the authenticated requests
carry no header of their own. After that, any single request can be re-run on
its own.

## The environment file

`.env` in this folder, read as `{{$dotenv name}}`. Keeping it beside the
requests rather than in `.vscode/settings.json` means the collection is
self-contained: it travels with the folder, and a change to it shows up in
review as a change to the requests.

It is checked in — `.gitignore` carries an exception for this one path —
because every value is a local development fixture pointing at a stack you
started yourself. **Never put a real credential in it.** `.env.local` stays
ignored and is the place for anything that must not be committed.

To point the collection at something other than the local stack, change
`baseUrl`.

## The generated spec

[`../openapi.yaml`](../openapi.yaml) describes the same endpoints with exact
types, for client generation and for the frontend. These files and that one
answer different questions: the spec says what the contract is, these say what
to send to see it. Both are checked — the spec against Nest's route metadata,
these against a running stack.

`docker compose up` also serves the spec as Swagger UI at
<http://127.0.0.1:3000/docs>.

## What is not here

**Anything that needs repetition or concurrency.** The rate limiter and the
session cap are counted over many requests, and the property worth checking is
that they hold when requests arrive _together_ — which no interactive client
produces. `common.http` carries those as shell commands in comments.

**Assertions.** These files are for looking at responses by hand while
developing. The behaviour they show is covered by the integration suite
(`npm run test:int`), which is what CI runs and what fails a pull request; a
request collection that nobody executes automatically cannot be relied on to
notice a regression. The manual passes are recorded in
[../docs/](../docs/), one verification record per milestone.
