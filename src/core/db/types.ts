import type {
  ColumnType,
  Generated,
  Insertable,
  JSONColumnType,
  Selectable,
  Updateable,
} from 'kysely';

/**
 * Kysely database types.
 *
 * Hand-written and kept in step with the migrations in `src/core/db/migrations`,
 * which are the source of truth. A schema change without a matching change here
 * is a review finding (see AGENTS.md).
 */

/** Read as a Date, written as either. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** Defaulted by the database on insert, never written by hand. */
type CreatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

export interface SchemaMigrationsTable {
  name: string;
  applied_at: CreatedAt;
}

export interface UsersTable {
  id: Generated<string>;
  /** Always normalised lowercase. Use `normalizeEmail` before reading or writing. */
  email: string;
  /**
   * Argon2id encoded string, including parameters and salt.
   *
   * Null for an account created through a provider, which has no password.
   * Every read of this field has to say what it does in that case: treating
   * null as "no password to check" and returning early would make login an
   * oracle for which accounts sign in through a provider.
   */
  password_hash: string | null;
  email_verified_at: Timestamp | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  /** SHA-256 of the token. The token itself is never stored. */
  token_hash: Buffer;
  issued_at: CreatedAt;
  expires_at: Timestamp;
  last_seen_at: CreatedAt;
  revoked_at: Timestamp | null;
}

export type AuthAttemptScope = 'ip' | 'email';

export interface AuthAttemptsTable {
  id: Generated<number>;
  scope: AuthAttemptScope;
  key: string;
  succeeded: boolean;
  occurred_at: CreatedAt;
}

/** The providers social login supports. Mirrors the CHECK on both tables. */
export const OAUTH_PROVIDERS = ['google', 'github'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface OAuthIdentitiesTable {
  id: Generated<string>;
  user_id: string;
  provider: OAuthProvider;
  /**
   * Google's `sub`, GitHub's numeric id as text.
   *
   * Never the email address and never GitHub's login: the first is an
   * attribute of an account rather than its identity, and the second is
   * released for anyone to claim when its owner renames.
   */
  provider_account_id: string;
  /** For display only. Using it as a lookup key is the vulnerability. */
  provider_email: string | null;
  provider_email_verified: Generated<boolean>;
  created_at: CreatedAt;
  last_login_at: CreatedAt;
}

/** `link` attaches to an existing account; `signin` finds or creates one. */
export type OAuthMode = 'signin' | 'link';

export interface OAuthAuthorizationsTable {
  id: Generated<string>;
  provider: OAuthProvider;
  mode: OAuthMode;
  /** Present exactly when mode is `link`, enforced by a CHECK. */
  user_id: string | null;
  state: string;
  /** A secret. This is why a flow in progress is a row and not a cookie. */
  code_verifier: string;
  /** OIDC only; GitHub has nowhere to carry one. */
  nonce: string | null;
  /** A validated path, never an absolute URL. */
  return_to: Generated<string>;
  created_at: CreatedAt;
  expires_at: Timestamp;
}

export interface ServicesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  /** Origin only: scheme + host [+ port], never a path. */
  base_url: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

/** One `{min, max}` status-code range. Validated at the DTO layer. */
export interface StatusRange {
  min: number;
  max: number;
}

/** Structured, versioned assertion -- never a string DSL (architecture ADR-5). */
export type EndpointAssertion =
  | { type: 'body_contains'; value: string }
  | { type: 'body_not_contains'; value: string }
  | { type: 'json_path'; path: string; equals: unknown };

export interface EndpointsTable {
  id: Generated<string>;
  service_id: string;
  /** Denormalized from services.user_id; written once at insert. */
  user_id: string;
  method: Generated<string>;
  path: Generated<string>;
  /** No database default -- the caller supplies it from validated config (docs/m2-plan.md, FR-7). */
  interval_s: number;
  /** No database default -- the caller supplies it from validated config (docs/m2-plan.md, FR-8). */
  timeout_ms: number;
  /**
   * Stringified JSON on insert/update (Kysely's `JSONColumnType`), parsed on
   * select. Optional on insert/update -- both have a database default.
   */
  expected_status: JSONColumnType<StatusRange[], string | undefined, string | undefined>;
  latency_warn_ms: number | null;
  failure_threshold: Generated<number>;
  success_threshold: Generated<number>;
  follow_redirects: Generated<boolean>;
  max_redirects: Generated<number>;
  assertions: JSONColumnType<EndpointAssertion[], string | undefined, string | undefined>;
  /** Pause/resume (FR-9). Inert until M4's scheduler reads it. */
  enabled: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface HeadersTable {
  id: Generated<string>;
  /** Exactly one of service_id/endpoint_id is set, enforced by a CHECK. */
  service_id: string | null;
  endpoint_id: string | null;
  name: string;
  is_secret: Generated<boolean>;
  /** Set when `is_secret` is false; null otherwise. */
  value: string | null;
  /** Set when `is_secret` is true; null otherwise. AES-256-GCM. */
  secret_ciphertext: Buffer | null;
  secret_iv: Buffer | null;
  secret_auth_tag: Buffer | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface TagsTable {
  id: Generated<string>;
  /** Exactly one of service_id/endpoint_id is set, enforced by a CHECK. */
  service_id: string | null;
  endpoint_id: string | null;
  key: string;
  value: string;
}

export interface Database {
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  sessions: SessionsTable;
  auth_attempts: AuthAttemptsTable;
  oauth_identities: OAuthIdentitiesTable;
  oauth_authorizations: OAuthAuthorizationsTable;
  services: ServicesTable;
  endpoints: EndpointsTable;
  headers: HeadersTable;
  tags: TagsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Session = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;

export type OAuthIdentity = Selectable<OAuthIdentitiesTable>;
export type NewOAuthIdentity = Insertable<OAuthIdentitiesTable>;

export type OAuthAuthorization = Selectable<OAuthAuthorizationsTable>;
export type NewOAuthAuthorization = Insertable<OAuthAuthorizationsTable>;

export type Service = Selectable<ServicesTable>;
export type NewService = Insertable<ServicesTable>;
/**
 * `user_id` excluded: it is how `update()`'s own `WHERE` establishes
 * ownership, and Kysely's generated `Updateable` would otherwise happily
 * type-check `{user_id: someoneElses}` as a valid patch. That combined with
 * `ServiceRepository.update`'s `WHERE id = ? AND user_id = ?` matching the
 * row's *old* owner would let a caller reassign a service to another
 * tenant's account in the same statement that is supposed to be scoped to
 * this one.
 */
export type ServiceUpdate = Omit<Updateable<ServicesTable>, 'user_id'>;

export type Endpoint = Selectable<EndpointsTable>;
export type NewEndpoint = Insertable<EndpointsTable>;
/**
 * `user_id` and `service_id` excluded, same reasoning as `ServiceUpdate`:
 * an endpoint patch that could rewrite either would transfer the endpoint
 * (and its headers and tags) to a different service or tenant, satisfying
 * the composite (service_id, user_id) foreign key at the *destination*
 * while `update()`'s `WHERE` only ever checked the row's *original* owner.
 */
export type EndpointUpdate = Omit<Updateable<EndpointsTable>, 'user_id' | 'service_id'>;

export type Header = Selectable<HeadersTable>;
export type NewHeader = Insertable<HeadersTable>;

export type Tag = Selectable<TagsTable>;
export type NewTag = Insertable<TagsTable>;
