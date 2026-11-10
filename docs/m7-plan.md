# M7 — Alerting: implementation plan

Delivers what the incident evaluator queues: email and webhook, grouped per
service, re-notified on a decaying schedule, warned before a certificate
expires, retried with backoff, and never silently lost. M6 writes
`notification_outbox`; M7 drains it. M8 serves statistics; M9 shows what M7
records.

Requirements: **FR-28, FR-29, FR-31**, stories **E-1…E-9** (PRD §6.8,
`06-prd.md:149-169`), D-6 (§6.7), PRD §6.12 item 3; `07-architecture.md` §7.1
(tick table: dispatcher 5 s), §7.7, §7.8; ADR-0008. Out: FR-30 (Telegram).

Milestone exit test (`08-plan.md` row M7): _an email arrives when it breaks and
when it recovers._

---

## 1. Scope

**In**

- The **dispatcher**: a worker loop on a 5 s tick (07 §7.1). Each tick
  **groups** queued events into deliveries, then **sends** due deliveries.
  The api never sends (ADR-0008); it only writes rows the worker drains.
- Grouping per service (E-3), early release for a lone incident (§3.4).
- Reminders for open incidents at 30 m, 2 h, 6 h, then daily (E-4), and
  certificate warnings at 30/14/7/1 days (E-5), both enqueued by the
  evaluator in its own transaction.
- Channels (FR-29): the account's email address, and up to
  `WEBHOOK_CHANNEL_QUOTA_PER_USER` webhooks. Per-service preferences
  open / resolve / cert (E-6).
- Email verification (E-7): request, single-use hashed token, confirm.
- Retry with backoff, a permanent failure recorded and readable over HTTP
  (E-8). Webhooks signed per Standard Webhooks, SSRF-guarded per attempt (E-9).
- Mailpit as a compose service for local SMTP capture.
- HTTP: channel CRUD, secret rotation, a test send, preferences,
  verification, delivery history and failures. `http/`, `openapi.yaml`.

**Out**

- FR-30 Telegram, M8 statistics, the web UI (M9), real-provider OAuth (F3),
  a hosted mail provider (decided 2026-09-20).
- Extra email addresses beyond the account's own. E-7 verifies "my address";
  a second address would need its own verification flow for no story.
- Manual retry of a failed delivery, and retention of delivered rows. Both
  are follow-ups (§10); the row bound is in §3.11.
- Webhook secret rotation with an overlap period (Standard Webhooks allows
  several signatures). Rotation replaces the secret at once.

---

## 2. Investigation

### 2.1 Requirements, architecture and `main` read together — contradictions found

| #   | Where                                                                                                    | Finding                                                                                                                                                                                                                                                                                            | Resolution                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| C1  | 07 §7.7: outbox `group_key`, `payload`, `UNIQUE (group_key)`; M6 D9: one row per transition              | M6 deliberately left grouping to M7 (m6 C5). One row per transition stays: it is the event, written in the incident's transaction. A group is a later fact, not known when the first event is written.                                                                                             | D1: events stay per transition; grouping produces **deliveries** (§3.4).                                    |
| C2  | `notification_outbox.not_before/attempts/delivered_at/last_error` (0011)                                 | Per-event delivery state cannot express fan-out: one event goes to email **and** each webhook, each with its own attempts and error. Two of three succeeding has no single value. The columns were never written (every M6 row holds its default).                                                 | D2: delivery state lives on `notification_deliveries`; the four columns are dropped (0013).                 |
| C3  | `UNIQUE (incident_id, kind)` (0011:151)                                                                  | Holds E-1's "once" for open and close, and forbids a second reminder for the same incident.                                                                                                                                                                                                        | D3: partial unique indexes per kind; reminders keyed `(incident_id, reminder_seq)`.                         |
| C4  | `notification_outbox.incident_id NOT NULL` (0011:140)                                                    | A certificate warning has no incident.                                                                                                                                                                                                                                                             | D3: nullable, with a per-kind `CHECK`; `endpoint_id` added for every kind.                                  |
| C5  | 07 §7.7: `not_before = now() + 60s` on every event                                                       | Every lone incident waits the full window — 60 s of the PRD's 60 s of slack spent on a sibling that may not exist.                                                                                                                                                                                 | D5: a group is released early when no sibling is failing-but-unconfirmed (§3.4).                            |
| C6  | 07 §7.7: `incidents.last_notified_at` for E-4                                                            | A second writer to `incidents`, which M6 made evaluator-only (m6 §3.3). And "from the last send" drifts by every retry and resets on a lost write.                                                                                                                                                 | D6: reminders are a pure function of `confirmed_at` and a sequence number; no column (§3.5).                |
| C7  | D-6 "no email is sent" inside a window; m6 §10 item 2 keeps a close queued inside one                    | M6 already queues the close (decided). Reminders and certificate warnings are new emails M7 adds.                                                                                                                                                                                                  | D7: no reminder and no certificate warning is enqueued while a window covers the endpoint; the close stays. |
| C8  | E-7 vs `oauth_identities.provider_email_verified` (0003)                                                 | `users.email_verified_at` means "probeboard verified this address" and gates OAuth linking by email (`oauth-identity.service.ts:270-281`, `user.repository.ts:36-60`, the CVE-2026-53516 defence). Counting a provider's claim would satisfy that gate with the evidence it exists to corroborate. | D9: the provider's claim does not count. Only M7's own confirmation sets the column.                        |
| C9  | "api never sends" (ADR-0008) vs a verification email requested over HTTP                                 | The request arrives at the api.                                                                                                                                                                                                                                                                    | D10: the api writes a delivery row; the worker sends it.                                                    |
| C10 | `users.email` from a provider is stored unvalidated (`google.strategy.ts:123`, `github.strategy.ts:151`) | Any non-empty string. Harmless until mail is sent to it. §2.4.1 measured what nodemailer then does with a CR/LF address: **the mail goes only to the injected address.**                                                                                                                           | D11: the address is re-validated at send, and the SMTP envelope is always explicit.                         |
| C11 | PRD §6.12 item 3: email "within one probe interval + one minute"                                         | m6 §10 item 1, pending. With D5 the bound is computable exactly (§3.10): a lone incident fits at `N = 1`; at the default `N = 3` it cannot.                                                                                                                                                        | Open question 1, with numbers.                                                                              |
| C12 | E-9 "same events"                                                                                        | A webhook per event, against an email per group, would make the two channels disagree on what "one alert" is.                                                                                                                                                                                      | D12: a webhook delivery carries the same grouped payload as the email.                                      |
| C13 | 07 §7.8 lists `POST /auth/verify-email`                                                                  | Consistent; M7 adds the request route beside it.                                                                                                                                                                                                                                                   | §3.9.                                                                                                       |

### 2.2 Code on `main` this touches

- **Outbox writer** — `evaluator.repository.ts:259-307` (`record`): incident
  row and outbox row, plain inserts, one transaction. `removeOrphans`
  (`:372-382`) deletes a deleted endpoint's incidents, and with them their
  outbox rows by cascade. M7's event tables hang off the outbox, so they
  inherit that deletion; the cert rows (no incident) need their own line in it.
- **Evaluator pass** — single-flight under `rollup_state` row
  `incident_evaluator`, `FOR UPDATE SKIP LOCKED` (`:117-125`). Reminders and
  certificate warnings join this pass (D4) rather than starting a second
  writer of the outbox (§3.3, why).
- **Batch read** (`:183-191`) selects no `cert_expires_at` and no `total_ms`;
  M7 adds both, for E-5 and for E-1's "last response time".
- **Loop shape** — `evaluator.service.ts`: one `setTimeout` chain re-armed
  after the pass settles, `stop()` awaited in `worker/main.ts` before
  `app.close()`. The dispatcher copies it and is stopped after the evaluator.
- **Outbound HTTP** — `probe()` (`worker/probing`) already resolves, classifies
  every address, pins the connection, caps the body, bounds the time, and
  re-validates every redirect hop. With `followRedirects: false` a `3xx` is
  evaluated as the response, `STATUS_MISMATCH` with its status
  (`probe.ts:311`, `:457`). The webhook sender is a **caller** of `probe()`,
  not a second HTTP client (§3.7). `createProbeDeps` lives in
  `worker/scheduler/probe-deps.factory.ts`; it moves to `worker/probing/` so
  two features can use it (it has no database or scheduler dependency).
- **Save-time guard** — `assertSaveableUrl` (`core/ssrf/host-validator.ts:273`),
  called by `services.service.ts:73,112`. The webhook save calls the same.
- **Secrets at rest** — `core/crypto/header-cipher.ts`: AES-256-GCM, fresh IV,
  pinned 16-byte tag, key `HEADER_ENCRYPTION_KEY`. Reused for webhook URLs,
  webhook secrets and the verification token's in-flight copy.
- **Tokens** — `api/auth/utils/session-token.ts`: 32 CSPRNG bytes, a prefix,
  SHA-256 stored, timing-safe compare. Verification tokens copy it with prefix
  `pbv_`.
