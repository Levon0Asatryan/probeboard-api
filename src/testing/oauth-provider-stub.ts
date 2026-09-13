import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A local identity provider for tests, in either of the two shapes the
 * strategies talk to.
 *
 * `oidc` behaves like Google: a discovery document, a JWKS, and a token
 * endpoint that returns an ID token signed with a key generated at start. The
 * signature is real, so validation is exercised rather than mocked.
 *
 * `github` behaves like GitHub: no discovery, a token endpoint at GitHub's path,
 * and `/user` plus `/user/emails` behind the access token. It reproduces
 * GitHub's HTTP-200-with-an-error-body on request, which no live provider will
 * do on demand.
 *
 * Every rule a real provider enforces that matters to us is enforced here too
 * -- single-use codes, PKCE, redirect_uri match, client authentication --
 * because a stub that accepts anything proves nothing about the client.
 */

export type StubShape = 'oidc' | 'github';

export interface StubIdentity {
  /** OIDC `sub`, or GitHub's numeric id. */
  id: string | number;
  email?: string | null;
  emailVerified?: boolean;
  /** GitHub only: the address list /user/emails returns. Defaults to one primary verified entry. */
  emails?: { email: string; primary: boolean; verified: boolean }[];
  /** GitHub only: overrides for the /user body. */
  user?: Record<string, unknown>;
}

/** Deliberate faults, one per test. */
export interface StubFaults {
  /** Claims merged over the ID token's, to break aud, iss, exp or nonce. */
  idToken?: Record<string, unknown>;
  /** Sign the ID token with a key the JWKS does not publish. */
  rogueSignature?: boolean;
  /** Omit the ID token from an OIDC token response. */
  omitIdToken?: boolean;
  /** GitHub's quirk: answer a token request with 200 and an error body. */
  tokenErrorWith200?: boolean;
  /** Status for /user or /user/emails. */
  userStatus?: number;
  emailsStatus?: number;
}

interface PendingCode {
  identity: StubIdentity;
  faults: StubFaults;
  codeChallenge: string;
  redirectUri: string;
  nonce?: string;
  used: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export class OAuthProviderStub {
  readonly clientId = 'stub-client-id';
  readonly clientSecret = 'stub-client-secret';
  /** Every request received, for assertions about what the client sent. */
  readonly requests: RecordedRequest[] = [];
  /** Answer this many discovery requests with 503 before answering normally. */
  failDiscovery = 0;
  /** Accept token requests and never answer them. */
  hangTokenEndpoint = false;

  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<string, StubIdentity & { faults: StubFaults }>();
  private readonly kid = 'stub-key-1';
  private readonly signingKey: KeyObject;
  private readonly rogueKey: KeyObject;
  private readonly publicJwk: Record<string, unknown>;

  private constructor(
    readonly shape: StubShape,
    private readonly server: Server,
    readonly url: string,
  ) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.signingKey = pair.privateKey;
    this.publicJwk = { ...pair.publicKey.export({ format: 'jwk' }) };
    this.rogueKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }

