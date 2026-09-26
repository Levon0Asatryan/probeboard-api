-- The constraints only. The up migration's repair of out-of-bounds rows is
-- not reversed: the original values are not kept, and restoring them would
-- restore exactly what PRD §6.5 forbids.
ALTER TABLE endpoints
    DROP CONSTRAINT IF EXISTS endpoints_timeout_under_interval_check,
    DROP CONSTRAINT IF EXISTS endpoints_success_threshold_check,
    DROP CONSTRAINT IF EXISTS endpoints_failure_threshold_check;
