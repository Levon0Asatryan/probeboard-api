-- Registration gets its own per-address budget (#72, tracker row on the
-- shared budget). Until now a registration drew on scope 'ip', the same
-- counter login admits against, so twenty registrations from one address --
-- a university network, a thesis demo room behind one NAT -- locked everyone
-- behind that address out of login for the whole window. 'register' counts
-- registrations by address, apart from 'ip'.
ALTER TABLE auth_attempts DROP CONSTRAINT auth_attempts_scope_check;
ALTER TABLE auth_attempts
    ADD CONSTRAINT auth_attempts_scope_check CHECK (scope IN ('ip', 'email', 'register'));