  static async start(shape: StubShape): Promise<OAuthProviderStub> {
    // Listen first, because the issuer URL has to contain the port; attach the
    // handler once the stub that owns it exists.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const stub = new OAuthProviderStub(shape, server, `http://127.0.0.1:${String(port)}`);
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void stub.handle(req, res);
    });
    return stub;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /**
   * Plays the user approving the request: reads what the client put in the
   * authorization URL, issues a code bound to it, and returns the query string
   * the provider would redirect back with.
   *
   * Reading the parameters from the real URL, rather than taking them as
   * arguments, is what lets a test catch a client that forgot to send one.
   */
  approve(authorizationUrl: URL, identity: StubIdentity, faults: StubFaults = {}): URLSearchParams {
    const p = authorizationUrl.searchParams;
    const codeChallenge = p.get('code_challenge');
    const redirectUri = p.get('redirect_uri');
    if (p.get('code_challenge_method') !== 'S256' || !codeChallenge) {
      throw new Error('stub: authorization request carried no S256 PKCE challenge');
    }
    if (!redirectUri) throw new Error('stub: authorization request carried no redirect_uri');
    if (p.get('client_id') !== this.clientId) throw new Error('stub: wrong client_id');

    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, {
      identity,
      faults,
      codeChallenge,
      redirectUri,
      nonce: p.get('nonce') ?? undefined,
      used: false,
    });

    const query = new URLSearchParams({ code });
    const state = p.get('state');
    if (state !== null) query.set('state', state);
    return query;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').split('?')[0];
    this.requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (this.shape === 'oidc' && path === '/.well-known/openid-configuration') {
      if (this.failDiscovery > 0) {
        this.failDiscovery -= 1;
        return json(503, { error: 'temporarily_unavailable' });
      }
      return json(200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        jwks_uri: `${this.url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }

    if (this.shape === 'oidc' && path === '/jwks') {
      return json(200, { keys: [{ ...this.publicJwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
    }

    const tokenPath = this.shape === 'oidc' ? '/token' : '/login/oauth/access_token';
    if (req.method === 'POST' && path === tokenPath) {
      // Left open deliberately: the client's own timeout is what must end it.
      if (this.hangTokenEndpoint) return;
      return this.token(req, body, json);
    }

    if (this.shape === 'github' && (path === '/user' || path === '/user/emails')) {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const holder = bearer ? this.tokens.get(bearer) : undefined;
      if (!holder) return json(401, { message: 'Bad credentials' });

      if (path === '/user') {
        if (holder.faults.userStatus) return json(holder.faults.userStatus, { message: 'fault' });
        return json(200, { id: holder.id, login: 'octocat', email: null, ...holder.user });
      }

      if (holder.faults.emailsStatus) return json(holder.faults.emailsStatus, { message: 'fault' });
      return json(
        200,
        holder.emails ?? [
          {
            email: holder.email ?? 'octocat@example.com',
            primary: true,
            verified: holder.emailVerified ?? true,
            visibility: 'private',
          },
        ],
      );
    }

    json(404, { error: 'not_found' });
  }

  private token(
    req: IncomingMessage,
    body: string,
    json: (status: number, payload: unknown) => void,
  ): void {
    const form = new URLSearchParams(body);
    const refuse = (error: string) => json(400, { error });

    // Client authentication, by either method a real provider accepts.
    let clientId = form.get('client_id');
    let clientSecret = form.get('client_secret');
    const basic = req.headers.authorization?.match(/^Basic (.+)$/);
    if (basic) {
      const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id);
      clientSecret = decodeURIComponent(secret);
    }
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      return refuse('invalid_client');
    }

    if (form.get('grant_type') !== 'authorization_code') return refuse('unsupported_grant_type');

    const code = form.get('code') ?? '';
    const pending = this.codes.get(code);
    if (!pending) return refuse('invalid_grant');

    // Single use, as every real provider enforces. A second redemption fails
    // even with every other parameter correct.
    if (pending.used) return refuse('invalid_grant');
    pending.used = true;

    if (form.get('redirect_uri') !== pending.redirectUri) return refuse('invalid_grant');

    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== pending.codeChallenge) return refuse('invalid_grant');

    if (pending.faults.tokenErrorWith200) {
      return json(200, {
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
      });
    }

    const accessToken = randomBytes(24).toString('base64url');
    this.tokens.set(accessToken, { ...pending.identity, faults: pending.faults });

    if (this.shape === 'github') {
      return json(200, {
        access_token: accessToken,
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    }

    const response: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    };
    if (!pending.faults.omitIdToken) response.id_token = this.idToken(pending);
    json(200, response);
  }

  private idToken(pending: PendingCode): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.url,
      aud: this.clientId,
      sub: String(pending.identity.id),
      iat: now,
      exp: now + 300,
      ...(pending.nonce ? { nonce: pending.nonce } : {}),
      ...(pending.identity.email === null
        ? {}
        : { email: pending.identity.email ?? 'user@example.com' }),
      email_verified: pending.identity.emailVerified ?? true,
      ...pending.faults.idToken,
    };

    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode(header)}.${encode(claims)}`;
    const key = pending.faults.rogueSignature ? this.rogueKey : this.signingKey;
    const signature = sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
    return `${input}.${signature}`;
  }
}
