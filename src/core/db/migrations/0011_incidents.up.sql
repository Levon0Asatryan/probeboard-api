-- M6's incidents: what a result says about itself, the evaluator's state, the
-- incidents it opens and the notifications they queue.
-- Sources: docs/m6-plan.md §3.1; FR-24..27; D-1..D-7; ADR-0008.

-- What M6 needs to judge a result, decided once when it is written
-- (docs/m6-plan.md §3.2) so a later window or threshold edit never rewrites a
-- recorded verdict. Metadata-only on the partitioned parent: measured at
-- 0.78 ms against a 2,000,000-row partition, and partitions created later by
-- `LIKE ... INCLUDING ALL` carry both columns (plan §2.4.3).
ALTER TABLE probe_results
    -- A declared window covered started_at. The row keeps its true outcome;
    -- the fold and the evaluator are what treat it differently (plan D6).
    ADD COLUMN in_maintenance boolean NOT NULL DEFAULT false,
    -- Which assertion failed: { index, code, assertion }. NULL unless the
    -- class is assertion_failed. Never response text (NFR-13, plan D11).
    ADD COLUMN failure_detail jsonb;

-- One-off windows on a service or on one endpoint (plan §3.7). Only the API
-- writes this table and the worker reads it without locks, so it keeps its
-- foreign keys: no evaluator lock can meet a cascading delete here.
CREATE TABLE maintenance_windows (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    service_id  uuid        REFERENCES services (id) ON DELETE CASCADE,
    endpoint_id uuid        REFERENCES endpoints (id) ON DELETE CASCADE,
    -- [starts_at, ends_at): a probe at starts_at is inside, one at ends_at is not.
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_windows_one_target CHECK ((service_id IS NULL) <> (endpoint_id IS NULL)),
    CONSTRAINT maintenance_windows_ordered    CHECK (ends_at > starts_at)
);
-- The writer's lookup: a window on this endpoint or its service that has not
-- ended by started_at.
CREATE INDEX maintenance_windows_service_idx  ON maintenance_windows (service_id, ends_at)  WHERE service_id  IS NOT NULL;
CREATE INDEX maintenance_windows_endpoint_idx ON maintenance_windows (endpoint_id, ends_at) WHERE endpoint_id IS NOT NULL;
-- The per-user quota count and listing.
CREATE INDEX maintenance_windows_user_idx     ON maintenance_windows (user_id);

-- The evaluator's per-endpoint state (plan §3.4). A table of its own rather
-- than columns on endpoint_runtime (plan C1): the claim `SKIP LOCKED`s every
-- runtime row the evaluator would hold, and that row is kept narrow on purpose.
--
-- No foreign key to endpoints, and it is a correctness requirement: an
-- evaluator pass locks this row and then inserts an incident, while a
-- cascading delete locks endpoints and then this row -- measured at 20
-- deadlocks in 20 rounds with the key and 0 in 20 without (plan §2.4.1). The
-- evaluator removes a deleted endpoint's row itself (plan §3.12).
CREATE TABLE endpoint_health (
    endpoint_id           uuid           PRIMARY KEY,
    -- Only the observed states. paused and maintenance are configuration and
    -- are derived when read (plan C7).
    state                 endpoint_state NOT NULL,
    -- When state last changed: the observation's started_at, or the sweep's now().
    state_since           timestamptz    NOT NULL,
    -- integer, not smallint: the success run grows on every healthy probe and
    -- a smallint overflows after 11.4 days at 30 s (plan C2).
    consecutive_failures  integer        NOT NULL DEFAULT 0 CHECK (consecutive_failures  >= 0),
    consecutive_successes integer        NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
    -- The first failed probe of the current run -- opened_at (D-2) -- and its
    -- evidence, copied because the raw row ages out (plan C8).
    run_started_at        timestamptz,
    run_failure_class     failure_class,
    run_failure_code      text,
    run_status_code       smallint,
    run_failure_detail    jsonb,
    -- The first success of the current recovery run -- closed_at (03 §3.8).
    recovery_started_at   timestamptz,
    open_incident_id      uuid,
    last_success_at       timestamptz,
    -- The newest observation applied. An older one arriving later (a zombie
    -- write after a lapsed lease) is stored and folded, never applied (plan D3).
    applied_started_at    timestamptz,
    applied_attempt_id    uuid,
    updated_at            timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT endpoint_health_observed_state
        CHECK (state IN ('up', 'degraded', 'pending', 'down', 'unknown')),
    CONSTRAINT endpoint_health_run_shape
        CHECK ((consecutive_failures = 0) = (run_started_at IS NULL))
);

