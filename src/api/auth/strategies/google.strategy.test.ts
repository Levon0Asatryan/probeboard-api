import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OAuthProviderStub,
  type StubFaults,
  type StubIdentity,
} from '../../../testing/oauth-provider-stub.js';
import { OAuthProviderError } from '../interfaces/oauth-provider.js';
import { GoogleStrategy } from './google.strategy.js';

/**
 * Google sign-in against a local OpenID Connect provider with a real signing
 * key.
 *
 * Every rejection below is asserted as a *rejection*, not as a thrown error of
 * any kind: the strategy must refuse with OAuthProviderError, because anything
 * else becomes a 500 and a 500 on some sign-ins and a clean refusal on others
 * is a signal about which check fired.
 */

let stub: OAuthProviderStub;
const REDIRECT = 'http://127.0.0.1:3000/v1/auth/oauth/google/callback';

beforeAll(async () => {
  stub = await OAuthProviderStub.start('oidc');
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  stub.failDiscovery = 0;
  stub.hangTokenEndpoint = false;
});

function strategy(overrides: { allowInsecureRequests?: boolean; timeoutMs?: number } = {}) {
  return new GoogleStrategy({
    clientId: stub.clientId,
    clientSecret: stub.clientSecret,
    timeoutMs: overrides.timeoutMs ?? 5000,
    issuer: new URL(stub.url),
    allowInsecureRequests: overrides.allowInsecureRequests ?? true,
  });
}

/** What the controller will generate per flow. */
function secrets() {
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  };
}

/** A whole flow: authorize, approve at the stub, complete. */
async function signIn(
  identity: StubIdentity,
  faults: StubFaults = {},
  tamper: (s: ReturnType<typeof secrets>, query: URLSearchParams) => void = () => undefined,
  google = strategy(),
) {
  const s = secrets();
  const url = await google.authorizationUrl({
    redirectUri: REDIRECT,
    state: s.state,
    nonce: s.nonce,
    codeChallenge: s.codeChallenge,
  });
  const query = stub.approve(url, identity, faults);
  tamper(s, query);
  return google.complete({
    redirectUri: REDIRECT,
    query,
    expectedState: s.state,
    codeVerifier: s.codeVerifier,
    nonce: s.nonce,
  });
}

async function refusal(promise: Promise<unknown>): Promise<OAuthProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthProviderError);
  return err as OAuthProviderError;
}

