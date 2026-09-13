# Social login (Google, GitHub) — investigation and implementation plan

Extends Epic A. Slots between M1 (accounts) and M2 (registration): it changes
the `users` table and the credential model, and doing that after monitors exist
means migrating rows that already matter.

Nothing here is implemented yet. This document is the argument for what to
build and why, written before the code so the decisions can be reviewed on
their merits rather than defended after the fact.

---

## 1. Scope

**In.** "Sign in with Google" and "Sign in with GitHub" as a way to obtain a
probeboard session; linking a provider to an existing password account from an
authenticated session; unlinking; creating a new probeboard account from a
provider identity.

**Out.** Using provider tokens to call provider APIs (we ask for identity and
nothing else). Provider-side authorization — no org/team membership checks, no
Google Workspace domain restriction. Single sign-out. SAML, LDAP, Apple, or any
provider whose only value here is a longer list. Using OAuth _outbound_ to probe
a customer's protected API — that is a separate M2 feature that happens to share
a spec, and conflating the two is how this gets confusing.

**Two new stories for the PRD** (docs repo, §6.4):

| ID  | Story                                              | Acceptance                                                                                                                        |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A-7 | As a visitor I sign in with Google or GitHub       | A session is issued. A first sign-in creates an account; a later one reaches the same account even if the provider email changed. |
| A-8 | As a user I link a provider to my existing account | Linking requires an authenticated session. Unlinking is refused when it would leave the account with no way to sign in.           |

---

## 2. Investigation

### 2.1 The two providers are not the same protocol

This is the first thing that shapes the design, and it is easy to miss because
both are called "OAuth login".

**Google is an OpenID Connect provider.** It publishes a discovery document at
`https://accounts.google.com/.well-known/openid-configuration`, and the token
response carries an **ID token** — a signed JWT asserting who the user is. The
authentication result is the ID token; no further call is needed. Google's own
documentation is explicit about the identifier: _"Don't use the `email` field as
a unique identifier for a user. Always use the `sub` field."_

**GitHub is a bare OAuth 2.0 authorization server.** There is no discovery
document, no ID token, no `sub`. An access token comes back and identity is
whatever `GET /user` and `GET /user/emails` say. OAuth 2.0 is an _authorization_
protocol; using it for authentication means the application, not the protocol,
is responsible for deciding what the token proves.

Three consequences:

1. Validation differs. Google's assertion is verified cryptographically —
   signature against the JWKS, `iss`, `aud`, `exp`, `nonce`. GitHub's is
   verified by the fact that the call to `api.github.com` was made over TLS with
   a token we just obtained ourselves.
2. GitHub needs a second and third HTTP call after the token exchange, each of
   which can fail, time out, or rate-limit. Those are failure paths the Google
   flow does not have.
3. Anti-replay differs. Google gets a `nonce` bound into the ID token. GitHub
   has nowhere to put one, so replay protection there rests entirely on PKCE and
   the single-use authorization code.

GitHub added PKCE support in July 2025 — `code_challenge`, `code_challenge_method`,
`code_verifier`, **S256 only**, and _"GitHub is not requiring PKCE for any
authentication flow at this time"_ but recommends it. That it is optional on
their side is irrelevant; we send it.

### 2.2 GitHub's token endpoint is non-standard in two ways that break clients

Both are worth writing down because both have produced real bugs in real
clients:

1. **It returns form-encoded by default.** `access_token=gho_…&scope=…&token_type=bearer`.
   JSON only if the request carries `Accept: application/json`.
2. **It returns errors with HTTP 200.** An expired or reused code produces
   `200 OK` with `error=bad_verification_code&error_description=…` in the body.
   RFC 6749 requires 4xx. A client that checks `response.ok` and then parses
   tokens sees success and reads `undefined` as the access token — this is
   [an open bug in the MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/issues/1342),
   not a hypothetical.

### 2.3 What the flow has to defend against

The catalogue, with the countermeasure each one forces. RFC 9700 (Best Current
Practice for OAuth 2.0 Security, January 2025) is the current baseline and it
tightened several of these from "should" to "must".

