-- M5's storage: raw results, aggregates, the rollup watermark, and a
-- partitioned claim_log. Sources: docs/m5-plan.md §3.1-§3.9; ADR-0003, ADR-0007;
-- NFR-8, NFR-9, FR-34.
--
-- probe_outcome, failure_class and stat_grain already exist (0001) and are
-- reused; failure_class labels there are lowercase.
--
-- Every partitioned parent below is created with NO partitions. They are
-- created ahead of need by the worker's maintenance job (PartitionService),
-- never here and never on the write path, and there is deliberately no DEFAULT
-- partition: a missing partition must be an error, because a default one would
-- quietly reintroduce the unbounded table ADR-0007 exists to prevent.
--
-- No foreign keys on any table here. claim_log's measured deadlock (0007: 20 of
-- 20 rounds with the FK) applies to every hot append-only table that would
-- reference endpoints, and a row for a deleted endpoint simply ages out.

CREATE TABLE probe_results (
    endpoint_id     uuid          NOT NULL,
    -- The worker's wall clock, millisecond precision. The partition key.
    started_at      timestamptz   NOT NULL,
    -- The claimed slot, microseconds, as the database produced it. Deliberately
    -- not unique: two probes of one slot are an NFR-3 violation to be recorded,
    -- not rejected.
    scheduled_at    timestamptz   NOT NULL,
    -- Spacing to the NEXT slot: the span this probe represents (time weighting).
    interval_s      integer       NOT NULL,
    outcome         probe_outcome NOT NULL,
    failure_class   failure_class,
    -- The raw signal behind the class, kept even when unrecognised.
    failure_code    text,
    status_code     smallint,
    total_ms        integer       NOT NULL,
    -- NULL means the phase did not happen, never 0.
    dns_ms          integer,
    connect_ms      integer,
    tls_ms          integer,
    ttfb_ms         integer,
    transfer_ms     integer,
    redirects       smallint      NOT NULL,
    truncated       boolean       NOT NULL,
    cert_expires_at timestamptz,
    worker_id       text          NOT NULL,
    -- One per probe attempt, generated before the probe and reused only by
    -- retries of that attempt's write. Keeps a same-millisecond duplicate, or a
    -- clock-corrected one on the same worker, a separate row.
    attempt_id      uuid          NOT NULL,
    -- The inserting transaction. The rollup's watermark is over this, bounded
    -- by the snapshot horizon, so a row that commits late is never skipped.
    insert_xid      xid8          NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (endpoint_id, started_at, attempt_id)
) PARTITION BY RANGE (started_at);

CREATE INDEX probe_results_insert_xid_idx ON probe_results (insert_xid);

-- The `DEFAULT 0` on the counters and sums below are not limits: 0 is the
-- identity of the additive fold (`col = s.col + EXCLUDED.col`), and the fold
-- always supplies the initial values itself. Nothing here is a bound, an
-- interval or a cap, so rule #1 (limits come from validated config) does not
-- apply; the histogram default is the same zero vector.
CREATE TABLE probe_stats (
    endpoint_id       uuid        NOT NULL,
    granularity       stat_grain  NOT NULL,
    bucket_start      timestamptz NOT NULL,
    count_up          integer     NOT NULL DEFAULT 0,
    count_down        integer     NOT NULL DEFAULT 0,
    count_degraded    integer     NOT NULL DEFAULT 0,
    count_unknown     integer     NOT NULL DEFAULT 0,
    -- M6/M7's; M5 never writes it.
    count_maintenance integer     NOT NULL DEFAULT 0,
    -- Seconds observed: up + down + degraded. An unknown probe adds none.
    covered_seconds   integer     NOT NULL DEFAULT 0,
    up_seconds        integer     NOT NULL DEFAULT 0,
    degraded_seconds  integer     NOT NULL DEFAULT 0,
    -- The latency population is rows whose endpoint produced response headers
    -- (ttfb_ms IS NOT NULL); one rule for all four columns and the histogram.
    sum_total_ms      bigint      NOT NULL DEFAULT 0,
    min_total_ms      integer,
    max_total_ms      integer,
    sum_ttfb_ms       bigint      NOT NULL DEFAULT 0,
    hist_total        integer[]   NOT NULL DEFAULT array_fill(0, ARRAY[20]),
    PRIMARY KEY (endpoint_id, granularity, bucket_start),
    CHECK (array_length(hist_total, 1) = 20)
) PARTITION BY LIST (granularity);

-- m1 and h1 are retention-bound (an m1 row per probe is as many rows as raw at
-- a 60 s interval), so each is range-partitioned. d1 is 365 rows per endpoint
-- per year and stays one table.
CREATE TABLE probe_stats_m1 PARTITION OF probe_stats
    FOR VALUES IN ('m1') PARTITION BY RANGE (bucket_start);
CREATE TABLE probe_stats_h1 PARTITION OF probe_stats
    FOR VALUES IN ('h1') PARTITION BY RANGE (bucket_start);
CREATE TABLE probe_stats_d1 PARTITION OF probe_stats
    FOR VALUES IN ('d1');

-- One row. Every probe_results row with insert_xid < last_xid has been folded
-- into probe_stats; the fold and this update commit together.
CREATE TABLE rollup_state (
    name        text        PRIMARY KEY,
    last_xid    xid8        NOT NULL,
    advanced_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rollup_state (name, last_xid) VALUES ('probe_results', '0');

-- claim_log becomes partitioned so its retention is a drop, not a DELETE
-- (docs/m5-plan.md §3.9). bigserial cannot be a primary key on a partitioned
-- table and nothing reads `id`, so it goes.
--
-- Data that predates this: none deployed. The M4 exit-test evidence is
-- recorded in docs/m4-verification.md, and the table on a developer's volume
-- is disposable.
DROP TABLE claim_log;

CREATE TABLE claim_log (
    endpoint_id  uuid        NOT NULL,
    scheduled_at timestamptz NOT NULL,
    worker_id    text        NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (claimed_at);

-- Deliberately NOT unique: a duplicate claim is what this table exists to record.
CREATE INDEX claim_log_slot_idx ON claim_log (endpoint_id, scheduled_at);