- **Rate limiting** — `rate-limit.service.ts` / `auth_attempts`: atomic
  admission (M1's measured 20-of-5 race), a separate scope per endpoint
  (#72). Verification confirm gets scope `verify`; the request is counted per
  user from its own table under the user row lock.
- **Log redaction** — `core/logging/redaction.ts`. New secret-bearing fields
  join `REDACT_PATHS`; nodemailer runs with `logger: false, debug: false`.
- **Compose** — no mail service; the worker has no `WEB_BASE_URL`.
- Migrations run to `0011`; M7 takes `0012` and `0013` (§2.4.3 says why two).

### 2.3 Prior art and published defects

`../references/`, all read at the commits in Sources. Healthchecks (BSD-3) and
Cachet (its own licence) were cloned for this plan; Cachet is read-only.

| Source                                                                                                    | What it does                                                                                                                                                                                                                                                                                           | What M7 takes                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Healthchecks `sendalerts.py:105-117`                                                                      | Claims a flip with `UPDATE … SET processed = now() WHERE processed IS NULL`, then sends. **At-most-once**: a crash after the update loses the alert.                                                                                                                                                   | Contrast: M7 is at-least-once (claim with a lease, record after). Test: kill mid-send → resent.                                          |
| Healthchecks `transports.py:139-200`                                                                      | Three tries in-process, no backoff, no persistence; the error is stored per notification (`models.py:1152-1185`).                                                                                                                                                                                      | Persisted attempts and backoff (E-8); the per-attempt record (§3.6).                                                                     |
| Healthchecks `lib/curl.py:51-145`                                                                         | SSRF check at socket open on every connection, redirects included (curl's `OPENSOCKETFUNCTION`), classifying with `ipaddress.is_private`; up to three redirects followed.                                                                                                                              | The connect-time shape M3 already has. M7 follows no redirect at all (D13).                                                              |
| Healthchecks `models.py:1071-1080`                                                                        | Verification link = `HMAC(SECRET_KEY, code + email)`: stateless, the same on every request, **never expires, reusable**.                                                                                                                                                                               | Contrast for D9: single-use, expiring, hashed at rest.                                                                                   |
| Healthchecks `accounts/models.py:356-363`                                                                 | Nag `next_nag_date = now() + nag_period`: a fixed period from the last nag.                                                                                                                                                                                                                            | Contrast for D6.                                                                                                                         |
| Uptime Kuma `monitor.js:994-1006`                                                                         | Resend after `resendInterval` **beats** while down — a count of probes, so its period moves with the interval.                                                                                                                                                                                         | D6 counts time.                                                                                                                          |
| Uptime Kuma `monitor.js:1509-1521`; issue #6046                                                           | Each notification sent inline; a failure is logged and dropped. #6046: "Notification lost if service is temporarily unavailable".                                                                                                                                                                      | The failure E-8 exists to prevent.                                                                                                       |
| Uptime Kuma `util-server.js:904-958`, `monitor.js:1549-1584`, `:1270-1290`                                | Cert warnings per target day, deduplicated in `notification_sent_history (monitor_id, days)`, cleared when the fingerprint changes; recorded only if a send succeeded.                                                                                                                                 | D8: keyed `(endpoint, cert_expires_at, threshold)`, so a renewed certificate restarts the thresholds with no clearing step.              |
| Uptime Kuma GHSA-vffh-c9pq-4crh                                                                           | Server-side template injection in user-editable notification templates (Liquid) → arbitrary file read.                                                                                                                                                                                                 | No user templates. Fixed templates, plain text.                                                                                          |
| Uptime Kuma CVE-2024-56331                                                                                | A `file://` URL read local files through a monitor.                                                                                                                                                                                                                                                    | The webhook URL goes through `assertSaveableUrl` (http/https only) and `probe()`.                                                        |
| Gatus `watchdog/alerting.go:30-75`                                                                        | Reminder when `time.Since(LastReminderSent) ≥ MinimumReminderInterval`; `LastReminderSent` is `yaml:"-"` on the in-memory endpoint (`endpoint.go:139-140`) — **a restart resets it**.                                                                                                                  | D6: nothing in memory. Test: restart → no early or repeated reminder.                                                                    |
| Gatus `alert.go:64-72`, `alerting.go:96-98`                                                               | A resolve that fails to send is dropped on purpose, so a broken provider cannot pin an alert open.                                                                                                                                                                                                     | Contrast: the close is retried and its permanent failure recorded.                                                                       |
| Gatus #764 (v5.11.0)                                                                                      | "Persist triggered alerts across application restart" — before it, a restart re-sent every triggered alert.                                                                                                                                                                                            | The outbox is the persisted state already; the restart test applies.                                                                     |
| Gatus `alerting/provider/email/email.go:116-120`                                                          | `Subject` built from the endpoint name.                                                                                                                                                                                                                                                                | Not followed: no user content in any header (D11).                                                                                       |
| Cachet core `Models/WebhookSubscription.php:62-80`                                                        | spatie/laravel-webhook-server: HMAC of the body in a `Signature` header, no timestamp, no id; the secret a plaintext column (`$hidden` hides it from serialization only). URL check `->url()`.                                                                                                         | Contrast for D13: Standard Webhooks (id + timestamp in the signed content), secret encrypted at rest, SSRF guard.                        |
| Nezha CVE-2026-47268                                                                                      | Notification webhooks were SSRF-checked; the DDNS webhook path called the HTTP client directly and was not.                                                                                                                                                                                            | The defect shape for §3.7: every outbound request M7 makes goes through `probe()`. Test: no other HTTP client in `worker/notifications`. |
| nodemailer CVE-2021-23400; GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h (all `< 10.1.4`) | Header injection through CR/LF in an address object; three `addressparser` defects that turn display text or a comment into a recipient, or deliver to a domain the header does not name. `npm audit`: all three on 10.1.3, none on 10.2.1.                                                            | Pin `nodemailer@10.2.1` (2026-10-22, ≥ two weeks old, after the fixes). §2.4.1 shows the pin alone is not enough.                        |
| Standard Webhooks 1.0.0 spec                                                                              | Headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`; signed content `id.timestamp.body`; secret `whsec_` + base64, 24–64 bytes; the id is **the same on every retry**; any `2xx` succeeds; a `3xx` is a failure and is **not followed**; `410` means disable; timeout 15–30 s. | D13 as written.                                                                                                                          |

### 2.4 Mechanics verified directly, not recalled

Node **22.23.2** (`node:22-alpine`, the `.nvmrc` pin) in a throwaway `--rm`
container; nodemailer **10.2.1**, smtp-server 3; PostgreSQL **17.11**
(`postgres:17-alpine`). All removed afterwards.

1. **nodemailer with a CR/LF address sends to the injected address only.**
   `to: 'a@b.test\r\nBcc: evil@x.test'` was accepted, the `To:` header became
   the group `"a@b.test Bcc":evil@x.test;`, and the server saw
   `RCPT TO: evil@x.test` — not `a@b.test`. With an explicit
   `envelope: { to: ['a@b.test'] }` the only `RCPT TO` was `a@b.test`. A
   CR/LF in `subject` is folded to a space (no new header line), and a body
   holding `\r\n.\r\nMAIL FROM:` arrived intact as one message (dot-stuffed).
2. **nodemailer's logging.** With `debug: true` and a capturing logger the
   SMTP password appeared in no log line, plain or base64. With
   `logger: false` nothing is logged at all — the setting M7 uses.
3. **A new enum value cannot be used in the transaction that adds it.**
   `ALTER TYPE … ADD VALUE 'incident_reminder'` then a `CHECK` comparing
   `kind = 'incident_reminder'`: `ERROR: unsafe use of new value`. The
   migrator runs each file in one transaction, so the values go in `0012` and
   everything that names them in `0013`.
4. **nodemailer error shapes**, against a real SMTP server: `550` on
   `RCPT` → `{ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }`;
   `451` → the same with `451`; connection refused →
   `{ code: 'ESOCKET', command: 'CONN', errno: -111 }`, no `responseCode`.
   §3.6's classification reads `responseCode` first, `code` second.
5. **Mailpit `v1.32.0`** (2026-10-22) has `--enable-chaos` and
   `--chaos-triggers`, which make its SMTP server answer chosen error codes —
   the verification run's forced 4xx/5xx needs no second server.

### 2.5 The four questions the handoff asks

**Grouping vs "sent once".** The two are different facts on different rows.
"Once" stays on the **event** (`incident_open` is still unique per incident,
§3.1); the group is a **delivery** that references several events. A lone
incident is not delayed by the window: its group is released at the next
dispatcher tick unless a sibling endpoint of the same service is failing but
not yet confirmed — the only evidence that a second event is about to join
(§3.4). The window is a cap on waiting for such a sibling, not a fixed delay.

**Re-notify schedule.** From `incidents.confirmed_at` — the instant the first
email was due — never from the last send. Reminder `k` is due at
`confirmed_at + offset(k)`; `UNIQUE (incident_id, reminder_seq)` makes each
one once. Across a worker restart or a stopped evaluator, the next pass
enqueues only the **latest** due reminder, so an outage of the worker produces
one catch-up email, not a burst. Inside a maintenance window or while the
endpoint is paused, none is enqueued (D7); the next one due after the window
is sent. §3.5.

**Prior art.** §2.3. None of the five systems surveyed groups by a parent
entity; none signs with a timestamp except through a library; two lose
alerts by design (Healthchecks at-most-once claim, Kuma send-and-log); two
keep the reminder clock in a place a restart resets (Gatus memory, Kuma
beats).

**Verification tokens.** M1's session-token pattern: 256 bits, prefix, only
SHA-256 at rest, timing-safe compare. Single use by
`UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL
AND expires_at > now() RETURNING …`; expiry `EMAIL_VERIFICATION_TTL_MS` (24 h);
a new request supersedes earlier tokens; request admission counted per user
under the user row lock, confirmation per address in `auth_attempts`. §3.9.

---

## 3. Design

### 3.1 Schema — migrations `0012_notification_kinds`, `0013_notifications`

`0012` only adds enum values (§2.4.3):

```sql
ALTER TYPE notification_kind ADD VALUE 'incident_reminder';
ALTER TYPE notification_kind ADD VALUE 'cert_expiry';
```

`0013`:

```sql
-- Events (M6's rows, unchanged in meaning): what happened, written by the evaluator.
ALTER TABLE notification_outbox
    DROP CONSTRAINT notification_outbox_once,
    ALTER COLUMN incident_id DROP NOT NULL,
    ADD COLUMN endpoint_id          uuid,              -- every kind; no FK (m6 D13)
    ADD COLUMN reminder_seq         smallint,          -- incident_reminder only, >= 1
    ADD COLUMN cert_expires_at      timestamptz,       -- cert_expiry only
    ADD COLUMN cert_threshold_days  smallint,          -- cert_expiry only: 30 | 14 | 7 | 1
    ADD COLUMN grouped_at           timestamptz,       -- the dispatcher took it into a delivery (or skipped it)
    ADD COLUMN skip_reason          text,              -- why no delivery was made, when none was
    DROP COLUMN not_before, DROP COLUMN attempts,
    DROP COLUMN delivered_at, DROP COLUMN last_error;  -- C2: never written; state moves to deliveries
UPDATE notification_outbox o SET endpoint_id = i.endpoint_id FROM incidents i WHERE i.id = o.incident_id;
-- Events that predate M7 are history, not alerts: without this, the first
-- dispatcher tick after the migration would email every M6 incident ever
-- opened (the same reasoning as m6 D15's watermark).
UPDATE notification_outbox SET grouped_at = now(), skip_reason = 'predates_m7';
ALTER TABLE notification_outbox ALTER COLUMN endpoint_id SET NOT NULL,
    ADD CONSTRAINT notification_outbox_shape CHECK (
        CASE kind
          WHEN 'cert_expiry'       THEN incident_id IS NULL AND cert_expires_at IS NOT NULL
                                        AND cert_threshold_days IN (30, 14, 7, 1) AND reminder_seq IS NULL
          WHEN 'incident_reminder' THEN incident_id IS NOT NULL AND reminder_seq >= 1
                                        AND cert_expires_at IS NULL
          ELSE                          incident_id IS NOT NULL AND reminder_seq IS NULL
                                        AND cert_expires_at IS NULL
        END),
    ADD CONSTRAINT notification_outbox_skip CHECK (skip_reason IS NULL OR grouped_at IS NOT NULL);
CREATE UNIQUE INDEX notification_outbox_transition_once ON notification_outbox (incident_id, kind)
    WHERE kind IN ('incident_open', 'incident_close');                        -- E-1/E-2, as before
CREATE UNIQUE INDEX notification_outbox_reminder_once ON notification_outbox (incident_id, reminder_seq)
    WHERE kind = 'incident_reminder';                                         -- E-4
CREATE UNIQUE INDEX notification_outbox_cert_once ON notification_outbox (endpoint_id, cert_expires_at, cert_threshold_days)
    WHERE kind = 'cert_expiry';                                               -- E-5, per certificate
CREATE INDEX notification_outbox_ungrouped_idx ON notification_outbox (service_id, created_at)
    WHERE grouped_at IS NULL;

-- The evaluator's view of the certificate and the last response time (E-5, E-1 content).
ALTER TABLE endpoint_health
    ADD COLUMN cert_expires_at  timestamptz,
    ADD COLUMN last_total_ms    integer;

-- Channels (FR-29). The email channel is the account's own address; at most one per user.
CREATE TABLE notification_channels (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind               text        NOT NULL CHECK (kind IN ('email', 'webhook')),
    enabled            boolean     NOT NULL DEFAULT true,
    -- Webhook only. The URL is a credential for Slack- and Discord-style
    -- receivers, so it is encrypted like the secret; the origin is kept for display.
    url_ciphertext     bytea, url_iv bytea, url_auth_tag bytea,
    url_origin         text,
    secret_ciphertext  bytea, secret_iv bytea, secret_auth_tag bytea,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_channels_shape CHECK (
        (kind = 'email') = (url_ciphertext IS NULL AND secret_ciphertext IS NULL AND url_origin IS NULL)
        AND (kind = 'email' OR (url_ciphertext IS NOT NULL AND url_iv IS NOT NULL AND url_auth_tag IS NOT NULL
                                AND secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL
                                AND secret_auth_tag IS NOT NULL AND url_origin IS NOT NULL)))
);
CREATE UNIQUE INDEX notification_channels_one_email ON notification_channels (user_id) WHERE kind = 'email';
CREATE INDEX notification_channels_user_idx ON notification_channels (user_id, created_at, id);

-- Preferences per service (E-6). No row = everything on.
CREATE TABLE notification_preferences (
    service_id  uuid        PRIMARY KEY,
    user_id     uuid        NOT NULL,
    on_open     boolean     NOT NULL DEFAULT true,     -- governs open and reminders
    on_resolve  boolean     NOT NULL DEFAULT true,
    on_cert     boolean     NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- The owner is the service's owner, held by the schema (as maintenance_windows, 0011).
    FOREIGN KEY (service_id, user_id) REFERENCES services (id, user_id) ON DELETE CASCADE
);

-- Verification (E-7). Hash for lookup; the ciphertext exists only until the mail is sent.
CREATE TABLE email_verification_tokens (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash        bytea       NOT NULL,
    token_ciphertext  bytea, token_iv bytea, token_auth_tag bytea,
    email             text        NOT NULL,            -- the address it was sent to
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    consumed_at       timestamptz,                     -- used, or superseded by a newer request
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX email_verification_tokens_hash_key ON email_verification_tokens (token_hash);
CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id, created_at DESC);

-- Deliveries: one message to one target. Its id is the webhook-id and the Message-ID.
CREATE TABLE notification_deliveries (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    service_id             uuid,                              -- NULL for verification and test
    channel_id             uuid        REFERENCES notification_channels (id) ON DELETE CASCADE,
    verification_token_id  uuid        REFERENCES email_verification_tokens (id) ON DELETE CASCADE,
    kind                   text        NOT NULL CHECK (kind IN ('incident_open', 'incident_close',
                                         'incident_reminder', 'cert_expiry', 'email_verification', 'test')),
    payload                jsonb       NOT NULL,              -- the snapshot rendered from (§3.8); no secret
    status                 text        NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
    attempts               smallint    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    not_before             timestamptz NOT NULL DEFAULT now(),
    lease_until            timestamptz,
    claim_token            uuid,
    delivered_at           timestamptz,
    failed_at              timestamptz,
    last_error             text,                              -- a closed-list code (§3.6), never server text
    created_at             timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'sending') = (lease_until IS NOT NULL AND claim_token IS NOT NULL)),
    CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
    CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
    CHECK ((kind = 'email_verification') = (verification_token_id IS NOT NULL AND channel_id IS NULL)),
    CHECK (kind = 'email_verification' OR channel_id IS NOT NULL)
);
CREATE INDEX notification_deliveries_due_idx   ON notification_deliveries (not_before)  WHERE status = 'pending';
CREATE INDEX notification_deliveries_lease_idx ON notification_deliveries (lease_until) WHERE status = 'sending';
CREATE INDEX notification_deliveries_fifo_idx  ON notification_deliveries (channel_id, service_id, created_at)
    WHERE status IN ('pending', 'sending');
CREATE INDEX notification_deliveries_user_idx  ON notification_deliveries (user_id, created_at DESC, id DESC);

CREATE TABLE notification_delivery_events (
    delivery_id  uuid NOT NULL REFERENCES notification_deliveries (id) ON DELETE CASCADE,
    outbox_id    uuid NOT NULL REFERENCES notification_outbox (id) ON DELETE CASCADE,
    PRIMARY KEY (delivery_id, outbox_id)
);
CREATE INDEX notification_delivery_events_outbox_idx ON notification_delivery_events (outbox_id);

-- One row per claim. The key makes a double claim of one attempt impossible to store.
CREATE TABLE notification_attempts (
    delivery_id  uuid        NOT NULL REFERENCES notification_deliveries (id) ON DELETE CASCADE,
    attempt      smallint    NOT NULL,
    worker_id    text        NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    outcome      text        CHECK (outcome IN ('delivered', 'retry', 'failed')),
    error        text,
    PRIMARY KEY (delivery_id, attempt)
);

-- The dispatcher's grouping lock, beside the rollup's and the evaluator's.
INSERT INTO rollup_state (name, last_xid) VALUES ('notification_grouper', '0');

ALTER TABLE auth_attempts DROP CONSTRAINT auth_attempts_scope_check;
ALTER TABLE auth_attempts ADD CONSTRAINT auth_attempts_scope_check
    CHECK (scope IN ('ip', 'email', 'register', 'verify'));
```

`down.sql` (both): drop the new tables, columns and indexes, restore
`notification_outbox_once`, delete `incident_reminder` / `cert_expiry` rows,
and recreate `notification_kind` without the two values (an enum value cannot
be dropped; the type is renamed, recreated, the column cast through `text`,
the old type dropped). `types.ts` in the same commit.

**Foreign keys and locks.** Each new FK has one writer on each side, or a
read-only side:

| FK                                     | Writers                                                      | Can it meet a cascade in the other order?                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivery_events → outbox`             | grouper inserts; evaluator's orphan sweep deletes by cascade | The grouper locks the ungrouped events `FOR UPDATE` first and never waits on an evaluator lock (it reads `endpoint_health` and `incidents` without locks), so the sweep waits for the grouper's commit; no cycle. Proved by race (§7). |
| `deliveries → channels`                | grouper and api insert; api deletes by cascade               | A sender holds no lock while sending (§3.6); the claim transaction is milliseconds. Proved by race (§7).                                                                                                                               |
| `preferences → services`               | api only                                                     | The worker reads it without locks.                                                                                                                                                                                                     |
| `tokens → users`, `deliveries → users` | api, grouper                                                 | Nothing deletes users.                                                                                                                                                                                                                 |

### 3.2 Event kinds and who writes them

| Kind                | Written by                | When                                                        | Once by                                     |
| ------------------- | ------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| `incident_open`     | evaluator (M6, unchanged) | the Nth failure                                             | `(incident_id, kind)`                       |
| `incident_close`    | evaluator (M6, unchanged) | the Mth success; queued inside a window too (m6 §10 item 2) | `(incident_id, kind)`                       |
| `incident_reminder` | evaluator, new step       | §3.5                                                        | `(incident_id, reminder_seq)`               |
| `cert_expiry`       | evaluator, new step       | §3.5                                                        | `(endpoint_id, cert_expires_at, threshold)` |

Verification and test deliveries are not events: the api writes the delivery
row directly (D10), because there is nothing to group.

### 3.3 Evaluator additions (one transaction, as M6)

All in `EvaluatorRepository.runOnce`, after the batches and before the sweeps:

1. **Observations** carry `cert_expires_at` and `total_ms`. On every applied
   observation: `last_total_ms := total_ms` (NULL when no response);
   `cert_expires_at := observation's` when it carries one; set to NULL when a
   **successful** observation carries none (the endpoint is now plain http).
   A failed connect keeps the last certificate: it is no evidence the
   certificate changed.
2. **Reminders** — one `INSERT … SELECT … ON CONFLICT DO NOTHING` (§3.5).
3. **Certificate warnings** — one `INSERT … SELECT … ON CONFLICT DO NOTHING`
   (§3.5).
4. `removeOrphans` also deletes `cert_expiry` rows whose endpoint is gone
   (reminder rows go with their incident by cascade).

`ON CONFLICT DO NOTHING` is right here and wrong in M6's `record`: these are
idempotent "make sure it is enqueued" statements run every pass, where M6's
inserts are transitions whose duplicate would be a state-machine bug.

**Why in the evaluator, not the dispatcher.** The evaluator is already the one
writer of `notification_outbox` and the one deleter of incidents. A second
inserter of outbox rows referencing incidents takes `FOR KEY SHARE` on the
incident after its own locks, while the orphan sweep deletes the incident and
then cascades to outbox rows — the shape that deadlocked 20 of 20 in M6
§2.4.1. One writer removes the question.

### 3.4 Grouping — the dispatcher's first step

One transaction per tick, single-flight on `rollup_state` row
`notification_grouper` (`FOR UPDATE SKIP LOCKED`; no row → return):

1. `SELECT` ungrouped events with their incident, endpoint and health,
   `FOR UPDATE OF o`, ordered `service_id, created_at`. Events whose endpoint
   is gone are skipped here; the evaluator's sweep removes them.
2. Partition into groups by `(user_id, service_id, family)`, family =
   `kind`.
3. **Release rule.** A group of `incident_reminder` or `cert_expiry` is
   released at once (already due; grouped only with what is due in the same
   tick). A group of `incident_open` is released when
   - `min(created_at) + NOTIFY_GROUP_WINDOW_MS ≤ now()`, **or**
   - no other enabled endpoint of the service, not already in the group, has
     `endpoint_health.consecutive_failures > 0` and no open incident — i.e.
     nothing is failing-but-unconfirmed that could join.

   `incident_close` the same, with "recovering": an open incident and
   `consecutive_successes > 0`.

   `consecutive_failures > 0`, not `state = 'pending'`: inside a maintenance
   window M6 writes `pending` with zero failures (m6 §3.4, row 2), and that
   sibling can never be confirmed there, so it must not hold a group.

4. For a released group: preferences (`notification_preferences`, default on;
   `on_open` governs open and reminders), then the targets — every enabled
   webhook channel of the user, and the email channel when it exists, is
   enabled **and** `users.email_verified_at IS NOT NULL` (E-7). For each
   target, one `notification_deliveries` row with the payload snapshot
   (§3.8), linked to every event of the group.
5. Mark the events `grouped_at = now()`. With no delivery, `skip_reason` is
   `preference_off`, `unverified` (the email channel was the only target and
   the address is unverified), or `no_channel` — recorded, readable in the
   history, never silent.

Within one tick, open groups are written before close groups, so their
deliveries are older (the FIFO rule in §3.6 then keeps the order on the wire).

**Bound.** A group waits at most `NOTIFY_GROUP_WINDOW_MS` past its first
event plus one tick. A sibling confirmed later than that is its own group,
and its own email: E-3's window is the definition, not a hope.

### 3.5 Reminders and certificate warnings

**Reminders (E-4).** `NOTIFY_REMINDER_SCHEDULE_S`, default
`1800,7200,21600,86400`, lists offsets `o₁ … oₘ` from `confirmed_at`. Reminder
`k ≤ m` is due at `oₖ`; reminder `k > m` at `oₘ × (k − m + 1)`. At the
defaults: 30 m, 2 h, 6 h, 24 h, 48 h, 72 h… — the PRD's "then daily". The due
sequence at elapsed `e` is the largest `k` whose due time is `≤ e` (0 before
`o₁`). Each pass, for every open incident whose endpoint is enabled and not
covered by a window now (D7):

```sql
INSERT INTO notification_outbox (incident_id, endpoint_id, kind, reminder_seq, user_id, service_id)
SELECT i.id, i.endpoint_id, 'incident_reminder', d.seq, i.user_id, i.service_id
FROM   incidents i JOIN endpoints e ON e.id = i.endpoint_id,
       LATERAL (SELECT <due seq at now() - i.confirmed_at> AS seq) d
WHERE  i.closed_at IS NULL AND e.enabled AND d.seq >= 1
  AND  NOT EXISTS (<window on the endpoint or its service covering now()>)
  AND  NOT EXISTS (SELECT 1 FROM notification_outbox o
                   WHERE o.incident_id = i.id AND o.kind = 'incident_reminder' AND o.reminder_seq >= d.seq)
ON CONFLICT DO NOTHING;
```

- **Only the latest due reminder.** After a three-hour worker outage, reminders
  1 and 2 are both due; only 2 is inserted, and 1 never will be (the
  `>= d.seq` guard). One catch-up email.
- **Restart-proof.** Due time is a function of the incident row; the once is in
  the schema. Nothing is in memory (Gatus contrast).
- **No drift.** Computed from `confirmed_at`, not from when the previous email
  happened to go out (NFR-2's rule, applied to alerts).
- **Inside a window / paused:** none enqueued; the reminder due next after the
  window ends is sent. A reminder says "still down" — not true of an endpoint
  we are not probing (paused), and D-6 forbids it inside a window.

**Certificate warnings (E-5).** Thresholds 30, 14, 7, 1 days — a constant,
the PRD's values. Each pass, for every enabled endpoint with
`endpoint_health.cert_expires_at` and no window covering it now: the
**tightest** threshold crossed, `t = min{ d ∈ (30,14,7,1) : cert_expires_at − now() ≤ d days }`,
inserted with `ON CONFLICT DO NOTHING`. So:

- once per threshold per certificate — keyed by `cert_expires_at`, a renewal
  restarts the sequence with no clearing step (Kuma clears on fingerprint);
- first seen at 10 days left → the 14-day warning only, never 30 then 14 at
  once;
- a window delays a warning to the first pass after it, never loses it: the
  threshold is still crossed and has no row.

### 3.6 Sending — claim, send outside any transaction, record

**Claim** (short transaction, per tick, up to `DISPATCH_BATCH` rows):

```sql
UPDATE notification_deliveries d
SET    status = 'sending', attempts = attempts + 1, claim_token = gen_random_uuid(),
       lease_until = now() + make_interval(secs => $lease / 1000.0)
WHERE  d.id IN (
         SELECT id FROM notification_deliveries c
         WHERE  ((c.status = 'pending' AND c.not_before <= now())
              OR (c.status = 'sending' AND c.lease_until < now()))          -- a dead worker's claim
           AND  NOT EXISTS (SELECT 1 FROM notification_deliveries p           -- FIFO per (channel, service)
                            WHERE p.channel_id = c.channel_id AND p.service_id = c.service_id
                              AND p.created_at < c.created_at AND p.status IN ('pending', 'sending'))
         ORDER  BY c.created_at
         LIMIT  $batch
         FOR UPDATE SKIP LOCKED)
RETURNING d.*;
-- plus, in the same transaction: INSERT INTO notification_attempts (delivery_id, attempt, worker_id)
```

`attempts` is incremented at **claim**, so a delivery that crashes its worker
every time still reaches `NOTIFY_MAX_ATTEMPTS` and fails permanently — a
poison message is bounded. The `(delivery_id, attempt)` key makes "two workers
claimed attempt 3" unstorable.

**Send** with no transaction open and no row lock held: a slow SMTP server or
webhook receiver can block neither the evaluator, the grouper, nor a channel
delete.

**Record**, fenced on the claim:

```sql
UPDATE notification_deliveries SET … WHERE id = $id AND claim_token = $token AND status = 'sending'
```

Zero rows means the lease expired and another worker owns it, or the channel
was deleted: logged at `info`, nothing written (M4's fence, rule #21 — the
row count is read). Outcomes:

| Result                                                                                            | Status                                              | `last_error` (closed list)                                                             |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| SMTP accepted (`250`) / webhook `2xx`                                                             | `delivered`, `delivered_at`                         | —                                                                                      |
| SMTP `5xx` (`responseCode ≥ 500`)                                                                 | `failed` — the server refused this message for good | `SMTP_<code>`                                                                          |
| address fails send-time validation (D11)                                                          | `failed`                                            | `ADDRESS_INVALID`                                                                      |
| webhook `BLOCKED_BY_POLICY` (the host now resolves privately)                                     | `failed`                                            | `WEBHOOK_<code>` (e.g. `WEBHOOK_ADDRESS_NOT_ALLOWED`)                                  |
| webhook `3xx`, `410`                                                                              | `failed` (Standard Webhooks: not followed; disable) | `HTTP_<status>`                                                                        |
| SMTP `4xx`, `ESOCKET`/`ETIMEDOUT`/`ECONNECTION`; webhook other status, timeout, DNS, connect, TLS | `pending`, `not_before = now() + backoff(attempts)` | `SMTP_<code>` / `SMTP_<nodemailer code>` / `HTTP_<status>` / `WEBHOOK_<failure class>` |
| any retryable result with `attempts ≥ NOTIFY_MAX_ATTEMPTS`                                        | `failed`                                            | as above                                                                               |

`backoff(n) = min(NOTIFY_BACKOFF_BASE_MS × 2^(n−1), NOTIFY_BACKOFF_MAX_MS)`
— at the defaults 30 s, 1 m, 2 m … capped at 1 h; eight attempts span about
64 minutes before a permanent failure. No jitter: two workers never retry
the same row (single claim), and a fleet's thundering herd is not this
system's problem.

`last_error` is a code from the table, never the server's text (an SMTP
`550` message can echo the address; a webhook body is the receiver's).
`notification_attempts.error` holds the same code per attempt.

**FIFO per (channel, service).** A close never reaches a channel before the
open it resolves, even when two workers each claim one. The cost: a delivery
retrying against a broken receiver holds the next one to that receiver for
that service until it succeeds or fails permanently — which is the order a
reader of that channel needs anyway.

**At-least-once, and what makes a duplicate harmless.** The only duplicate is
a send whose success was not recorded: the worker dies, or its record write
fails, between the server's acceptance and the `UPDATE`. The lease expires and
another worker sends again.

- **Webhook:** `webhook-id` = the delivery id, the same on every attempt
  (Standard Webhooks); a receiver deduplicates on it. Harmless by contract.
- **Email:** `Message-ID: <delivery-id@probeboard.invalid>`, the same on every
  attempt, so the two copies are identifiable as one message; no client is
  relied on to deduplicate them. **Accepted risk**: a
  second identical email, bounded to the crash-in-window case and visible as
  `attempts = 2` with an earlier attempt that never finished. Open question 2.

**A delivery whose service or endpoint was deleted after it was grouped** is
still sent. Its snapshot is a true statement about the moment the alert was
raised, the user's history no longer shows it (every read joins `services`),
and holding it for ever as `pending` would be a row nothing can finish. A
channel deletion is different: the target is gone, so its deliveries go with
it by cascade.

**Lease** `DISPATCH_LEASE_MS` default 60 s, `refine`d
`≥ max(SMTP_TIMEOUT_MS, WEBHOOK_TIMEOUT_MS) + 5000`, so a live send cannot
outlast its own lease.

### 3.7 The webhook request

A caller of `probe()`, with:

| `EndpointProbeConfig` | Value                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                 | decrypted at send, never logged                                                                                                                                           |
| `method`              | `POST`                                                                                                                                                                    |
| `headers`             | `content-type: application/json`, `user-agent: probeboard-webhook/1`, `webhook-id`, `webhook-timestamp`, `webhook-signature`                                              |
| `body`                | the JSON rendering of the delivery's snapshot — deterministic, so every attempt signs the same bytes                                                                      |
| `expectedStatus`      | `[]` (any `2xx`)                                                                                                                                                          |
| `assertions`          | `[]`                                                                                                                                                                      |
| `timeoutMs`           | `WEBHOOK_TIMEOUT_MS` (15 s, Standard Webhooks' range)                                                                                                                     |
| `followRedirects`     | `false` — a `3xx` is `STATUS_MISMATCH` with its status, a permanent failure (Standard Webhooks; and following would re-POST a signed body to a host the user never saved) |

`ProbeDeps` from the shared `createProbeDeps(cfg)` with
`maxBodyBytes = WEBHOOK_MAX_RESPONSE_BYTES` (nothing reads the receiver's
body; a cap, not a literal — rule #1). So the SSRF guard
runs **per attempt** — resolve, classify every address, pin — and at save
(`assertSaveableUrl`); with no redirect followed, there is no second hop to
validate. A DNS change after save that points the host at a private address is
`BLOCKED_BY_POLICY` on the next attempt.

**Signature** (Standard Webhooks 1.0.0): secret `whsec_` + base64 of 32
CSPRNG bytes, generated by the server, shown once at create and at rotation,
stored AES-GCM. `webhook-timestamp` = the attempt's unix seconds;
`webhook-signature: v1,` + base64(HMAC-SHA256(secret bytes,
`${id}.${timestamp}.${body}`)). The test receiver verifies with the reference
algorithm written independently in the test, not with the sender's function.

**Payload** — no secret, no endpoint URL (it can carry the user's own API key
in its query), no response text:

```json
{
  "type": "incident.opened",
  "deliveryId": "…",
  "service": { "id": "…", "name": "Payments API" },
  "events": [
    {
      "incidentId": "…",
      "endpoint": { "id": "…", "name": "POST /orders", "method": "POST" },
      "openedAt": "…",
      "confirmedAt": "…",
      "closedAt": null,
      "durationMs": null,
      "cause": {
        "class": "connection_refused",
        "code": "ECONNREFUSED",
        "statusCode": null,
        "assertion": null
      },
      "consecutiveFailures": 3,
      "lastSuccessAt": "…",
      "lastResponseMs": 212,
      "reminderSeq": null,
      "certExpiresAt": null,
      "thresholdDays": null,
      "link": "https://…/endpoints/…"
    }
  ]
}
```

`type` ∈ `incident.opened | incident.resolved | incident.reminder |
cert.expiring | test`.

### 3.8 Email

- **Transport:** nodemailer 10.2.1 (pinned), SMTP from configuration only
  (07 §7.7; rule g10), `logger: false`, `debug: false` (§2.4.2). The
  password is environment configuration, not a row: "encrypted at rest"
  applies to what is stored — webhook URLs and secrets and the verification
  token's in-flight copy — and the password is kept out of every log line
  instead (REDACT_PATHS, proved by sentinel, §7).
- **Recipient (D11):** `users.email`, read at send, validated by the same
  `core` address rule registration uses (no CR/LF, one address), passed as
  `to` **and** as an explicit `envelope.to`. A stored address failing the rule
  is `failed / ADDRESS_INVALID`; nothing is sent.
- **Headers:** no user content. `Subject` from a closed vocabulary with
  numbers only — `[probeboard] Incident opened (2 endpoints)`, `Resolved`,
  `Still down`, `Certificate expires in 14 days`, `Verify your email address`,
  `Test notification`. `From` = `NOTIFY_FROM` (config, validated at boot);
  `Message-ID` from the delivery id.
- **Body:** `text/plain` only, rendered from the snapshot by a pure function.
  Service and endpoint names appear here, where a CR/LF is just text. No HTML:
  nothing to escape, nothing to inject, and a template is code, never data
  (Kuma SSTI).
- **Content** (PRD §6.8): per endpoint, service and endpoint name, class and
  code, `opened_at`, consecutive failures, last success, last response time,
  link `WEB_BASE_URL/endpoints/:id`; on resolve, the duration
  `closed_at − opened_at`; on a reminder, "down for …".

**Snapshot.** The payload is written at grouping time (§3.4 step 4) and both
renderers read only it. Every attempt sends the same content — what was true
when the alert was raised — and a webhook signs the same bytes each time.

### 3.9 Email verification (E-7)

- `POST /v1/auth/verify-email/request` (session). Under the user row lock:
  `409 EMAIL_ALREADY_VERIFIED` if verified; count this user's tokens created in
  `EMAIL_VERIFICATION_WINDOW_MS` against `EMAIL_VERIFICATION_MAX_PER_WINDOW`
  (`429`); validate the address (D11; `422 ADDRESS_INVALID` otherwise); mark
  earlier unconsumed tokens consumed; insert the token (hash, ciphertext,
  `email`, `expires_at`) and a `email_verification` delivery. Count and insert
  in one transaction — admission and record together (M1).
- The mail carries `WEB_BASE_URL/verify-email#token=pbv_…`: in the
  **fragment**, so the token is never in a request line, an access log or a
  `Referer`. The web page posts it.
- `POST /v1/auth/verify-email { token }` — no session needed (the link may
  open in another browser). Admission per address on scope `verify`
  (`AUTH_MAX_VERIFY_PER_IP`). `looksLikeToken`-style shape check, then in one
  transaction: consume by hash (single use, unexpired), lock the user row,
  check `users.email = tokens.email`, set `email_verified_at = now()` where
  null, insert the email channel `ON CONFLICT DO NOTHING`. Unknown, used,
  expired and superseded tokens all answer the same
  `400 VERIFICATION_TOKEN_INVALID`. So does an address mismatch — the token
  stays consumed and nothing is verified (no route changes an address today;
  the check makes a token prove the address it was sent to, not the account).
  The consume's row count is read, never assumed (rule #21).
- The sender nulls the token ciphertext when the delivery is `delivered` or
  `failed`; consumption nulls it too. The plaintext exists at rest only while
  the mail is in flight.
- **Consequence to state:** `email_verified_at` is what
  `OAUTH_ALLOW_EMAIL_LINKING` reads (`oauth-identity.service.ts:270-281`).
  From M7 on, a verified address can satisfy it, as social-login §8 intended.
  An integration test runs the linking policy against an M7-verified account.

### 3.10 Timing — what the PRD bound is, at the defaults

Outage begins at `t₀`. Interval `I`, threshold `N`, probe duration `d`,
evaluator tick `E = 10 s`, dispatcher tick `T = 5 s`, window `W = 60 s`, send
time `S`.

- First failed probe starts in `[t₀, t₀ + I)` — `opened_at`.
- The Nth starts `(N − 1) × I` later — `confirmed_at`; its result commits `d`
  after.
- The evaluator writes the event within `E` of the commit (M6 measured
  2.7–9.7 s).
- A lone incident's group is released at the next dispatcher tick, `≤ T`; the
  same tick claims and sends it, `S`.

**Lone: email by `t₀ + N × I + d + E + T + S`. Grouped: up to `W` more.**

| Interval | N   | PRD bound (`I + 60 s`) | Lone, worst case (`d`, `S` ≈ 0) | Holds? |
| -------- | --- | ---------------------- | ------------------------------- | ------ |
| 30 s     | 1   | 90 s                   | 45 s                            | yes    |
| 30 s     | 3   | 90 s                   | 105 s                           | no     |
| 60 s     | 1   | 120 s                  | 75 s                            | yes    |
| 60 s     | 3   | 120 s                  | 195 s                           | no     |

At the default `N = 3` the PRD sentence cannot hold for any interval: the
threshold alone costs `(N − 1) × I`, which D-1 requires. The verification run
measures `email received − opened_at` and `email received − switch flipped`
against `N × I + E + T` (§9). Open question 1.

### 3.11 HTTP surface

Session guard on all but the verify confirm. Every read and write is
owner-scoped; another user's id answers the same `404` as a random UUID.

```
POST   /v1/auth/verify-email/request                       202 | 409 EMAIL_ALREADY_VERIFIED | 422 ADDRESS_INVALID | 429
POST   /v1/auth/verify-email          { token }            204 | 400 VERIFICATION_TOKEN_INVALID | 429
GET    /v1/auth/me                                          + emailVerified

GET    /v1/notification-channels                            email channel first (synthesised, verified:false, when absent), then webhooks
POST   /v1/notification-channels      { kind: 'webhook', url }          201 + secret (once) | 400 SSRF codes | 409 WEBHOOK_QUOTA_EXCEEDED
GET    /v1/notification-channels/:id
PATCH  /v1/notification-channels/:id  { enabled?, url? }   url: webhooks only, re-checked by assertSaveableUrl
DELETE /v1/notification-channels/:id                        webhooks only; the email channel is disabled, not deleted
POST   /v1/notification-channels/:id/secret                 200 { secret } — rotate
POST   /v1/notification-channels/:id/test                   202 { deliveryId } | 409 TEST_PENDING | 409 EMAIL_NOT_VERIFIED

GET    /v1/services/:id/notification-preferences            { open, resolve, cert }
PUT    /v1/services/:id/notification-preferences            { open, resolve, cert }

GET    /v1/notification-deliveries?status&kind&serviceId&channelId&cursor&limit     E-8: failures visible
GET    /v1/notification-deliveries/:id                      + events, attempts
```

- A channel response never carries the secret (except the two `secret`
  responses) or the URL: `urlOrigin` only (`https://hooks.example.com`).
- A delivery response: `id, kind, status, attempts, notBefore, deliveredAt,
failedAt, lastError, channel { id, kind }, serviceId, events[]`, and for
  `:id`, `attempts[] { attempt, claimedAt, finishedAt, outcome, error }`.
- A skipped event has no delivery, so it is shown on its incident:
  `GET /v1/incidents/:id` gains `notifications[] { kind, groupedAt,
skipReason, deliveryIds }`. A skip is recorded only when an event produced
  no delivery at all; an unverified email beside a delivered webhook is
  visible as the absence of an email delivery, not as a reason.
- At most one `test` delivery pending per channel: the test route is a
  user-triggered outbound request, bounded so it cannot be a request
  generator.
- `WEBHOOK_CHANNEL_QUOTA_PER_USER` counted under the user row lock (M2 §5.3).
  `assertSaveableUrl` — a DNS round trip — runs **before** that lock is taken,
  never under it (rule #4; M2's measured defect). The pinned connect at every
  attempt is what covers a name that changes between the check and the save.
- `http/notifications.http` (channels, preferences, deliveries) and the
  verification requests in `http/auth.http`; `npm run openapi` in the same
  commit; the drift test covers the new routes.

**Row bound** (why retention is deferred): per incident, two transition events
plus one reminder per day open; per endpoint, four certificate rows per
certificate; per event, one delivery per channel (≤ 1 + quota). At the
defaults (100 endpoints, 5 webhooks) that is small enough that a retention
job only pays at a scale this system does not reach (ADR-0008 names the need;
follow-up row).

---

## 4. Decisions

| #   | Decision                                                                                                                                                                              | Why                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D1  | Events stay one row per transition; grouping produces deliveries that reference several events                                                                                        | C1; "once" and "grouped" are facts about different things                           |
| D2  | Delivery state on `notification_deliveries`; the outbox's four delivery columns dropped                                                                                               | C2: fan-out to several targets                                                      |
| D3  | Partial unique indexes per kind; `incident_id` nullable with a shape `CHECK`; `endpoint_id` on every event                                                                            | C3, C4                                                                              |
| D4  | Reminders and certificate warnings enqueued by the evaluator, in its transaction                                                                                                      | one writer of the outbox; M6 §2.4.1's deadlock shape avoided by construction (§3.3) |
| D5  | A group is released at the window's end **or** as soon as no sibling has `consecutive_failures > 0` without an open incident (closing: recovering)                                    | C5: a lone incident is not delayed; E-3's window is a cap                           |
| D6  | Reminder `k` due at `confirmed_at + offset(k)`, once by `(incident_id, reminder_seq)`, only the latest due one enqueued                                                               | C6; restart-proof, no drift, one catch-up email                                     |
| D7  | No reminder and no certificate warning enqueued while a window covers the endpoint or it is paused; the close is still queued                                                         | D-6; C7; a delayed certificate warning is not lost                                  |
| D8  | Certificate warnings keyed `(endpoint, cert_expires_at, threshold)`, tightest crossed threshold only                                                                                  | E-5 "once per threshold"; renewal restarts it                                       |
| D9  | `provider_email_verified` does not count for E-7                                                                                                                                      | C8                                                                                  |
| D10 | The api writes verification and test deliveries; only the worker sends                                                                                                                | ADR-0008; C9                                                                        |
| D11 | Recipient validated at send with `core`'s rule and passed as an explicit envelope; no user content in any header; plain-text body                                                     | C10, §2.4.1; header injection                                                       |
| D12 | A webhook delivery carries the same grouped payload as the email                                                                                                                      | C12                                                                                 |
| D13 | Standard Webhooks signing; secret server-generated, shown once, AES-GCM at rest; the URL encrypted too; redirects not followed; SSRF guard at save and on every attempt via `probe()` | E-9; §2.3; a receiver URL is often a credential                                     |
| D14 | Claim with a lease and `SKIP LOCKED`, `attempts` incremented at claim, send outside any transaction, record fenced on `claim_token`                                                   | at-least-once; a slow receiver holds no lock; a zombie cannot overwrite             |
| D15 | Exponential backoff, `NOTIFY_MAX_ATTEMPTS`, permanent failure recorded with a closed-list code; 5xx SMTP and policy/redirect/410 webhook results fail at once                         | E-8                                                                                 |
| D16 | FIFO per (channel, service) among non-terminal deliveries                                                                                                                             | a resolve never overtakes its open                                                  |
| D17 | Email duplicates are an accepted risk, bounded to a crash between acceptance and record; webhook duplicates are harmless by `webhook-id`                                              | the handoff asks to decide                                                          |
| D18 | Payload snapshot at grouping; renderers are pure                                                                                                                                      | every attempt sends and signs the same thing                                        |
| D19 | Verification token: `pbv_` + 32 bytes, SHA-256 at rest, single use, 24 h, superseded by a newer request, link in the URL fragment; request counted per user, confirm per address      | M1's patterns; E-7                                                                  |
| D20 | One email channel per user (the account address); webhooks up to the quota                                                                                                            | §1 Out                                                                              |
| D21 | Two migrations: enum values first                                                                                                                                                     | §2.4.3                                                                              |

---

## 5. Config

`src/core/config/schema.ts`, validated at boot; each key ships with a
rejection test.

| Key                                 | Type / bound                         | Default                                  | Note                                                       |
| ----------------------------------- | ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| `DISPATCHER_TICK_MS`                | `int().min(100).max(600_000)`        | `5_000`                                  | 07 §7.1                                                    |
| `DISPATCH_BATCH`                    | `int().min(1).max(1000)`             | `10`                                     | per claim                                                  |
| `DISPATCH_LEASE_MS`                 | `int().min(1000).max(3_600_000)`     | `60_000`                                 | `refine ≥ max(SMTP_TIMEOUT_MS, WEBHOOK_TIMEOUT_MS) + 5000` |
| `NOTIFY_GROUP_WINDOW_MS`            | `int().min(0).max(600_000)`          | `60_000`                                 | E-3; `0` turns grouping off                                |
| `NOTIFY_REMINDER_SCHEDULE_S`        | list of `int().min(60)`, ascending   | `1800,7200,21600,86400`                  | the last repeats; `refine` strictly ascending              |
| `NOTIFY_MAX_ATTEMPTS`               | `int().min(1).max(100)`              | `8`                                      | fits `smallint`                                            |
| `NOTIFY_BACKOFF_BASE_MS`            | `int().min(100).max(3_600_000)`      | `30_000`                                 |                                                            |
| `NOTIFY_BACKOFF_MAX_MS`             | `int().min(100).max(86_400_000)`     | `3_600_000`                              | `refine ≥ base`                                            |
| `NOTIFY_FROM`                       | address, no CR/LF                    | `probeboard <alerts@probeboard.invalid>` |                                                            |
| `SMTP_HOST` / `SMTP_PORT`           | host / `int().min(1).max(65535)`     | `127.0.0.1` / `1025`                     | Mailpit's port                                             |
| `SMTP_SECURE`                       | strict boolean                       | `false`                                  |                                                            |
| `SMTP_USER` / `SMTP_PASSWORD`       | optional strings                     | —                                        | `refine`: both or neither; password redacted               |
| `SMTP_TIMEOUT_MS`                   | `int().min(1000).max(120_000)`       | `15_000`                                 | connection, greeting and socket                            |
| `WEBHOOK_TIMEOUT_MS`                | `int().min(1000).max(60_000)`        | `15_000`                                 | Standard Webhooks 15–30 s                                  |
| `WEBHOOK_MAX_RESPONSE_BYTES`        | `int().min(0).max(65_536)`           | `4096`                                   | the receiver's body is read only to close the response     |
| `WEBHOOK_CHANNEL_QUOTA_PER_USER`    | `int().min(1).max(100)`              | `5`                                      |                                                            |
| `EMAIL_VERIFICATION_TTL_MS`         | `int().min(60_000).max(604_800_000)` | `86_400_000`                             |                                                            |
| `EMAIL_VERIFICATION_WINDOW_MS`      | `int().min(60_000).max(86_400_000)`  | `3_600_000`                              |                                                            |
| `EMAIL_VERIFICATION_MAX_PER_WINDOW` | `int().min(1).max(100)`              | `3`                                      |                                                            |
| `AUTH_MAX_VERIFY_PER_IP`            | `int().min(1).max(10_000)`           | `20`                                     | scope `verify`, `AUTH_WINDOW_MS`                           |

`WEB_BASE_URL` stays optional; without it emails carry no link. Compose sets it
for the api and the worker.

---

## 6. Module layout

```
src/core/users/utils/deliverable-address.ts (+ .test.ts)   the one address rule: registration, verification request, send
src/core/crypto/header-cipher.ts                           reused unchanged
src/core/db/types.ts                                       new tables and columns
src/core/db/migrations/0012_notification_kinds.{up,down}.sql
src/core/db/migrations/0013_notifications.{up,down}.sql
src/worker/probing/probe-deps.factory.ts                   moved from worker/scheduler (two callers now)
src/worker/incidents/repositories/evaluator.repository.ts  cert and total_ms; reminders; cert warnings; cert orphans
src/worker/notifications/
  notifications.module.ts
  services/dispatcher.service.ts        the tick: group, then claim/send/record
  services/email-sender.service.ts      nodemailer; explicit envelope
  services/webhook-sender.service.ts    probe() with the webhook config
  repositories/grouper.repository.ts    §3.4
  repositories/delivery.repository.ts   claim, record, attempts
  utils/render-email.ts (+ .test.ts)     snapshot → subject, text
  utils/render-webhook.ts (+ .test.ts)   snapshot → JSON bytes
  utils/webhook-signature.ts (+ .test.ts)
  utils/backoff.ts (+ .test.ts)
  utils/classify-delivery.ts (+ .test.ts)  §3.6's table
  utils/reminder-schedule.ts (+ .test.ts)  due seq from elapsed time
  e2e/
src/api/auth/                         verification routes; services/email-verification.service.ts;
                                      repositories/email-verification-token.repository.ts; utils/verification-token.ts
src/api/notifications/                notifications.module.ts, channels.controller.ts, deliveries.controller.ts,
                                      preferences.controller.ts, services/, repositories/, dto/, e2e/
src/api/incidents/                    incident response gains notifications[]
docker-compose.yml                    mailpit (axllent/mailpit:v1.32.0), SMTP_* and WEB_BASE_URL on the worker
http/notifications.http, http/auth.http
```

The due sequence is computed in TypeScript (`reminder-schedule.ts`, unit
tested at every boundary) for each open incident the reminder statement reads,
and passed to the insert as a parameter — one definition, no SQL copy of the
arithmetic. The address rule is the only new symbol both processes need; it
lives in `core`.

---

## 7. Integrity properties, and how each is proved

Every row: the test, and the removal that must make it fail.

| Property                                                        | Mechanism                                 | Proved by / removed to see it fail                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One email on open, one on close (E-1, E-2)                      | event once + one delivery per target      | acceptance: down, up → Mailpit holds 2. Removal: drop `grouped_at IS NULL` from the grouper's read → 2 opens                                                                                                                                                                            |
| A lone incident is not delayed by the window (D5)               | early release                             | one endpoint fails, siblings up → delivery `created_at − event.created_at < T`. Removal: window only → `≥ W`                                                                                                                                                                            |
| Siblings failing together → one email (E-3)                     | release rule                              | A confirmed while B has 2 of 3 failures; B confirmed inside W → one delivery, two events. Removal: drop the sibling clause → two                                                                                                                                                        |
| A sibling pending inside a window does not hold a group         | `consecutive_failures > 0`                | B in maintenance (`pending`, 0 failures) → A released at once. Removal: `state = 'pending'` → held W                                                                                                                                                                                    |
| A group waits at most W                                         | window clause                             | B stuck at 2 failures → A released at W                                                                                                                                                                                                                                                 |
| Reminders on schedule, once, restart-proof (E-4)                | D6                                        | clock at 31 m → seq 1; at 2 h 1 m → seq 2; pass repeated → no second row; worker stopped across 30 m and 2 h → only seq 2. Removal: `>= d.seq` guard → seq 1 and 2 both                                                                                                                 |
| No reminder inside a window or while paused (D7)                | `NOT EXISTS` window, `e.enabled`          | window covering seq 1's due time → none; after it → the next due. Removal → reminder inside                                                                                                                                                                                             |
| Certificate warning once per threshold, tightest only (E-5)     | D8                                        | 10 days left → one `14`; pass again → none; 6 days → `7`; renewed (new expiry) at 20 days → `30` again. Removal: insert every crossed threshold → 30 and 14 at once                                                                                                                     |
| Preferences honoured, and a skip recorded (E-6)                 | grouper                                   | `open: false` → no delivery, `skip_reason preference_off`; close still delivered. Removal → delivered                                                                                                                                                                                   |
| Unverified address gets nothing but the verification mail (E-7) | grouper + send-time read                  | unverified user, incident → no email delivery, `skip_reason unverified`; webhook still delivered. Removal → email delivery                                                                                                                                                              |
| Provider claim does not verify (D9)                             | no write path                             | OAuth sign-up with `email_verified: true` → `emailVerified false`, incident → `unverified`                                                                                                                                                                                              |
| Single-flight claim per row                                     | `FOR UPDATE SKIP LOCKED`                  | barrier: connection A holds the claim transaction open on row r; B claims → not r; A commits; B claims → not r (status/lease). Removal of `SKIP LOCKED` → B blocks; of the status predicate → r twice                                                                                   |
| A dead worker's claim is reclaimed                              | lease                                     | claim, expire lease, second claim → r, `attempts 2`. Live: §9                                                                                                                                                                                                                           |
| A zombie cannot overwrite                                       | `claim_token` fence                       | A claims, lease expires, B claims and records delivered, A records failed → 0 rows, status delivered. Removal → failed                                                                                                                                                                  |
| Two claims of one attempt are unstorable                        | `(delivery_id, attempt)` key              | direct duplicate insert → `23505`                                                                                                                                                                                                                                                       |
| Events that predate M7 are not sent                             | `0013`'s `predates_m7` update             | migrate with M6 rows present, run a grouping pass → 0 deliveries. Removal of the update → one per M6 event                                                                                                                                                                              |
| Poison message bounded                                          | `attempts` at claim                       | a send that throws every time → `failed` after `NOTIFY_MAX_ATTEMPTS`. Removal: increment at record → never fails                                                                                                                                                                        |
| Retry with backoff, then permanent failure (E-8)                | §3.6                                      | real SMTP server answering `451` → `pending`, `not_before` per `backoff`; at max → `failed / SMTP_451`, readable at `GET /v1/notification-deliveries?status=failed`                                                                                                                     |
| One row per failure class, through the real transport           | §3.6's table                              | smtp-server answering 250, 451, 550; refused port; a server that never greets (timeout). Webhook: 200, 500, 301, 410, timeout, private address. One case each, real sockets                                                                                                             |
| Close never overtakes its open (D16)                            | FIFO predicate                            | open delivery retrying, close queued → close not claimable until open is terminal. Removal → close sent first                                                                                                                                                                           |
| Webhook signature valid, id constant across retries (E-9)       | D13                                       | receiver verifies with an independently written reference; 500 then 200 → two requests, same `webhook-id`, different timestamps, both valid                                                                                                                                             |
| Webhook SSRF guard at save and per attempt (E-9)                | `assertSaveableUrl`, `probe()`            | save `http://10.0.0.1/` → `400 ADDRESS_NOT_ALLOWED`; saved name re-pointed to a private address → attempt `failed / WEBHOOK_ADDRESS_NOT_ALLOWED`, receiver hit 0 times. A **public** test address with the guard on, as M6's run did — not a loopback that the blocklist refuses anyway |
| Redirect not followed                                           | `followRedirects: false`                  | receiver answers 307 to a second listener → second listener hit 0 times, `failed / HTTP_307`                                                                                                                                                                                            |
| Every outbound request goes through `probe()` (Nezha shape)     | structure                                 | architecture test: no import of `undici`, `node:http(s)` or `fetch` in `worker/notifications` except via `worker/probing`                                                                                                                                                               |
| No recipient injection (D11)                                    | validation + explicit envelope            | stored address `a@b.test\r\nBcc: evil@x.test` (inserted directly) → `failed / ADDRESS_INVALID`, smtp-server saw 0 `RCPT`. Removal of the validation → `RCPT evil@x.test` (§2.4.1)                                                                                                       |
| No user content in a header                                     | fixed vocabulary                          | service and endpoint named `x\r\nBcc: evil@x.test` → raw message headers contain neither                                                                                                                                                                                                |
| No secret in a log line                                         | redaction, `logger: false`                | sentinels as SMTP password, webhook secret, webhook URL path and verification token; full worker and api runs; 0 occurrences in captured logs (as M2/M5)                                                                                                                                |
| No secret in a response or a delivery row                       | response mapping, snapshot                | channel list/get carry no `secret`, no URL path; `payload` and `last_error` hold no sentinel                                                                                                                                                                                            |
| Verification token single-use, expiring, superseded (D19)       | consume `UPDATE … RETURNING`              | used twice → second `400`; expired → `400`; older of two → `400`; concurrent double confirm (barrier) → one `204`. Removal of `consumed_at IS NULL` → both `204`                                                                                                                        |
| Verification confirm and request are rate-limited               | `verify` scope; per-user count under lock | burst of `AUTH_MAX_VERIFY_PER_IP + 1` → last `429`; parallel requests (20) against max 3 → exactly 3 tokens. Removal of the lock → more than 3                                                                                                                                          |
| Webhook URL and secret encrypted at rest                        | cipher                                    | `url_ciphertext` ≠ plaintext bytes; sentinel absent from `pg_dump` of the row                                                                                                                                                                                                           |
| Channel delete cannot deadlock the dispatcher                   | §3.1 table                                | 20 rounds: delete a webhook channel racing claim/record on its deliveries → 0 `40P01`                                                                                                                                                                                                   |
| Endpoint delete cannot deadlock the grouper                     | §3.1 table                                | 20 rounds: a service delete racing a grouping pass over its events → 0 `40P01`                                                                                                                                                                                                          |
| Cross-tenant reads                                              | owner-scoped queries                      | bob on alice's channel, test, preferences, delivery → `404`, byte-identical to a random UUID; lists exclude. Removal: drop the `user_id` conjunct → bob reads                                                                                                                           |

---

## 8. Test matrix

**Unit (no I/O):** reminder due-sequence at every boundary (`offset − 1 s`,
`offset`, daily steps); tightest-threshold selection; backoff; the
classification table, one row per result; the two renderers against fixed
snapshots (subject vocabulary, plain text, a CR/LF in names stays in the body);
signature against the Standard Webhooks example vector; the address rule;
verification token shape; every config key with a rejection case, including
the lease `refine` and both-or-neither SMTP credentials.

**Integration (PostgreSQL):** every row of §7 that needs the database;
migrations `0012`/`0013` up, down, up, with M6 rows present (the backfill of
`endpoint_id`); the evaluator's new steps through the real pass; the two
deadlock races; real SMTP (`smtp-server` in-process) and real HTTP receivers
bound to `127.0.0.1` with the guard off, plus the guard-on SSRF rows against a
public address resolved by the test resolver.

**Acceptance (`worker/notifications/e2e/alerting-acceptance.int.test.ts`)** —
through the real writer, evaluator, grouper and sender, a real SMTP server:

1. A verified user, one service with endpoints A and B, N = 3, M = 2.
2. A fails 3 → one open email listing A, sent at the tick after the event.
3. A recovers 2 → one resolve email with the duration.
4. A and B fail together; B confirmed one interval after A → **one** email
   listing both.
5. A stays down past the first reminder offset → one reminder.
6. `GET /v1/notification-deliveries` lists all four with `status delivered`.

---

## 9. Delivery — 3 PRs after this plan

1. **Queue.** `0012`, `0013` (+ `types.ts`, `.down`); the evaluator's
   certificate and response-time columns, reminders, certificate warnings and
   cert orphans; the `core` address rule; channels, preferences and
   verification over HTTP (the api writes verification and test deliveries
   that nothing sends yet); `http/`, `openapi.yaml`. Database and HTTP change
   → fresh clone and a real run: rows and responses for each route, a reminder
   row from a shortened schedule.
2. **Deliver.** The dispatcher: grouper, claim/send/record, email sender,
   backoff, attempts, the delivery history routes, `createProbeDeps` moved,
   Mailpit in compose, config; the §7 rows for email; acceptance 1–6.
3. **Webhook, and prove.** The webhook sender, signing, the test route's
   webhook path, the SSRF and redirect rows, the incident's
   `notifications[]`, and `docs/m7-verification.md`. Last PR: fresh clone and
   a real run from an empty volume.

**`docs/m7-verification.md`** records, from `docker-compose down -v`, two
workers, the built image, the SSRF guard on (M6's public-subnet overlay):

| Run                                                               | Evidence                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verification                                                      | request → one email in Mailpit; the link's token confirms → `emailVerified true`; the same token again → `400`                                                                             |
| Unverified user's incident                                        | no email; `skip_reason unverified` over HTTP                                                                                                                                               |
| An endpoint toggled down and up, 30 s interval                    | exactly one open and one close email in Mailpit (its API); `received − opened_at` and `received − switch flip` against `N × I + E + T` (§3.10)                                             |
| A two-endpoint service failing together                           | one grouped email listing both                                                                                                                                                             |
| A lone incident                                                   | `received − event.created_at` < `T + S`: no window wait                                                                                                                                    |
| A reminder (schedule shortened by config for the run)             | one reminder per offset; worker restarted across one → no duplicate                                                                                                                        |
| Webhook                                                           | the receiver verifies every signature; forced `500` then `200` → two requests, one `webhook-id`, `attempts 2`, `delivered`                                                                 |
| SMTP down (Mailpit stopped), backoff shortened                    | retries at the backoff times (`notification_attempts`), then `failed` with its code, visible at `GET /v1/notification-deliveries?status=failed`                                            |
| Mailpit chaos `5xx`                                               | `failed` on the first attempt                                                                                                                                                              |
| A worker `SIGKILL`ed mid-send (receiver holding the request 20 s) | the survivor reclaims after the lease: no delivery left `sending`, no `(delivery, attempt)` claimed twice, the receiver sees the same `webhook-id` twice — the accepted duplicate, counted |
| Logs                                                              | sentinel SMTP password, webhook secret, webhook URL path and verification token: 0 occurrences in every container's log                                                                    |

Numbers appear there only once measured.

---

## 10. Open questions — flagged, not resolved quietly

1. **PRD §6.12 item 3** (C11, m6 §10 item 1). At `N = 3` the bound cannot
   hold at any interval (§3.10's table); at `N = 1` a lone incident fits with
   room. Recommendation: amend to **"within `N × interval + 15 s` of an
   endpoint going down, plus the grouping window when siblings are failing"**
   — the `15 s` is `E + T` — and the verification run measures against it.
2. **Email duplicates** (D17): accepted, bounded to a crash between the SMTP
   server's acceptance and the record write, and visible as two attempts.
   Recommendation: accept; the alternative (two-phase with the SMTP server) does
   not exist.
3. **`probeboard-docs` corrections** (outside this checkout — reported, not
   made): 07 §7.7's `group_key`/`payload`/`UNIQUE (group_key)`/
   `not_before = now() + 60s` and `incidents.last_notified_at` (C1, C5, C6);
   ADR-0008's mechanism table, same three rows.
4. **M9 needs two web routes** (reported to the orchestrator, not made):
   `/verify-email` reading `#token=` and posting it, and `/endpoints/:id` as
   the email's link target.
5. **Provider addresses are stored unvalidated** (C10). M7 makes sending safe
   (validated at send, explicit envelope). Whether social login should also
   refuse a malformed provider address at sign-up is a separate, small
   follow-up; recommendation: yes, with the same `core` rule.
6. **Deferred to follow-ups:** retention of delivered deliveries and grouped
   events (§3.11 bound); a manual "retry this failed delivery" route;
   secret rotation with an overlap window.

---

## Sources

- `probeboard-docs/en/02-requirements.md` FR-28…FR-31; `06-prd.md` §6.2,
  §6.7 D-6, §6.8 E-1…E-9 (149–169), §6.12; `07-architecture.md` §7.1, §7.7,
  §7.8; `08-plan.md` row M7; `adr/0008-notification-outbox.md`
- `docs/m6-plan.md` §2.4.1, §3.3, §3.4, §3.8, C5, D9, D13, §10;
  `docs/m6-verification.md`; `docs/tracker.md`
- Code on `main` at `610c5d1`: `src/worker/incidents/repositories/evaluator.repository.ts`,
  `src/worker/incidents/services/evaluator.service.ts`, `src/worker/main.ts`,
  `src/worker/probing/utils/probe.ts`, `src/worker/scheduler/probe-deps.factory.ts`,
  `src/core/ssrf/host-validator.ts`, `src/core/crypto/header-cipher.ts`,
  `src/api/auth/utils/session-token.ts`, `src/api/auth/services/rate-limit.service.ts`,
  `src/api/auth/services/oauth-identity.service.ts`, `src/core/users/repositories/user.repository.ts`,
  `src/api/auth/strategies/{google,github}.strategy.ts`, `src/core/db/migrations/0002`, `0003`, `0009`, `0011`,
  `docker-compose.yml`
- `references/healthchecks` (BSD-3, `425ee00`): `hc/api/management/commands/sendalerts.py`,
  `hc/api/transports.py`, `hc/lib/curl.py`, `hc/api/models.py`, `hc/accounts/models.py`
- `references/uptime-kuma` (MIT, `3afdc9c`): `server/model/monitor.js`, `server/util-server.js`,
  `server/notification-providers/webhook.js`; louislam/uptime-kuma#6046, #1422;
  GHSA-vffh-c9pq-4crh; CVE-2024-56331
- `references/gatus` (Apache-2.0, `7f3873d`): `watchdog/alerting.go`, `alerting/alert/alert.go`,
  `config/endpoint/endpoint.go`, `alerting/provider/email/email.go`; TwiN/gatus#764
- `references/cachet`, `references/cachet-core` (Cachet licence, read-only; `6f9cf09`, `8ae3e2c`):
  `src/Models/WebhookSubscription.php`, `src/Filament/Resources/WebhookSubscriptions/`
- Nezha CVE-2026-47268; nodemailer CVE-2021-23400, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w,
  GHSA-85x2-q946-cp5h (`npm audit` against 10.1.3 and 10.2.1)
- Standard Webhooks specification 1.0.0, `spec/standard-webhooks.md`
- Measurements in §2.4: Node 22.23.2, nodemailer 10.2.1, smtp-server 3, PostgreSQL 17.11,
  Mailpit v1.32.0
