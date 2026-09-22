-- claim_log first: both reference endpoints, and dropping in reverse creation
-- order keeps this readable next to the up migration.
DROP TABLE IF EXISTS claim_log;
DROP TABLE IF EXISTS endpoint_runtime;