| Attack                                                                                                                                         | Countermeasure                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authorization code interception / injection** — an attacker who obtains a code redeems it, or injects their own code into a victim's session | **PKCE with S256**, mandated by RFC 9700 for _all_ client types including confidential server-side ones                                                                                     |
| **CSRF on the callback** — attacker completes a flow in the victim's browser                                                                   | **`state`**, unguessable, bound to the browser by a cookie, single-use                                                                                                                      |
| **Login CSRF** — attacker makes the victim silently sign in as _the attacker_, so the victim's subsequent work lands in the attacker's account | Same: `state` must have been issued to _this_ browser, so an attacker cannot post their own completed flow into it                                                                          |
| **ID token replay**                                                                                                                            | **`nonce`**, generated per attempt, compared against the `nonce` claim                                                                                                                      |
| **Mix-up attack** (a client talking to more than one authorization server is fooled into sending server A's code to server B)                  | RFC 9700 wants the `iss` response parameter (RFC 9207) or the ID token's `iss`. We get both, plus **a distinct redirect URI per provider**, which is the spec's own fallback countermeasure |
| **Open redirect** via a `returnTo` parameter                                                                                                   | Return targets are **paths only**, validated against an allow-list, stored server-side rather than round-tripped through the provider                                                       |
| **Session fixation** — an attacker's pre-set session cookie survives the login                                                                 | The callback always issues a **new** session; it never reuses or upgrades an existing cookie                                                                                                |
| **Token/code leakage** into logs, `Referer`, or error responses                                                                                | Codes and tokens never enter a log line or a response body; the redaction list is extended                                                                                                  |
| **Provider account identifier churn**                                                                                                          | See §2.5 — the hardest one                                                                                                                                                                  |
| **Account linking by email**                                                                                                                   | See §2.4 — the dangerous one                                                                                                                                                                |

### 2.4 Account linking by email is the vulnerability class here

If the callback finds no known provider identity, it must decide what to do with
an incoming email address. Matching it against `users.email` and signing the
person in is the obvious implementation and it is a documented account-takeover
primitive. Three independent instances:

**Better Auth, CVE-2026-53516 (High, CVSS 8.3, fixed in 1.6.11).** The attacker
registers with the victim's address by password. The row exists with
`emailVerified: false`. The victim later signs in with Google. The callback
auto-links because _Google_ says the address is verified — and the code _"never
read"_ the local row's own verification flag. Now one account carries the
attacker's password and the victim's Google identity, and the attacker has
permanent access. The advisory is explicit that turning on
`requireEmailVerification` does **not** mitigate it, because linking flips the
local row to verified. The fix added exactly one condition: refuse implicit
linking when the local row is unverified.

**Grafana, CVE-2023-3128 (Critical, CVSS 9.4).** Grafana identified Azure AD
accounts by the `email` claim, which on Azure AD is neither unique nor
immutable. With a multi-tenant app, anyone could mint a token carrying a
victim's address. Grafana's response is instructive: identification moved to the
immutable provider identifier, and email lookup survives only behind
`oauth_allow_insecure_email_lookup`, off by default and documented as lowering
security.

**Google Workspace domain re-registration** (Truffle Security, 2025). Buy a
defunct company's domain, recreate `employee@thatcompany.com`, and every SaaS
product that keyed on email hands over the old employee's account. `email_verified`
is `true` and `hd` matches — the claims cannot distinguish the new owner from
the old one.

The pattern across all three: **the email address is an attribute of an account,
not the identity of one.** Auth.js reaches the same conclusion by naming its
opt-in `allowDangerousEmailAccountLinking` and defaulting to the
`OAuthAccountNotLinked` error instead.

For probeboard the argument is short. `users.email_verified_at` is populated in
M7, when there is mail to verify with. Until then **every local row is
unverified**, which is precisely the state Better Auth's fix refuses to link
into. Implicit linking is therefore not merely risky here, it is the exact
published bug.

That only holds if the column keeps meaning one thing, and the first
implementation broke it. An account created through a provider was given an
`email_verified_at` from the provider's own assertion — so it satisfied a check
that exists to require evidence _independent_ of the provider, and with the
flag on, a second provider asserting the same address would attach itself.
That is the recycled-domain takeover above, reached from inside.

So the rule is narrower than "record what is true": **`users.email_verified_at`
means probeboard verified this address, and nothing else may write it.** The
provider's claim is not discarded, it is recorded where it is attributable to
the provider that made it, as `oauth_identities.provider_email_verified`. Two
different facts, two different columns; conflating them is the whole failure.

### 2.5 Provider identifiers are stable — with an asterisk each

**GitHub.** The numeric `id` is permanent. The `login` is not: changing your
username _releases the old one for anyone else to claim_. Storing `login` as the
key means a renamed account's handle can later belong to a different person, who
then signs into their predecessor's probeboard account. Key on `id`; treat
`login` as display text.

**Google.** `sub` is documented as unique and never reused. In practice it is
not perfectly stable: Truffle Security quotes a staff engineer at a large
consumer product reporting that _"the sub claim changes in about 0.04% of logins
from Log in with Google. For us, that's hundreds of users last week."_

That number deserves care rather than panic. At probeboard's scale it is
approximately never, and the failure mode of keying on `sub` is _"a user
occasionally has to link again"_ — recoverable, and visible. The failure mode of
keying on email is _"the wrong person is signed in"_ — silent, and not
recoverable. Key on `sub`, accept the churn, and make re-linking a supported
action rather than a support ticket.

### 2.6 Library choice

| Option                                                              | Assessment                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/passport` + `passport-google-oauth20` + `passport-github2` | The tutorial answer, and wrong here. `passport-github2` is a fork of an abandoned package and is itself inactive — no release in over a year. `passport-google-oauth20` authenticates via the userinfo endpoint rather than validating the ID token, which discards the assertion Google actually signed. Passport's session model also duplicates the one M1 already built.                            |
| Hand-rolled for both                                                | Roughly 400 lines including JWT signature verification, JWKS fetching and caching with rotation, and every validation step. Writing a JWT verifier for a thesis about monitoring is scope that argues against itself.                                                                                                                                                                                   |
| **`openid-client` v6 for both** (chosen)                            | Universal ESM, actively maintained by the author of `jose`, OpenID-certified. Google via `discovery()`; GitHub via the `Configuration` constructor with hand-written server metadata, which the library supports — it documents plain OAuth 2.0 as a first-class flow. Gives PKCE helpers, state checking, ID token validation and JWKS handling from one dependency. Version 6.8.8 at time of writing. |

`openid-client` is built on `oauth4webapi`, which does check for an `error`
member in a token response body even at HTTP 200 — the GitHub quirk of §2.2. We
will rely on that and **prove it with a test against a stub that returns exactly
that response**, rather than assume it. This repository has shipped three checks
that silently did nothing; a library's documented behaviour is not evidence
until it is observed failing correctly.

### 2.7 What we deliberately do not build

- **No storage of provider access tokens.** We need identity once, at sign-in.
  Keeping the token means encrypting it, rotating it, revoking it, and explaining
  it in the thesis' threat model. Read the identity, then let it fall out of
  scope. Nothing to leak.
- **No refresh tokens**, for the same reason. `access_type=offline` is not sent.
- **No scope beyond identity.** Google: `openid email profile`. GitHub:
  `read:user user:email`. Not `repo`, not `gist`.
- **No provider-side authorization.** No `hd` restriction, no org membership.
  Any Google or GitHub account may create a probeboard account, exactly as any
  email address may today.

---

## 3. Decisions

**D1 — Authorization code flow, PKCE S256, `state`, and (Google) `nonce`, for
both providers.** No implicit, no hybrid. PKCE even though both clients are
confidential, per RFC 9700.

**D2 — `openid-client` v6 for both providers**, per §2.6. Google by discovery,
GitHub by explicit server metadata.

**D3 — Identity is `(provider, provider_account_id)`.** Google `sub`, GitHub
numeric `id`. Never the email, never GitHub's `login`. Enforced by a unique
index, not only by code.

**D4 — No implicit linking by email. Ever, in this milestone.**

Three cases at the callback:

| Situation                                               | Result                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The `(provider, id)` pair is known                      | Sign in as that account. The email is refreshed for display but is never the lookup key. |
| Unknown pair, and the email matches no existing account | Create an account with no password and one identity.                                     |
| Unknown pair, and the email matches an existing account | **Refuse**, with `OAUTH_ACCOUNT_EXISTS`: sign in the usual way and link from settings.   |

The third row is the whole point. Revisit only after M7 ships email
verification, and even then behind a configuration flag defaulting to off,
requiring _both_ the provider's `email_verified` and the local row's
`email_verified_at` — which is Better Auth's post-fix behaviour and Grafana's
`oauth_allow_insecure_email_lookup` posture.

**D5 — `users.password_hash` becomes nullable.** An account created through a
provider has no password. This is the one destructive-looking schema change and
it is why this work belongs before M2.

The invariant "an account always has at least one way to sign in" cannot be a
`CHECK` constraint, because it spans two tables. It is therefore an application
invariant enforced at the only place that can break it — unlink — and covered by
an integration test that attempts to remove the last credential.

**D6 — Pending authorizations live in PostgreSQL, not in a signed cookie.**

A row in `oauth_authorizations` holds the `state`, the PKCE verifier, the
`nonce`, the provider, the mode (sign-in or link), the user id when linking, the
return path, and an expiry. The browser gets an opaque id in a short-lived
cookie.

Three reasons, in order of weight:

1. **Single use is enforceable.** The callback consumes the row with
   `DELETE … WHERE id = $1 AND expires_at > now() RETURNING *`. One statement,
   atomic, and a replayed callback finds nothing. A stateless signed cookie
   cannot express "already used" without server state, which is the thing it was
   trying to avoid.
2. **The PKCE verifier and the nonce are secrets** that must not be readable by
   anything that gets hold of the cookie jar. A signed cookie is signed, not
   encrypted.
3. It matches ADR-0001: PostgreSQL is the only infrastructure dependency, and
   session state already lives there.

The cost is one write per sign-in attempt and a sweep, both trivial next to an
Argon2 verification.

**D7 — The state cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no
`Domain`, 10-minute expiry, and takes its name the same way the session cookie
does.**

`__Host-pb_oauth` when `COOKIE_SECURE` is on, bare `pb_oauth` otherwise — the
existing `sessionCookieName(cfg)` contract, reused rather than restated. The
prefix is enforced by the browser, not by us: it _refuses_ the cookie unless it
is Secure, `Path=/` and carries no `Domain`. A `__Host-` name without `Secure`
is therefore not a weaker cookie but no cookie at all: the browser stores
nothing, and every callback then fails at step 8 with `OAUTH_STATE_INVALID` — a
bug that reads as a broken state check and is really a cookie that was never
set. The prefix cannot be used over plain HTTP at all, which is why the name is
conditional rather than constant.

`Lax` is exactly right and is not an accident: the callback is a top-level
cross-site **GET** navigation, which `Lax` permits and `Strict` does not. If a
provider is ever added that uses `response_mode=form_post` — Apple, most Entra
configurations — the callback becomes a cross-site **POST**, `Lax` stops sending
the cookie, and the flow fails with a state mismatch that looks like a bug in
our code. Written down here so the next person recognises it in one minute
instead of an afternoon.

Ten minutes because GitHub's authorization code expires in ten.

**D8 — A distinct redirect URI per provider**, `/v1/auth/oauth/google/callback`
and `/v1/auth/oauth/github/callback`, registered as exact strings. This is
RFC 9700's fallback mix-up countermeasure, and it is free. GitHub's wildcard
redirect matching stays **off**.

**D9 — `returnTo` is a path, validated, and never leaves the server.** It is
stored on the pending row, not passed to the provider and not echoed in the
callback URL. Accepted only if it begins with a single `/`, does not begin with
`//` or `/\`, and contains no scheme. Otherwise the default path is used
silently — an invalid return target is not worth an error page.

**D10 — The callback always issues a brand-new session** through the existing
`issue()` path: same token generator, same `SESSION_TTL_DAYS`, same
`MAX_SESSIONS_PER_USER` cap, same cookie helpers. Any cookie present on the
callback request is ignored and overwritten. One session-issuing code path, so
the session cap and the `__Host-` prefix cannot drift between login styles.

**D11 — Rate limiting reuses `auth_attempts`.** `/start` and `/callback` both
admit through `AuthRateLimitService` on the `ip` scope before doing any work.
The `email` scope does **not** apply: the address is asserted by the provider,
not guessed, so counting failures against it would let anyone lock out an
account by mashing a broken OAuth flow. This is the same reasoning that keeps
registration on IP only, and it is the mistake that shipped once already.

**D12 — Provider tokens are never persisted, and the authorization code never
reaches a log.** The access token lives in a local variable for the duration of
two HTTPS calls.

Adding `code` to `REDACT_PATHS` would not be enough, and believing it was is the
trap here. Redaction matches _fields_, and the authorization code does not
arrive as a field — it arrives inside a URL. `pino-http`'s default request
serializer logs `url` and `query` on every request, and the global `ErrorFilter`
logs `path: req.url` on every failure, so a callback would write
`?code=…&state=…` into the log on the ordinary success path, twice over, with
the redaction list fully configured. Confirmed by reading a live log line from
the M1 verification run: `"req":{…,"url":"/readyz","query":{},…}`.

So the fix is a serializer, not a list: a custom pino `req` serializer that
keeps the path and drops the query string, and the same treatment for
`ErrorFilter`'s `path`. Both land **before** the OAuth surface is enabled, and
both ship with a test that runs a request carrying `?code=secret` and asserts
the string appears in no emitted line. `code_verifier`, `access_token`,
`id_token` and `client_secret` join the field redaction list as well, for the
places they genuinely are fields.

**D13 — Linking is an authenticated action.** `POST /v1/auth/oauth/:provider/link`
requires a session and starts a flow whose pending row records `mode = 'link'`
and the user id. The callback then attaches the identity to _that_ user, not to
whoever the email suggests. An identity already attached elsewhere is refused
rather than moved.

**D14 — Unlink refuses to remove the last credential, and does the refusing
atomically.** `DELETE /v1/auth/oauth/:provider` returns `LAST_CREDENTIAL` if the
account has no password and no other identity.

Counting and then deleting as two steps is a read-modify-write on shared state.
An account linked to both providers, sent two unlinks at once, has each request
observe the other identity, pass the check, and delete its own — leaving an
account nobody can ever sign in to. So the count and the delete are one
transaction holding `FOR UPDATE` on the **user** row: the row every credential
of that account hangs off, and the one that exists whether or not a password
does. Requests for different accounts never contend. It ships with a test that
fires both unlinks concurrently and asserts exactly one succeeds.

**D15 — GitHub's email comes from `/user/emails`, primary and verified.**
`GET /user` alone returns a _public profile_ email, which is frequently null and
is not necessarily verified. `/user/emails` needs the `user:email` scope and
returns `{email, primary, verified, visibility}`; we take the entry with
`primary && verified`. If there is none, the sign-in is refused with
`OAUTH_NO_VERIFIED_EMAIL` — M7 sends incident alerts by email, so an account
with no deliverable address is an account that cannot be told its API is down.

**D16 — Structure.** All of it lands inside the existing `api/auth` module, per
`CLAUDE.md`: one feature is one folder, and this is the same feature. New files
take existing role folders, plus `strategies/`, which the conventions already
name as allowed.

```
api/auth/
  oauth.controller.ts                     start, callback, link, unlink
  services/
    oauth.service.ts                      the flow: start, complete, link, unlink
    oauth-identity.service.ts             the linking policy of D4, alone and testable
  interfaces/
    oauth-provider.ts                     the contract both strategies implement
  strategies/
    google.strategy.ts                    discovery, ID token validation
    github.strategy.ts                    token exchange, /user, /user/emails
    index.ts                              name -> strategy
  repositories/
    oauth-identity.repository.ts
    oauth-authorization.repository.ts
  dto/
    oauth-params.dto.ts                   provider name, callback query
  utils/
    oauth-cookie.ts
    return-to.ts
  e2e/
    oauth-signin.int.test.ts
    oauth-linking.int.test.ts
    oauth-callback-abuse.int.test.ts
```

The linking policy is its own service on purpose. It is the part that carries
the CVEs, it is pure decision logic over "identity exists / email matches /
local row verified", and it should be exhaustively unit-testable without an HTTP
server or a provider.

---

## 4. Data model

Migration `0003_oauth_identities`, with a matching `.down.sql` and a matching
update to `src/core/db/types.ts` — both are review rules.

```sql
-- An account may now exist with no password: it signs in through a provider.
-- The invariant "at least one credential" spans two tables, so it cannot be a
-- CHECK; it is enforced at unlink and covered by a test.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE oauth_identities (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider            text        NOT NULL CHECK (provider IN ('google', 'github')),
    -- Google 'sub', GitHub numeric id as text. Never the email, and never
    -- GitHub's login: a released username can be claimed by someone else.
    provider_account_id text        NOT NULL,
    -- What the provider said, kept for display and for support questions.
    -- Never a lookup key.
    provider_email      text,
    provider_email_verified boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_login_at       timestamptz NOT NULL DEFAULT now()
);

-- One provider account signs into exactly one probeboard account.
CREATE UNIQUE INDEX oauth_identities_provider_account_key
    ON oauth_identities (provider, provider_account_id);

-- And one probeboard account holds at most one identity per provider.
CREATE UNIQUE INDEX oauth_identities_user_provider_key
    ON oauth_identities (user_id, provider);

-- A flow in progress. Rows are single-use and short-lived.
CREATE TABLE oauth_authorizations (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      text        NOT NULL CHECK (provider IN ('google', 'github')),
    -- 'signin' creates or finds an account; 'link' attaches to user_id.
    mode          text        NOT NULL CHECK (mode IN ('signin', 'link')),
    user_id       uuid        REFERENCES users (id) ON DELETE CASCADE,
    state         text        NOT NULL,
    -- Secrets. This is why the pending flow is a row and not a signed cookie.
    code_verifier text        NOT NULL,
    nonce         text,
    return_to     text        NOT NULL DEFAULT '/',
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);

CREATE UNIQUE INDEX oauth_authorizations_state_key ON oauth_authorizations (state);
CREATE INDEX oauth_authorizations_expires_at_idx ON oauth_authorizations (expires_at);
```

Notes on the shape:

- `mode = 'link'` with a null `user_id` is nonsense and could be a `CHECK`. It
  will be one.
- The row is looked up by the cookie's id **and** compared against the `state`
  from the query. Either alone would do; both together mean a stolen cookie
  without the callback URL, or a callback URL without the cookie, is useless.
- Rows are deleted on use. `oauth_authorizations` is swept by the existing
  `AuthMaintenanceService`, which already runs at startup and on its own
  interval and already logs only when it removes something.

---

## 5. HTTP surface

| Method   | Path                                | Auth    | Response                                      |
| -------- | ----------------------------------- | ------- | --------------------------------------------- |
| `GET`    | `/v1/auth/oauth/:provider/start`    | none    | `302` to the provider, sets `__Host-pb_oauth` |
| `GET`    | `/v1/auth/oauth/:provider/callback` | none    | `302` to the web app, sets the session cookie |
| `POST`   | `/v1/auth/oauth/:provider/link`     | session | `200 {"redirectUrl": "…"}`                    |
| `DELETE` | `/v1/auth/oauth/:provider`          | session | `204`                                         |
| `GET`    | `/v1/auth/identities`               | session | `200 [{provider, email, linkedAt}]`           |

`:provider` is validated against the known set by a Zod schema and produces
`404` otherwise — an unknown provider is an unknown route, not a validation
error about a route that might exist.

**Why `/start` is a redirect rather than JSON.** A `302` works from a plain
anchor, which means the sign-in button needs no JavaScript and no CORS
preflight. `/link` returns JSON instead because it is called from an
authenticated page that already has a fetch client, and because a `DELETE`-style
action should not be a navigable GET.

**The callback never returns JSON.** It is a browser navigation, so its outcome
is a redirect: on success to the stored `returnTo`; on failure to
`/login?error=<code>` with a code from a fixed enumeration
(`OAUTH_STATE_INVALID`, `OAUTH_ACCOUNT_EXISTS`, `OAUTH_NO_VERIFIED_EMAIL`,
`OAUTH_PROVIDER_ERROR`, `OAUTH_IDENTITY_TAKEN`). The provider's own
`error_description` is logged and never rendered — it is attacker-influenced
text that would otherwise be reflected into a page.

**Requests to add to `http/`** (required by the convention, not optional):
a new `oauth.http` listing start for both providers, the callback with a missing
cookie, the callback with a mismatched state, the callback with a stale state,
link, unlink, unlink-the-last-credential, and the identities list. The
provider-side leg cannot be scripted, so `oauth.http` carries the manual steps as
comments, the way `common.http` carries the concurrency checks.

---

## 6. Configuration

Added to `src/core/config/schema.ts`, validated at boot like everything else:

| Key                            | Default   | Notes                                                                                                                                                 |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OAUTH_ENABLED`                | `false`   | Off unless configured. A half-configured provider must not appear as a button.                                                                        |
| `GOOGLE_CLIENT_ID` / `_SECRET` | —         | Required when Google is enabled                                                                                                                       |
| `GITHUB_CLIENT_ID` / `_SECRET` | —         | Required when GitHub is enabled                                                                                                                       |
| `OAUTH_REDIRECT_BASE_URL`      | —         | Absolute, `https` outside development. The redirect URI is derived, never taken from the request's `Host` header — that header is attacker-controlled |
| `WEB_BASE_URL`                 | —         | Where the callback sends the browser afterwards                                                                                                       |
| `OAUTH_STATE_TTL_MS`           | `600_000` | Ten minutes, matching GitHub's code expiry                                                                                                            |
| `OAUTH_HTTP_TIMEOUT_MS`        | `5_000`   | Every outbound provider call is bounded                                                                                                               |
| `OAUTH_ALLOW_EMAIL_LINKING`    | `false`   | The D4 escape hatch. Refuses to turn on until email verification exists; named to say what it is                                                      |

A cross-field refinement: a provider whose id is set without its secret must
fail at boot, not at the first sign-in attempt.

The Google discovery fetch happens lazily on first use with a bounded timeout,
and is cached. It must **not** happen during boot and must **not** be part of
`/readyz`: an outage at Google would otherwise take probeboard out of the load
balancer, which would be a self-inflicted outage of a monitoring product.

---

## 7. The two flows, step by step

### Sign-in

1. `GET /v1/auth/oauth/google/start?returnTo=/services`.
2. Rate-limit admission on the client IP. Refused → `429`.
3. Generate `state`, `code_verifier`, `code_challenge = S256(verifier)`, and for
   Google a `nonce`. Validate `returnTo` per D9.
4. Insert `oauth_authorizations`. Set `__Host-pb_oauth` to the row id.
5. `302` to the provider with `client_id`, `redirect_uri`, `response_type=code`,
   `scope`, `state`, `code_challenge`, `code_challenge_method=S256`,
   `prompt=select_account`, and for Google `nonce`.
6. The user authenticates at the provider and is redirected back with
   `?code=…&state=…`.
7. Rate-limit admission again — the callback is reachable without ever visiting
   `/start`.
8. Read the cookie. Missing → `OAUTH_STATE_INVALID`. Clear the cookie now,
   whatever happens next.
9. Consume the pending row:
   `DELETE … WHERE id = $1 AND state = $2 AND expires_at > now() RETURNING *`.
   No row → `OAUTH_STATE_INVALID`. The `state` comparison is a clause of the
   same statement, so a caller cannot forget it and a replay cannot win a race
   against a separate read.
10. Exchange the code with `code_verifier`, bounded by the timeout.
    - Google: validate the ID token — signature against JWKS, `iss` in
      `{https://accounts.google.com, accounts.google.com}`, `aud` equal to our
      client id, `exp` unexpired with a small skew allowance, `nonce` equal to
      the row's. Read `sub`, `email`, `email_verified`.
    - GitHub: `Accept: application/json`; treat an `error` member as a failure
      **regardless of status** (§2.2); then `GET /user` for the numeric `id`,
      and `GET /user/emails` for the primary verified address (D15).
11. Apply the linking policy of D4, and **write its outcome in one
    transaction**:
    - Known identity → one `UPDATE` refreshing the display email and
      `last_login_at`.
    - New account → `INSERT users` and `INSERT oauth_identities` together, or
      neither.

    The second case is why this is a numbered step rather than an aside.
    Creating the user and then failing to insert the identity — a dropped
    connection, or a concurrent first sign-in losing the unique index — leaves
    an account with no password and no identity: unreachable forever, and, worse
    than merely orphaned, its address now matches, so every later sign-in is
    refused with `OAUTH_ACCOUNT_EXISTS` and the user is told to log in with a
    password that does not exist. Both repositories already take an executor
    parameter so the caller can commit them together.

    Uniqueness conflicts resolve inside that transaction: if the user insert
    conflicts on email, the whole attempt becomes the `OAUTH_ACCOUNT_EXISTS`
    branch; if the identity insert conflicts, the flow restarts from the
    identity lookup, because somebody else won the race and the account now
    exists.

12. Issue a session through the existing `issue()` (D10) and set the session
    cookie.
13. `302` to `WEB_BASE_URL + returnTo`.

Steps 8 and 9 are separate rejections that produce one error code. That is
deliberate: which of them fired is a fact about our internals, and belongs in the
log.

### Linking

Identical, except: `/link` requires a session, records `mode = 'link'` and the
user id, and at step 12 attaches the identity to that user. Refuses with
`OAUTH_IDENTITY_TAKEN` if the provider account already belongs to someone else —
never silently moves it, because moving it would sign the old owner out of their
own account on the say-so of whoever holds the provider account today.

---

## 8. What this changes in the code that already exists

Not additive. Five existing behaviours change, and each is a place a bug hides:

1. **`UserRepository.create`** takes a nullable hash, or gains a sibling for
   provider-created accounts. The `ON CONFLICT DO NOTHING` on email stays — two
   concurrent first-time sign-ins for one address must not both insert.
2. **`AuthService.changePassword`** currently calls
   `this.passwords.verify(user.password_hash, …)`. With a null hash that is a
   type error at best and a crash in production at worst. An OAuth-only account
   asking to change a password it does not have gets `NO_PASSWORD_SET`, and
   _setting_ a first password requires email verification, so it waits for M7.
3. **`AuthService.login`** must not treat a null hash as "verify against null".
   It spends a dummy verification and returns the same
   `INVALID_CREDENTIALS`— A-2 does not stop applying because the account happens
   to be OAuth-only. Getting this wrong turns login into an oracle for _which
   accounts have no password_, which is a list of accounts worth phishing.
4. **`GET /v1/auth/me`** grows an `identities` array so the UI can render the
   settings page without a second call.
5. **The redaction list** in `core/logging/redaction.ts` grows `code`,
   `code_verifier`, `access_token`, `id_token`, `client_secret`.

Item 3 is the one to write a test for first. It is invisible, it is a security
property, and it is exactly the shape of thing this repository has shipped
broken before.

---

## 9. Security properties, and how each is proved

The rule from `CLAUDE.md`: every check ships with a test that proves it **fails**
when it should. A guard never observed to fail is not known to work.

| Property                                          | Proof                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback without the cookie is refused            | Integration: complete a real flow against a stub provider, drop the cookie, expect `OAUTH_STATE_INVALID`                                                                                                                                                    |
| Callback with a foreign `state` is refused        | Start two flows, cross the states                                                                                                                                                                                                                           |
| A pending authorization is single-use             | Replay the exact callback URL and cookie; the second attempt fails                                                                                                                                                                                          |
| An expired authorization is refused               | Insert with `expires_at` in the past                                                                                                                                                                                                                        |
| PKCE verifier is actually sent and required       | Stub provider asserts `code_challenge_method=S256` on the authorize URL and rejects a token exchange with a wrong verifier                                                                                                                                  |
| An ID token with a wrong `aud` is refused         | Stub issues one; sign-in fails                                                                                                                                                                                                                              |
| An ID token with a wrong `nonce` is refused       | Same                                                                                                                                                                                                                                                        |
| An expired ID token is refused                    | Same                                                                                                                                                                                                                                                        |
| An unsigned or wrongly-signed ID token is refused | Sign with a key absent from the JWKS                                                                                                                                                                                                                        |
| **No implicit linking by email**                  | Register `victim@example.com` by password; complete a Google flow asserting the same address with `email_verified: true`; expect `OAUTH_ACCOUNT_EXISTS` and **assert no row was added to `oauth_identities`**. This is CVE-2026-53516 as an executable test |
| A half-created account is impossible              | Make the identity insert fail after the user insert; assert no `users` row survives, and that signing in again still works rather than hitting `OAUTH_ACCOUNT_EXISTS`                                                                                       |
| Identity, not email, is the key                   | Sign in; change the stub's asserted email; sign in again; the same `user_id` comes back                                                                                                                                                                     |
| GitHub `login` is not the key                     | Change the stub's `login`, keep the `id`; same account                                                                                                                                                                                                      |
| GitHub's HTTP-200 error is treated as an error    | Stub returns `200` with `error=bad_verification_code`; sign-in fails and no session is issued                                                                                                                                                               |
| No verified GitHub email is refused               | `/user/emails` returns only unverified entries                                                                                                                                                                                                              |
| Unlink cannot orphan an account                   | OAuth-only account attempts unlink; `LAST_CREDENTIAL`; the identity is still there afterwards                                                                                                                                                               |
| Unlink cannot orphan it under concurrency         | Account linked to both providers, both unlinks fired at once; exactly one succeeds and one credential remains                                                                                                                                               |
| An identity cannot be stolen                      | Link a provider account to user A, attempt to link the same one to user B                                                                                                                                                                                   |
| `returnTo` cannot leave the site                  | `//evil.com`, `https://evil.com`, `/\evil.com` all fall back to the default                                                                                                                                                                                 |
| Session fixation is not possible                  | Send a valid session cookie for user A into a callback completing as user B; the resulting session is B's, and A's is untouched                                                                                                                             |
| The callback is rate limited                      | Exhaust the IP budget, then call the callback; `429` before any provider call                                                                                                                                                                               |
| No authorization code reaches a log               | Request `/callback?code=secret&state=…` with the log captured; assert `secret` appears in no line — request log, error log, or either. A field-redaction list alone passes nothing here, because the code arrives inside `req.url`                          |
| No token or verifier reaches a log                | Run a whole flow with the log captured; assert the verifier and both tokens appear nowhere                                                                                                                                                                  |

The provider stub is a small local HTTP server, in `testing/`, that speaks both
shapes: an OIDC provider with a real signed ID token (a generated key pair, JWKS
served) and a GitHub-shaped one with `/user` and `/user/emails`. Building it is
perhaps a third of the test effort and it is what makes every row above cheap.
It also lets us reproduce the non-standard behaviours — the 200-with-error, a
missing primary email — which no live provider will produce on demand.

---

## 10. The problem this plan does not solve: cross-site cookies

The session cookie is `SameSite=Lax`. If `probeboard-web` (M9) is served from an
origin that is not _same-site_ with the api — `app.example.com` and
`api.example.net`, say — then the browser will not attach the cookie to the
SPA's `fetch` calls, and every request after a successful login is
unauthenticated. This is not specific to OAuth; OAuth is just where it will
first be noticed, because the callback is the first time a redirect crosses
between the two.

Three options, in order of preference:

1. **Deploy both under one registrable domain** — `probeboard.example` and
   `api.probeboard.example`. `SameSite=Lax` keeps working, `__Host-` keeps
   working, no CSRF token machinery is needed. Costs nothing but a DNS
   decision, and it should be made now rather than after M9 is written.
2. `SameSite=None; Secure`, which sends the cookie everywhere and hands back the
   CSRF exposure that `Lax` was removing. That then requires a CSRF token on
   every mutating endpoint — real work, and work that exists only to undo
   option 1's absence.
3. A bearer token in memory instead of a cookie, which trades CSRF for XSS token
   theft and contradicts the reasoning already written into
   `session-cookie.ts`.

**Recommendation: option 1, decided before M9 starts, recorded as an ADR.**

---

## 11. Delivery

Five pull requests. The order is chosen so that nothing merges that cannot be
tested on its own.

**PR 1 — schema and types.** Migration `0003`, `types.ts`, the two repositories,
their integration tests. Nothing calls them yet. Includes the `password_hash`
nullability change and a test that the existing password flows still behave.

**PR 2 — the linking policy.** `oauth-identity.service.ts` and its unit tests,
including the CVE-2026-53516 case. No HTTP, no provider, no network. This is the
part worth reviewing hardest and it is easiest to review with nothing else in
the diff.

**PR 3 — the provider strategies and the stub.** `google.strategy.ts`,
`github.strategy.ts`, the shared interface, the test double in `testing/`, and
the validation tests of §9 that do not need the controller.

**PR 4 — the HTTP surface.** `oauth.controller.ts`, `oauth.service.ts`, cookies,
`returnTo`, the redirect contract, the end-to-end tests, `http/oauth.http`.

**PR 5 — the existing-code changes of §8**, plus configuration, redaction, and
the `/me` addition.

Then, in the docs repo: **ADR-0010** for the linking policy and **ADR-0011** for
the cookie/domain decision of §10, stories A-7 and A-8 in §6.4, and a row in the
milestone table. Per ADR-0009, the _why_ lives there and the _how_ lives here.

---

## 12. Tensions to resolve before coding

1. **Does an OAuth-only account get to set a password?** Not without email
   verification — otherwise anyone who reaches an authenticated session can
   plant a password and keep access after the provider link is removed. That
   makes it an M7 item, and it means an OAuth-only user who loses their Google
   account has no recovery path until then. Acceptable for a thesis, and it
   should be said out loud in the UI rather than discovered.

2. **Is refusing to auto-link too strict for a demo?** It produces the one
   moment of friction in the whole feature: sign in with Google using an address
   you already registered, and you are told to log in and link. Auth.js, Grafana
   and Better Auth all now default to that same friction. Keep it, and make the
   error message say exactly what to do next.

3. **`prompt=select_account` on every start?** It costs a click for users with
   one account and prevents the surprise of being silently signed in as whoever
   the browser happens to be logged into. Proposed yes; low cost to revisit.

4. **Should `/start` be a GET at all?** A GET that mutates state (it writes a
   pending row) is impure, and it means a prefetching browser extension can
   create rows. The rows are cheap, expire in ten minutes and are rate limited
   by IP, so the trade is worth it for a no-JavaScript sign-in button — but the
   sweep needs to actually run, which is why it goes into the maintenance
   service rather than being left for M5.

5. **Google's 0.04% `sub` churn.** Accepted per §2.5. Worth a metric in M10 so
   the thesis can report whether it was ever observed rather than only cited.

---

## Sources

- [RFC 9700 — Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html)
- [Google — OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [GitHub — Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub Changelog — PKCE support for OAuth and GitHub App authentication (July 2025)](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)
- [GitHub REST — List email addresses for the authenticated user](https://docs.github.com/en/rest/users/emails)
- [GitHub Community — OAuth token request returns errors with status code 200](https://github.com/orgs/community/discussions/57068)
- [GHSA-g38m-r43w-p2q7 — Better Auth account takeover via OAuth auto-link to unverified pre-registered email (CVE-2026-53516)](https://github.com/advisories/GHSA-g38m-r43w-p2q7)
- [Grafana — CVE-2023-3128, account takeover via Azure AD OAuth email claim](https://grafana.com/security/security-advisories/cve-2023-3128/)
- [Grafana — Generic OAuth configuration, `oauth_allow_insecure_email_lookup`](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/)
- [Truffle Security — Millions of accounts vulnerable due to Google's OAuth flaw](https://trufflesecurity.com/blog/millions-at-risk-due-to-google-s-oauth-flaw)
- [NextAuth.js — OAuth providers, `allowDangerousEmailAccountLinking`](https://next-auth.js.org/configuration/providers/oauth)
- [GitHub Docs — Username changes](https://docs.github.com/en/account-and-profile/concepts/username-changes)
- [panva/openid-client](https://github.com/panva/openid-client)
- [Auth0 — SameSite cookie attribute changes](https://auth0.com/docs/manage-users/cookies/samesite-cookie-attribute-changes)
