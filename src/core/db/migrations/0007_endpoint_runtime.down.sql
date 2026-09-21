-- claim_log first: both reference endpoints, and dropping in reverse creation
-- order keeps this readable next to the up migration.
DROP TABLE claim_log;
DROP TABLE endpoint_runtime;
