DROP TABLE IF EXISTS oauth_authorizations;
DROP TABLE IF EXISTS oauth_identities;

-- Deliberately unconditional, and deliberately allowed to fail.
--
-- If any account was created through a provider it has no password, and
-- restoring NOT NULL cannot succeed. The alternatives are worse: deleting
-- those accounts destroys data to make a rollback tidy, and writing a sentinel
-- hash leaves accounts that look password-protected and are not. Failing here
-- says exactly what is wrong and leaves the operator to decide.
--
-- On an empty database -- CI's rollback check, and a fresh developer machine --
-- it simply succeeds.
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
