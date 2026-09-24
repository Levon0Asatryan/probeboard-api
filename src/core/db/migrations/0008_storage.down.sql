-- Dropping a partitioned parent drops its attached partitions.
DROP TABLE IF EXISTS rollup_state;
DROP TABLE IF EXISTS probe_stats;
DROP TABLE IF EXISTS probe_results;
DROP TABLE IF EXISTS claim_log;

-- claim_log as 0007 left it.
CREATE TABLE claim_log (
    id           bigserial   PRIMARY KEY,
    endpoint_id  uuid        NOT NULL,
    scheduled_at timestamptz NOT NULL,
    worker_id    text        NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_log_slot_idx ON claim_log (endpoint_id, scheduled_at);
