-- Social login: provider identities, and flows in progress.
-- Sources: docs/social-login-plan.md §4; stories A-7, A-8.

-- An account may now exist with no password, because it signs in through a
-- provider. The invariant "every account has at least one way to sign in"
-- spans two tables and so cannot be a CHECK; it is enforced at unlink, which
-- is the only operation that can break it, and covered by a test.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- A provider account, tied to a probeboard account.
--
-- The identity is (provider, provider_account_id) and never the email address.
-- Matching an incoming provider identity to an account by email is a published
-- account-takeover primitive -- Better Auth CVE-2026-53516, Grafana
-- CVE-2023-3128, and Google Workspace domain re-registration all reduce to it.
-- An address is an attribute of an account, not the identity of one.
CREATE TABLE oauth_identities (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider                text        NOT NULL CHECK (provider IN ('google', 'github')),
    -- Google's 'sub', GitHub's numeric id as text. Never GitHub's login: a
    -- username released by a rename can be claimed by somebody else, who would
    -- then sign in to their predecessor's account.
    provider_account_id     text        NOT NULL,
    -- What the provider last said. Kept for display and for support questions,
    -- never used as a lookup key.
    provider_email          text,
    provider_email_verified boolean     NOT NULL DEFAULT false,
    created_at              timestamptz NOT NULL DEFAULT now(),
    last_login_at           timestamptz NOT NULL DEFAULT now()
);

-- One provider account signs in to exactly one probeboard account. This is the
-- constraint that makes identity theft between accounts impossible rather than
-- merely unimplemented.
CREATE UNIQUE INDEX oauth_identities_provider_account_key
    ON oauth_identities (provider, provider_account_id);

-- And one probeboard account holds at most one identity per provider, so
-- "unlink Google" is unambiguous.
CREATE UNIQUE INDEX oauth_identities_user_provider_key
    ON oauth_identities (user_id, provider);

CREATE INDEX oauth_identities_user_id_idx ON oauth_identities (user_id);

-- A flow in progress: issued at /start, consumed at /callback, single use.
--
-- A row rather than a signed cookie for three reasons. Single use is
-- enforceable here -- the callback consumes it with DELETE ... RETURNING, so a
-- replayed callback finds nothing, which a stateless cookie cannot express.
-- The PKCE verifier and the nonce are secrets, and a signed cookie is signed,
-- not encrypted. And session state already lives in PostgreSQL (ADR-0001).
CREATE TABLE oauth_authorizations (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      text        NOT NULL CHECK (provider IN ('google', 'github')),
    -- 'signin' finds or creates an account; 'link' attaches the identity to
    -- user_id, which is why it must be present for exactly that mode.
    mode          text        NOT NULL CHECK (mode IN ('signin', 'link')),
    user_id       uuid        REFERENCES users (id) ON DELETE CASCADE,
    state         text        NOT NULL,
    code_verifier text        NOT NULL,
    -- OIDC only. GitHub has nowhere to put a nonce, so replay protection there
    -- rests on PKCE and the single-use authorization code.
    nonce         text,
    -- A path, already validated. Never an absolute URL: a return target that
    -- can carry a scheme and host is an open redirect.
    return_to     text        NOT NULL DEFAULT '/',
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,

    CONSTRAINT oauth_authorizations_link_has_user
        CHECK ((mode = 'link') = (user_id IS NOT NULL))
);

-- The callback is looked up by the cookie's id and then compared against the
-- state from the query string. Either alone would do; both together mean a
-- stolen cookie without the callback URL, or a callback URL without the
-- cookie, is useless.
CREATE UNIQUE INDEX oauth_authorizations_state_key ON oauth_authorizations (state);
CREATE INDEX oauth_authorizations_expires_at_idx ON oauth_authorizations (expires_at);
