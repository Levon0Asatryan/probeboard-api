-- M4's scheduler state: what is due, who holds it, and when it runs next.
-- Sources: docs/m4-plan.md §3.1-§3.3; ADR-0002; NFR-1..NFR-4, NFR-7, FR-17.

-- One row per endpoint, 1:1 and hot. Every column here is written on every
-- probe; endpoints' columns are written almost never (docs/m4-plan.md §3.2).
-- Splitting them keeps this row narrow so the update stays HOT, keeps that
-- churn off endpoints' five indexes, and keeps the API and the worker writing
-- disjoint tables -- the API never touches this one, the scheduler never
-- writes endpoints.
CREATE TABLE endpoint_runtime (
    endpoint_id          uuid        PRIMARY KEY REFERENCES endpoints (id) ON DELETE CASCADE,
    -- The next slot this endpoint is due. Always derived from the previous
    -- slot, never from now() (NFR-2), so drift cannot accumulate.
    next_run_at          timestamptz NOT NULL,
    -- The slot the current or most recent claim owns. NULL until the first
    -- claim. This is the identity NFR-3 is written in terms of: "no monitor
    -- is probed twice for the same scheduled slot".
    scheduled_at         timestamptz,
    -- Which interval next_run_at was computed with. Provenance, never
    -- authority (docs/m4-plan.md D26): the claim joins endpoints for the
    -- value it schedules by, so a stale copy here cannot cause a probe at the
    -- wrong cadence. Reconciliation compares the two to tell "the user
    -- changed the interval" from "the catch-up guard jumped several slots" --
    -- comparing the slot arithmetic instead rewinds a caught-up row into the
    -- past and replays its whole backlog.
    scheduled_interval_s integer,
    -- Held while a probe is in flight. A dead worker's claim becomes
    -- reclaimable when this lapses (NFR-4).
    leased_until         timestamptz,
    -- Which worker holds it. Also the fence on every release: a worker whose
    -- lease already lapsed must not clear a lease a different worker has
    -- since taken (docs/m4-plan.md D13).
    leased_by            text,
    -- Set only when a probe actually produced an observation. A slot that was
    -- abandoned without probing deliberately leaves this alone, or M6's
    -- UNKNOWN sweep would see it as freshly probed and skip the gap.
    last_probe_at        timestamptz
);

-- The claim's ordering key. No partial index on `enabled`: that column stays
-- on endpoints and is joined (docs/m4-plan.md D2), because a mirrored copy
-- with no enforcement is a paused monitor that keeps being probed. Measured:
-- the planner index-scans this in order and rejects disabled rows in the
-- nested loop, reading 111 entries for a 100-row batch at 10% disabled, and
-- 123 at 50,000 endpoints (docs/m4-plan.md §2.4.2).
CREATE INDEX endpoint_runtime_next_run_at_idx ON endpoint_runtime (next_run_at);

-- One row per claim: which worker took which slot, written by the claim
-- statement itself through a data-modifying CTE, before any probe runs
-- (docs/m4-plan.md D25).
--
-- This is the only durable, slot-keyed record of an attempt that M4 has, and
-- it is what the milestone's exit test reads. endpoint_runtime keeps only the
-- latest scheduled_at, so a later claim overwrites the evidence; a worker's
-- own log line can die with the container it was killed in; and the probe
-- receiver sees a path and an arrival time, which is a wall-clock window
-- rather than slot identity.
-- No foreign key on endpoint_id, deliberately, and it is a correctness
-- requirement rather than a preference.
--
-- An INSERT against a referencing column takes FOR KEY SHARE on the parent
-- row. The claim locks endpoint_runtime first (the `due` CTE) and would then
-- ask for endpoints last -- the exact inverse of the order a cascading
-- DELETE takes them, since that locks endpoints first and fires the cascade
-- into endpoint_runtime at statement end. Measured: one claim of 300 rows
-- racing one `DELETE FROM endpoints WHERE service_id = ...` deadlocked in
-- **20 of 20** rounds with the FK present and **0 of 20** without it. It also
-- contradicts docs/m4-plan.md §3.1 in its own words -- "endpoints is read but
-- never locked ... a claim cannot block the API" -- which is true of the
-- `FOR UPDATE OF r` clause and was untrue of the statement as a whole.
--
-- Nothing is lost. This is an append-only evidence log, not relational state:
-- "endpoint X was claimed for slot T by worker W" stays true after the
-- endpoint is deleted, and the exit test's duplicate query groups by
-- (endpoint_id, scheduled_at) without ever joining endpoints. Retention is
-- M5's, along with the partitioning it already owns.
CREATE TABLE claim_log (
    id           bigserial   PRIMARY KEY,
    endpoint_id  uuid        NOT NULL,
    scheduled_at timestamptz NOT NULL,
    worker_id    text        NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NOT unique on (endpoint_id, scheduled_at): a duplicate claim is
-- the defect this table exists to *record*, and a unique constraint would
-- reject the evidence instead of capturing it.
CREATE INDEX claim_log_slot_idx ON claim_log (endpoint_id, scheduled_at);