describe('the authorization request', () => {
  it('carries everything the flow depends on', async () => {
    const s = secrets();
    const url = await strategy().authorizationUrl({
      redirectUri: REDIRECT,
      state: s.state,
      nonce: s.nonce,
      codeChallenge: s.codeChallenge,
    });
    const p = url.searchParams;

    expect(`${url.origin}${url.pathname}`).toBe(`${stub.url}/authorize`);
    expect(p.get('client_id')).toBe(stub.clientId);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('state')).toBe(s.state);
    expect(p.get('nonce')).toBe(s.nonce);
    expect(p.get('code_challenge')).toBe(s.codeChallenge);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('prompt')).toBe('select_account');
  });

  it('never puts the client secret in the URL the browser is sent to', async () => {
    const s = secrets();
    const url = await strategy().authorizationUrl({
      redirectUri: REDIRECT,
      state: s.state,
      nonce: s.nonce,
      codeChallenge: s.codeChallenge,
    });
    expect(url.toString()).not.toContain(stub.clientSecret);
  });

  it('refuses to start without a nonce, which is what binds the ID token', async () => {
    const s = secrets();
    await expect(
      strategy().authorizationUrl({
        redirectUri: REDIRECT,
        state: s.state,
        codeChallenge: s.codeChallenge,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('a valid sign-in', () => {
  it('yields the account from the verified ID token', async () => {
    const account = await signIn({
      id: 'google-sub-1',
      email: 'alice@example.com',
      emailVerified: true,
    });

    expect(account).toEqual({
      provider: 'google',
      accountId: 'google-sub-1',
      email: 'alice@example.com',
      emailVerified: true,
    });
  });

  it('reports an unverified address as unverified', async () => {
    const account = await signIn({ id: 'sub-2', email: 'bob@example.com', emailVerified: false });
    expect(account.emailVerified).toBe(false);
  });

  it('treats a non-boolean email_verified as unverified, failing towards refusal', async () => {
    const account = await signIn(
      { id: 'sub-3', email: 'c@example.com' },
      { idToken: { email_verified: 'true' } },
    );
    expect(account.emailVerified).toBe(false);
  });

  it('yields no address when the token carries none', async () => {
    const account = await signIn({ id: 'sub-4', email: null });
    expect(account.email).toBeNull();
  });

  it('authenticates to the token endpoint and sends the PKCE verifier', async () => {
    await signIn({ id: 'sub-5' });

    const tokenRequest = stub.requests.find((r) => r.path === '/token');
    expect(tokenRequest).toBeDefined();
    const form = new URLSearchParams(tokenRequest!.body);
    expect(form.get('code_verifier')).toBeTruthy();
    expect(form.get('redirect_uri')).toBe(REDIRECT);
  });
});

describe('an ID token that must be refused', () => {
  it('for the wrong audience', async () => {
    await refusal(signIn({ id: 'x' }, { idToken: { aud: 'some-other-client' } }));
  });

  it('from the wrong issuer', async () => {
    await refusal(signIn({ id: 'x' }, { idToken: { iss: 'https://evil.example.com' } }));
  });

  it('that has expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await refusal(signIn({ id: 'x' }, { idToken: { iat: past - 300, exp: past } }));
  });

  it('carrying a different nonce -- a replayed token', async () => {
    await refusal(signIn({ id: 'x' }, { idToken: { nonce: 'from-another-flow' } }));
  });

  it('signed with a key the provider does not publish', async () => {
    await refusal(signIn({ id: 'x' }, { rogueSignature: true }));
  });

  it('that is missing altogether', async () => {
    await refusal(signIn({ id: 'x' }, { omitIdToken: true }));
  });

  it('with no subject', async () => {
    const err = await refusal(signIn({ id: 'x' }, { idToken: { sub: '' } }));
    // Refused by the library's own claim checks or by ours; either way a
    // refusal, never an account with an empty id.
    expect(['exchange_failed', 'invalid_identity']).toContain(err.reason);
  });
});

describe('a flow that must be refused', () => {
  it('when the PKCE verifier is not the one the challenge was made from', async () => {
    await refusal(
      signIn({ id: 'x' }, {}, (s) => {
        s.codeVerifier = randomBytes(32).toString('base64url');
      }),
    );
  });

  it('when the returned state is not the expected one', async () => {
    await refusal(
      signIn({ id: 'x' }, {}, (_s, query) => {
        query.set('state', 'forged-state');
      }),
    );
  });

  it('when the same code is redeemed twice', async () => {
    const google = strategy();
    const s = secrets();
    const url = await google.authorizationUrl({
      redirectUri: REDIRECT,
      state: s.state,
      nonce: s.nonce,
      codeChallenge: s.codeChallenge,
    });
    const query = stub.approve(url, { id: 'replayed' });
    const callback = {
      redirectUri: REDIRECT,
      query,
      expectedState: s.state,
      codeVerifier: s.codeVerifier,
      nonce: s.nonce,
    };

    await expect(google.complete(callback)).resolves.toMatchObject({ accountId: 'replayed' });
    await refusal(google.complete(callback));
  });

  it('when the provider redirects back with an error, classified as such', async () => {
    const err = await refusal(
      signIn({ id: 'x' }, {}, (_s, query) => {
        query.delete('code');
        query.set('error', 'access_denied');
      }),
    );
    expect(err.reason).toBe('authorization_error');
  });
});

describe('talking to the provider', () => {
  it('refuses a plain-HTTP provider unless explicitly allowed', async () => {
    // The flag exists for this test double only. Without it the client
    // secret and the identity assertion would cross the network in the clear.
    const err = await refusal(
      signIn({ id: 'x' }, {}, () => undefined, strategy({ allowInsecureRequests: false })),
    );
    // Named as a deployment mistake, not an outage, so the log points at our
    // configuration rather than at Google.
    expect(err.reason).toBe('misconfigured');
    expect(stub.requests).toHaveLength(0);
  });

  it('forgets a failed discovery, so the next sign-in retries', async () => {
    const google = strategy();
    stub.failDiscovery = 1;

    const err = await refusal(signIn({ id: 'x' }, {}, () => undefined, google));
    expect(err.reason).toBe('discovery_failed');

    // Cached, this would fail forever -- until a restart -- after one blip.
    await expect(signIn({ id: 'recovered' }, {}, () => undefined, google)).resolves.toMatchObject({
      accountId: 'recovered',
    });
  });

  it('discovers once, not per sign-in', async () => {
    const google = strategy();
    await signIn({ id: 'a' }, {}, () => undefined, google);
    await signIn({ id: 'b' }, {}, () => undefined, google);

    expect(
      stub.requests.filter((r) => r.path === '/.well-known/openid-configuration'),
    ).toHaveLength(1);
  });

  it('gives up on a provider that never answers', async () => {
    stub.hangTokenEndpoint = true;
    const started = Date.now();

    await refusal(signIn({ id: 'x' }, {}, () => undefined, strategy({ timeoutMs: 1000 })));

    // The library counts in whole seconds; allow generous headroom, but the
    // point is that it ends at all.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
