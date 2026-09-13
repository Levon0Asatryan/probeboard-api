import { Injectable } from '@nestjs/common';
import { DbService } from '../../../core/db/db.service.js';
import type { OAuthAuthorization, OAuthMode, OAuthProvider } from '../../../core/db/types.js';

export interface NewAuthorization {
  provider: OAuthProvider;
  mode: OAuthMode;
  /** Present exactly when mode is `link`. */
  userId?: string;
  state: string;
  codeVerifier: string;
  /** OIDC only. */
  nonce?: string;
  /** An already-validated path. */
  returnTo: string;
  expiresAt: Date;
}

@Injectable()
export class OAuthAuthorizationRepository {
  constructor(private readonly db: DbService) {}

  async create(pending: NewAuthorization): Promise<OAuthAuthorization> {
    return this.db.kysely
      .insertInto('oauth_authorizations')
      .values({
        provider: pending.provider,
        mode: pending.mode,
        user_id: pending.userId ?? null,
        state: pending.state,
        code_verifier: pending.codeVerifier,
        nonce: pending.nonce ?? null,
        return_to: pending.returnTo,
        expires_at: pending.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Takes a pending authorization, if it is still valid, and destroys it.
   *
   * One statement, and that is the point. The callback is reachable by anyone
   * who can replay a URL, so "has this flow already been completed?" has to be
   * answered by the same operation that completes it. A read followed by a
   * delete lets two concurrent replays both find the row and both proceed —
   * which is authorization code injection with extra steps.
   *
   * Expiry is a clause of the DELETE rather than a check by the caller, for
   * the same reason session expiry is a clause of its lookup: a caller that
   * forgets is the whole vulnerability.
   *
   * The `state` from the callback query is compared here too, not only the id
   * from the cookie. Requiring both means a stolen cookie without the callback
   * URL, or a callback URL without the cookie, is useless.
   *
   * `provider` is bound too, matching the route the callback actually
   * arrived on. Without it, a flow started for one provider can be completed
   * through the other provider's callback: the state and PKCE challenge are
   * only ever compared against what this row holds, so a relayed
   * authorization response reusing them at the wrong provider's callback
   * would otherwise be processed with the original verifier -- an OAuth
   * mix-up RFC 9700 names explicitly, and the whole reason each provider gets
   * its own registered redirect URI (D8) in the first place.
   */
  async consume(
    id: string,
    state: string,
    provider: OAuthProvider,
    now: Date = new Date(),
  ): Promise<OAuthAuthorization | undefined> {
    return this.db.kysely
      .deleteFrom('oauth_authorizations')
      .where('id', '=', id)
      .where('state', '=', state)
      .where('provider', '=', provider)
      .where('expires_at', '>', now)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Removes a pending authorization without completing it.
   *
   * Used when the provider reports an error, so an abandoned flow does not sit
   * around until the sweep.
   */
  async discard(id: string): Promise<void> {
    await this.db.kysely.deleteFrom('oauth_authorizations').where('id', '=', id).execute();
  }

  /**
   * Removes expired rows.
   *
   * Unlike sessions these are kept for no grace period: a flow that was never
   * completed answers no question after the fact, and the row holds a PKCE
   * verifier, so the shortest life is the right one.
   */
  async pruneExpired(before: Date = new Date()): Promise<number> {
    const result = await this.db.kysely
      .deleteFrom('oauth_authorizations')
      .where('expires_at', '<', before)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
