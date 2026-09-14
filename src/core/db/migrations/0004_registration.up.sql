-- Registration: services, the endpoints under them, their headers and tags.
-- Sources: docs/m2-plan.md §3; requirements FR-6...FR-16; stories B-1...B-8.

-- A user's API. Origin only (scheme + host [+ port]), never a path -- that is
-- what makes "does this URL already have a service" (B-3) a lookup on this
-- column rather than a fuzzy match.
CREATE TABLE services (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        text        NOT NULL,
    base_url    text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Lets endpoints below reference (id, user_id) together as one composite
    -- foreign key, so an endpoint's own user_id cannot disagree with its
    -- service's owner -- enforced by Postgres, not only by callers
    -- remembering to pass the same value twice.
    CONSTRAINT services_id_user_id_key UNIQUE (id, user_id)
);
CREATE INDEX services_user_id_idx ON services (user_id);
-- B-3: "a service already exists for this user at this origin" is this index.
CREATE UNIQUE INDEX services_user_base_url_key ON services (user_id, base_url);

-- One monitored path under a service. method + path is the rest of the
-- effective URL; base_url + path is re-validated against the SSRF policy on
-- every save (docs/m2-plan.md §5.1), never trusted from the service's own
-- validation.
CREATE TABLE endpoints (
    id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Denormalized from services.user_id. Every ownership and quota query
    -- would otherwise need a join through services; the quota lock
    -- (docs/m2-plan.md §5.3) reads this column directly, inside a
    -- transaction that already holds the users row lock. Written once at
    -- insert -- an endpoint never changes service.
    --
    -- (service_id, user_id) together, not service_id alone, reference
    -- services (id, user_id): an insert whose user_id disagrees with the
    -- named service's actual owner has no matching row to reference and is
    -- rejected by Postgres, not merely by a caller remembering to keep the
    -- two in step.
    service_id         uuid           NOT NULL,
    user_id            uuid           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    method             text           NOT NULL DEFAULT 'GET',
    path               text           NOT NULL DEFAULT '/',
    -- No DEFAULT: FR-7/FR-8 make these system-configurable (a bounded set
    -- of intervals, a system-maximum timeout), so the default value has to
    -- come from validated config, applied by the create path (PR4), not
    -- from a number baked into the schema that no boot-time check can see
    -- or a deployment can change.
    interval_s         integer        NOT NULL,
    timeout_ms         integer        NOT NULL,
    -- [{"min":200,"max":299}, ...]. Validated at the DTO layer (PR4);
    -- M2 stores it opaquely -- M3's assertion evaluator is its first reader.
    expected_status    jsonb          NOT NULL DEFAULT '[{"min":200,"max":299}]',
    latency_warn_ms    integer,
    failure_threshold  smallint       NOT NULL DEFAULT 3,
    success_threshold  smallint       NOT NULL DEFAULT 2,
    follow_redirects   boolean        NOT NULL DEFAULT true,
    max_redirects      smallint       NOT NULL DEFAULT 5,
    -- Structured, versioned (architecture §7.11 ADR-5), not a string DSL.
    assertions         jsonb          NOT NULL DEFAULT '[]',
    -- Pause/resume (FR-9). A paused endpoint is excluded once a scheduler
    -- reads this column, from M4 on; inert until then.
    enabled            boolean        NOT NULL DEFAULT true,
    created_at         timestamptz    NOT NULL DEFAULT now(),
    updated_at         timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT endpoints_service_owner_fkey
        FOREIGN KEY (service_id, user_id) REFERENCES services (id, user_id) ON DELETE CASCADE
);
CREATE INDEX endpoints_service_id_idx ON endpoints (service_id);
-- The quota count filters on this directly (docs/m2-plan.md §5.3).
CREATE INDEX endpoints_user_id_idx ON endpoints (user_id);
-- Two endpoints resolving to the same effective URL under one service is
-- duplicate monitoring of the same thing -- worth preventing at the schema
-- rather than relying on client discipline.
CREATE UNIQUE INDEX endpoints_service_method_path_key ON endpoints (service_id, method, path);

-- One row per header, on either a service or an endpoint, never both.
CREATE TABLE headers (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id         uuid        REFERENCES services (id) ON DELETE CASCADE,
    endpoint_id        uuid        REFERENCES endpoints (id) ON DELETE CASCADE,
    -- The name as the user typed it, kept for display. Case-insensitive
    -- override by name (B-4) is resolved in the application layer at read
    -- time, not by a citext column here -- same reasoning already recorded
    -- for users.email (docs/m1-plan.md §3, decision 6).
    name               text        NOT NULL,
    is_secret          boolean     NOT NULL DEFAULT false,
    -- Exactly one of (value, secret_ciphertext) is set, matching is_secret.
    -- A secret's value is never stored in the clear: encryption is AES-256-GCM
    -- (docs/m2-plan.md §5.4); this table only enforces the shape, not the
    -- encryption itself, so it holds however the writer chose to produce
    -- ciphertext.
    value              text,
    secret_ciphertext  bytea,
    secret_iv          bytea,
    secret_auth_tag    bytea,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT headers_one_owner
        CHECK ((service_id IS NULL) <> (endpoint_id IS NULL)),
    CONSTRAINT headers_secret_shape
        CHECK (
            (is_secret AND value IS NULL AND secret_ciphertext IS NOT NULL
                        AND secret_iv IS NOT NULL AND secret_auth_tag IS NOT NULL)
            OR
            (NOT is_secret AND value IS NOT NULL AND secret_ciphertext IS NULL
                            AND secret_iv IS NULL AND secret_auth_tag IS NULL)
        )
);
CREATE INDEX headers_service_id_idx ON headers (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX headers_endpoint_id_idx ON headers (endpoint_id) WHERE endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX headers_service_name_key ON headers (service_id, lower(name)) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX headers_endpoint_name_key ON headers (endpoint_id, lower(name)) WHERE endpoint_id IS NOT NULL;

-- key:value tags (B-5), on either a service or an endpoint. Relational, not a
-- jsonb column: filtering ("everywhere", per B-5) needs an index, and a jsonb
-- containment index on a hot list-query path is worse than a plain btree here.
CREATE TABLE tags (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  uuid        REFERENCES services (id) ON DELETE CASCADE,
    endpoint_id uuid        REFERENCES endpoints (id) ON DELETE CASCADE,
    key         text        NOT NULL,
    value       text        NOT NULL,
    CONSTRAINT tags_one_owner
        CHECK ((service_id IS NULL) <> (endpoint_id IS NULL))
);
CREATE INDEX tags_service_id_idx ON tags (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX tags_endpoint_id_idx ON tags (endpoint_id) WHERE endpoint_id IS NOT NULL;
-- "services/endpoints with tag key=value", the filter query B-5 asks for.
CREATE INDEX tags_key_value_idx ON tags (key, value);
CREATE UNIQUE INDEX tags_service_key_key ON tags (service_id, key) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX tags_endpoint_key_key ON tags (endpoint_id, key) WHERE endpoint_id IS NOT NULL;
