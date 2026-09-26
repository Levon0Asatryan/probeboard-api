-- Counters only, kept for AUTH_WINDOW_MS: dropping the registration ones
-- loses nothing a user would miss, and the old constraint cannot be restored
-- while they exist.
DELETE FROM auth_attempts WHERE scope = 'register';
ALTER TABLE auth_attempts DROP CONSTRAINT auth_attempts_scope_check;
ALTER TABLE auth_attempts
    ADD CONSTRAINT auth_attempts_scope_check CHECK (scope IN ('ip', 'email'));
