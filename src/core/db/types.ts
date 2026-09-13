import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

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

export interface Database {
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  sessions: SessionsTable;
  auth_attempts: AuthAttemptsTable;
  oauth_identities: OAuthIdentitiesTable;
  oauth_authorizations: OAuthAuthorizationsTable;
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
