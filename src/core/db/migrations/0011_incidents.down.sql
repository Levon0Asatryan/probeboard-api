DELETE FROM rollup_state WHERE name = 'incident_evaluator';
DROP TABLE IF EXISTS notification_outbox;
DROP TYPE IF EXISTS notification_kind;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS endpoint_health;
DROP TABLE IF EXISTS maintenance_windows;
ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_id_user_id_key;
ALTER TABLE probe_results
    DROP COLUMN IF EXISTS failure_detail,
    DROP COLUMN IF EXISTS in_maintenance;