CREATE TABLE incidents (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    -- No foreign key, for endpoint_health's reason above. Reads join
    -- endpoints, so a deleted endpoint's incidents are gone for its owner at
    -- once, and the evaluator removes the rows.
    endpoint_id        uuid          NOT NULL,
    -- Denormalized: an endpoint never changes service or owner.
    service_id         uuid          NOT NULL,
    user_id            uuid          NOT NULL,
    -- Probe started_at values, never the evaluator's clock (plan §3.5).
    opened_at          timestamptz   NOT NULL,   -- the first failed probe (D-2)
    confirmed_at       timestamptz   NOT NULL,   -- the Nth; detection latency = confirmed_at - opened_at
    failures_to_open   smallint      NOT NULL,   -- N in force when it opened
    cause_class        failure_class NOT NULL,   -- of the first failed probe (FR-26)
    cause_code         text,
    cause_status_code  smallint,
    cause_detail       jsonb,
    closed_at          timestamptz,              -- the first success of the recovery run
    close_confirmed_at timestamptz,              -- the Mth
    CONSTRAINT incidents_confirmed_after_open CHECK (confirmed_at >= opened_at),
    CONSTRAINT incidents_close_pair           CHECK ((closed_at IS NULL) = (close_confirmed_at IS NULL)),
    CONSTRAINT incidents_close_order
        CHECK (closed_at IS NULL OR (closed_at > opened_at AND close_confirmed_at >= closed_at))
);
-- One open incident per endpoint, held by the schema. The evaluator inserts
-- plainly, so a state-machine bug surfaces as a failed pass, never as a
-- silently skipped insert (plan §3.3 step 6).
CREATE UNIQUE INDEX incidents_one_open_idx ON incidents (endpoint_id) WHERE closed_at IS NULL;
-- History, newest first, per endpoint, per service and per user (D-5).
CREATE INDEX incidents_endpoint_idx ON incidents (endpoint_id, opened_at DESC, id DESC);
CREATE INDEX incidents_service_idx  ON incidents (service_id,  opened_at DESC, id DESC);
CREATE INDEX incidents_user_idx     ON incidents (user_id,     opened_at DESC, id DESC);

CREATE TYPE notification_kind AS ENUM ('incident_open', 'incident_close');

-- Written in the transaction that opens or closes the incident (ADR-0008),
-- drained by M7. One row per transition; grouping (E-3) is M7's, at drain
-- time (plan C5). No payload: M7 renders from the incident row.
CREATE TABLE notification_outbox (
    id           uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Kept as a foreign key: both rows are written by the evaluator in one
    -- transaction, and only the evaluator ever deletes an incident.
    incident_id  uuid              NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    kind         notification_kind NOT NULL,
    user_id      uuid              NOT NULL,
    service_id   uuid              NOT NULL,
    created_at   timestamptz       NOT NULL DEFAULT now(),
    -- M7's; present so M7 starts from 07 §7.7's shape.
    not_before   timestamptz       NOT NULL DEFAULT now(),
    attempts     smallint          NOT NULL DEFAULT 0,
    delivered_at timestamptz,
    last_error   text,
    -- E-1, "sent once, on open", held by the schema.
    CONSTRAINT notification_outbox_once UNIQUE (incident_id, kind)
);

-- The evaluator's watermark, a second consumer row beside the rollup's.
-- Started at the horizon rather than at 0: results that predate M6 would be
-- evaluated with no prior state and queue notifications for the past
-- (plan D15). Every transaction below the horizon has finished, so no row can
-- commit beneath it later.
INSERT INTO rollup_state (name, last_xid)
VALUES ('incident_evaluator', pg_snapshot_xmin(pg_current_snapshot()));
