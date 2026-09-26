-- PRD §6.5's per-endpoint bounds, held by the table itself (#72, defect 5).
--
-- The request schema now refuses thresholds outside 1-10 and a timeout not
-- under the interval, but a schema only judges the next save. A row stored
-- under the old, wider bounds would still reach M6's hysteresis as, say,
-- failure_threshold = 100 -- an incident opened after 100 failures, against a
-- PRD that promises at most 10. So stored rows are brought inside the bounds
-- first, then the bounds become constraints no later write can cross.
--
-- The repair moves each value to the nearest allowed one: a threshold to 1 or
-- 10, a timeout to one millisecond under its interval. No deployment exists
-- (there is no production data to consult), so this is the story for whatever
-- rows a development database happens to hold, not a data migration anyone
-- has to plan for. method is deliberately not constrained: an endpoint saved
-- as OPTIONS keeps probing exactly what its owner asked for, and nothing reads
-- the method as a bound.
UPDATE endpoints
   SET failure_threshold = LEAST(GREATEST(failure_threshold, 1), 10),
       success_threshold = LEAST(GREATEST(success_threshold, 1), 10),
       timeout_ms        = LEAST(timeout_ms, interval_s * 1000 - 1)
 WHERE failure_threshold NOT BETWEEN 1 AND 10
    OR success_threshold NOT BETWEEN 1 AND 10
    OR timeout_ms >= interval_s * 1000;

ALTER TABLE endpoints
    ADD CONSTRAINT endpoints_failure_threshold_check CHECK (failure_threshold BETWEEN 1 AND 10),
    ADD CONSTRAINT endpoints_success_threshold_check CHECK (success_threshold BETWEEN 1 AND 10),
    ADD CONSTRAINT endpoints_timeout_under_interval_check CHECK (timeout_ms < interval_s * 1000);
