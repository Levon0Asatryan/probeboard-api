import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OAuthProviderStub,
  type StubFaults,
  type StubIdentity,
} from '../../../testing/oauth-provider-stub.js';
import { OAuthProviderError } from '../interfaces/oauth-provider.js';
import { GitHubStrategy } from './github.strategy.js';

/**
 * GitHub sign-in against a local server shaped like GitHub: no discovery, no
 * ID token, identity from the REST API, and GitHub's non-standard token errors
 * reproducible on demand.
 */

let stub: OAuthProviderStub;
const REDIRECT = 'http://127.0.0.1:3000/v1/auth/oauth/github/callback';

beforeAll(async () => {
  stub = await OAuthProviderStub.start('github');
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  stub.hangTokenEndpoint = false;
});

function strategy(overrides: { allowInsecureRequests?: boolean; timeoutMs?: number } = {}) {
  return new GitHubStrategy({
    clientId: stub.clientId,
    clientSecret: stub.clientSecret,
    timeoutMs: overrides.timeoutMs ?? 5000,
    webBaseUrl: stub.url,
    apiBaseUrl: stub.url,
    allowInsecureRequests: overrides.allowInsecureRequests ?? true,
  });
}

function secrets() {
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(16).toString('base64url'),
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  };
}

async function signIn(
  identity: StubIdentity,
  faults: StubFaults = {},
  tamper: (s: ReturnType<typeof secrets>, query: URLSearchParams) => void = () => undefined,
  github = strategy(),
) {
  const s = secrets();
  const url = await github.authorizationUrl({
    redirectUri: REDIRECT,
    state: s.state,
    codeChallenge: s.codeChallenge,
  });
  const query = stub.approve(url, identity, faults);
  tamper(s, query);
  return github.complete({
    redirectUri: REDIRECT,
    query,
    expectedState: s.state,
    codeVerifier: s.codeVerifier,
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
  it('asks for identity and nothing more', async () => {
    const s = secrets();
    const url = await strategy().authorizationUrl({
      redirectUri: REDIRECT,
      state: s.state,
      codeChallenge: s.codeChallenge,
    });
    const p = url.searchParams;

    expect(`${url.origin}${url.pathname}`).toBe(`${stub.url}/login/oauth/authorize`);
    expect(p.get('client_id')).toBe(stub.clientId);
    expect(p.get('scope')).toBe('read:user user:email');
    expect(p.get('state')).toBe(s.state);
    expect(p.get('code_challenge')).toBe(s.codeChallenge);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    // GitHub has nowhere to carry one.
    expect(p.has('nonce')).toBe(false);
    expect(url.toString()).not.toContain(stub.clientSecret);
  });
});

describe('a valid sign-in', () => {
  it('yields the numeric id as the account id, with the primary verified address', async () => {
    const account = await signIn({ id: 583231, email: 'octocat@example.com' });

    expect(account).toEqual({
      provider: 'github',
      accountId: '583231',
      email: 'octocat@example.com',
      emailVerified: true,
    });
  });

  it('keys on the id, not the login, which a rename releases to anyone', async () => {
    const before = await signIn({ id: 42, user: { login: 'original-name' } });
    const after = await signIn({ id: 42, user: { login: 'someone-elses-now' } });

    expect(after.accountId).toBe(before.accountId);
  });

  it('takes the primary verified address when there are several', async () => {
    const account = await signIn({
      id: 7,
      emails: [
        { email: 'old@example.com', primary: false, verified: true },
        { email: 'main@example.com', primary: true, verified: true },
      ],
    });
    expect(account.email).toBe('main@example.com');
  });

  it('asks the API for identity with a token, a user agent, and nothing stored', async () => {
    const account = await signIn({ id: 9 });

    const user = stub.requests.find((r) => r.path === '/user');
    expect(user?.headers.authorization).toMatch(/^Bearer .+/);
    expect(user?.headers['user-agent']).toBe('probeboard');

    // The token was used and dropped; it is not part of what the strategy returns.
    const token = user!.headers.authorization!.replace('Bearer ', '');
    expect(JSON.stringify(account)).not.toContain(token);
  });

  it('requests JSON from the token endpoint, which GitHub otherwise answers form-encoded', async () => {
    await signIn({ id: 10 });
    const token = stub.requests.find((r) => r.path === '/login/oauth/access_token');
    expect(token?.headers.accept).toContain('application/json');
  });
});

describe('an address that cannot be used', () => {
  it('yields none when the primary address is unverified', async () => {
    const account = await signIn({
      id: 11,
      emails: [{ email: 'u@example.com', primary: true, verified: false }],
    });
    expect(account).toMatchObject({ email: null, emailVerified: false });
  });

  it('yields none when the only verified address is not the primary', async () => {
    const account = await signIn({
      id: 12,
      emails: [
        { email: 'p@example.com', primary: true, verified: false },
        { email: 'v@example.com', primary: false, verified: true },
      ],
    });
    expect(account.email).toBeNull();
  });

  it('yields none when the list is empty', async () => {
    expect((await signIn({ id: 13, emails: [] })).email).toBeNull();
  });
});

describe('an identity that must be refused', () => {
  it.each([
    ['missing', undefined],
    ['a string', '583231'],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
  ])('when the id is %s', async (_label, id) => {
    const err = await refusal(signIn({ id: 1, user: { id } }));
    expect(err.reason).toBe('invalid_identity');
  });
});

describe("GitHub's non-standard token errors", () => {
  it('treats a 200 carrying an error body as the error it is', async () => {
    // GitHub answers a bad or expired code with HTTP 200 and an `error`
    // member. The library only looks for an error body on a non-200, so left
    // alone this fails later and by accident -- as a missing access_token --
    // and the log names the wrong problem. The cause must be GitHub's own
    // error, not a complaint about response shape.
    const err = await refusal(signIn({ id: 1 }, { tokenErrorWith200: true }));

    expect(err.reason).toBe('exchange_failed');
    expect((err.cause as { error?: string } | undefined)?.error).toBe('bad_verification_code');
  });

  it('makes no API call with a token it never received', async () => {
    await refusal(signIn({ id: 1 }, { tokenErrorWith200: true }));
    expect(stub.requests.some((r) => r.path === '/user')).toBe(false);
  });
});

describe('a flow that must be refused', () => {
  it('when the PKCE verifier does not match', async () => {
    await refusal(
      signIn({ id: 1 }, {}, (s) => {
        s.codeVerifier = randomBytes(32).toString('base64url');
      }),
    );
  });

  it('when the state does not match', async () => {
    await refusal(
      signIn({ id: 1 }, {}, (_s, query) => {
        query.set('state', 'forged');
      }),
    );
  });

  it('when the same code is redeemed twice', async () => {
    const github = strategy();
    const s = secrets();
    const url = await github.authorizationUrl({
      redirectUri: REDIRECT,
      state: s.state,
      codeChallenge: s.codeChallenge,
    });
    const query = stub.approve(url, { id: 77 });
    const callback = {
      redirectUri: REDIRECT,
      query,
      expectedState: s.state,
      codeVerifier: s.codeVerifier,
    };

    await expect(github.complete(callback)).resolves.toMatchObject({ accountId: '77' });
    await refusal(github.complete(callback));
  });

  it('when /user fails', async () => {
    const err = await refusal(signIn({ id: 1 }, { userStatus: 500 }));
    expect(err.reason).toBe('profile_failed');
  });

  it('when /user/emails fails', async () => {
    const err = await refusal(signIn({ id: 1 }, { emailsStatus: 403 }));
    expect(err.reason).toBe('profile_failed');
  });
});

describe('talking to the provider', () => {
  it('refuses plain HTTP unless explicitly allowed, before sending the secret', async () => {
    // As a provider error, not an escaped library exception: the first version
    // threw from authorizationUrl before any try, which would have been a 500.
    const err = await refusal(
      signIn({ id: 1 }, {}, () => undefined, strategy({ allowInsecureRequests: false })),
    );
    expect(err.reason).toBe('misconfigured');
    // Refused client-side: the client secret never left the process.
    expect(stub.requests.some((r) => r.path === '/login/oauth/access_token')).toBe(false);
  });

  it('gives up on a token endpoint that never answers', async () => {
    stub.hangTokenEndpoint = true;
    const started = Date.now();

    await refusal(signIn({ id: 1 }, {}, () => undefined, strategy({ timeoutMs: 1000 })));

    expect(Date.now() - started).toBeLessThan(5000);
  });
});
