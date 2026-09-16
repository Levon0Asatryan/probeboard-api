-- Composite indexes for the paginated, tag-filterable list queries
-- (ServiceRepository.list, EndpointRepository.list/.listForService):
-- WHERE <owner column(s)> = ... ORDER BY id LIMIT $n, with the tag filter
-- as a LATERAL-joined correlated lookup against tags.
--
-- The single-column owner indexes this replaces (services_user_id_idx,
-- endpoints_user_id_idx, endpoints_service_id_idx) satisfy the WHERE
-- clause but not the ORDER BY, and endpoints.listForService filters two
-- columns (service_id, user_id) that used to have no index covering both
-- together. A row-count estimate the planner gets wrong -- which it
-- always does immediately after a bulk insert, before autovacuum's
-- autoanalyze catches up -- can then make it choose a plan that
-- materializes and sorts every matching row before applying LIMIT (for a
-- single filter column), or a BitmapAnd across two separate indexes that
-- loses index order entirely (for the two-column case), rather than one
-- that walks a single composite index in id order and stops at the first
-- few matches. A composite index ending in `id`, covering every equality
-- filter the query applies, removes the choice that estimate error can
-- get wrong -- confirmed against all three query shapes with
-- EXPLAIN (ANALYZE, BUFFERS) under artificially unanalyzed statistics
-- (the listForService case reproduced an 80-second real query locally,
-- not just a worse cost estimate), recorded in docs/m2-verification.md.
DROP INDEX services_user_id_idx;
CREATE INDEX services_user_id_id_idx ON services (user_id, id);

DROP INDEX endpoints_user_id_idx;
CREATE INDEX endpoints_user_id_id_idx ON endpoints (user_id, id);

DROP INDEX endpoints_service_id_idx;
CREATE INDEX endpoints_service_id_user_id_id_idx ON endpoints (service_id, user_id, id);
