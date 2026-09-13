import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../../core/config/index.js';
import { DbService } from '../../../core/db/db.service.js';
import { createTestPool, truncateAll } from '../../../testing/database.js';
import { OAuthProviderStub } from '../../../testing/oauth-provider-stub.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';
import { GitHubStrategy } from '../strategies/github.strategy.js';
import { GoogleStrategy } from '../strategies/google.strategy.js';
import type { OAuthProviderStrategy } from '../interfaces/oauth-provider.js';
import { OAuthStrategyRegistry } from '../strategies/strategy-registry.service.js';
import { oauthCookieName } from '../utils/oauth-cookie.js';
import { sessionCookieName } from '../utils/session-cookie.js';

/**
 * The whole sign-in flow against a real server, a real database and a real
 * (local) identity provider: the parts a unit test of any one piece cannot
 * show, because they are properties of the wiring between the pieces.
 *
 * The provider strategies are swapped for ones pointed at
 * `OAuthProviderStub` -- the production `OAuthStrategyRegistry` only ever
 * builds strategies aimed at Google and GitHub themselves, and nothing in
 * production configuration can point it anywhere else. `allowInsecureRequests`
 * is likewise something only this substitution ever sets.
 */

class StubStrategyRegistry {
  private readonly map: Map<string, OAuthProviderStrategy>;
  constructor(entries: [string, OAuthProviderStrategy][]) {
    this.map = new Map(entries);
  }
  get(provider: string): OAuthProviderStrategy {
    const strategy = this.map.get(provider);
    if (!strategy) throw new Error(`no stub strategy for ${provider}`);
    return strategy;
  }
}

let app: NestExpressApplication;
let base: string;
let pool: Pool;
let googleStub: OAuthProviderStub;
let githubStub: OAuthProviderStub;

const WEB_BASE_URL = 'http://127.0.0.1:5173';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.LOG_LEVEL = 'fatal';
  process.env.COOKIE_SECURE = 'false';
  process.env.OAUTH_ENABLED = 'true';
  process.env.OAUTH_REDIRECT_BASE_URL = 'http://127.0.0.1:3000';
  process.env.WEB_BASE_URL = WEB_BASE_URL;
  process.env.GOOGLE_CLIENT_ID = 'unused-placeholder-id';
  process.env.GOOGLE_CLIENT_SECRET = 'unused-placeholder-secret';
  process.env.GITHUB_CLIENT_ID = 'unused-placeholder-id';
  process.env.GITHUB_CLIENT_SECRET = 'unused-placeholder-secret';
  process.env.AUTH_MAX_PER_IP = '30';
  process.env.OAUTH_STATE_TTL_MS = '600000';

  googleStub = await OAuthProviderStub.start('oidc');
  githubStub = await OAuthProviderStub.start('github');

  const registry = new StubStrategyRegistry([
    [
      'google',
      new GoogleStrategy({
        clientId: googleStub.clientId,
        clientSecret: googleStub.clientSecret,
        timeoutMs: 5000,
        issuer: new URL(googleStub.url),
        allowInsecureRequests: true,
      }),
    ],
    [
      'github',
      new GitHubStrategy({
        clientId: githubStub.clientId,
        clientSecret: githubStub.clientSecret,
        timeoutMs: 5000,
        webBaseUrl: githubStub.url,
        apiBaseUrl: githubStub.url,
        allowInsecureRequests: true,
      }),
    ],
  ]);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OAuthStrategyRegistry)
    .useValue(registry)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, loadConfig());
  await registerNotFoundFallback(app);
  await app.listen(0, '127.0.0.1');

  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/v1`;
  pool = createTestPool();

  const cfg = loadConfig();
  OAUTH_COOKIE = oauthCookieName(cfg);
  SESSION_COOKIE = sessionCookieName(cfg);
});

afterAll(async () => {
  await app.close();
  await googleStub.close();
  await githubStub.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

afterEach(() => {
  googleStub.requests.length = 0;
  githubStub.requests.length = 0;
});

interface Res {
  status: number;
  location?: string;
  cookies: Record<string, string>;
}

function parseCookies(setCookie: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

async function get(path: string, opts: { cookie?: string } = {}): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });
  const setCookie =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [];
  await res.arrayBuffer();
  return {
    status: res.status,
    location: res.headers.get('location') ?? undefined,
    cookies: parseCookies(setCookie),
  };
}

function cookieHeader(cookies: Record<string, string>, ...names: string[]): string {
  return names
    .map((n) => `${n}=${cookies[n]}`)
    .filter((c) => !c.endsWith('=undefined'))
    .join('; ');
}

let OAUTH_COOKIE: string;
let SESSION_COOKIE: string;

/** Plays the browser round trip against the stub, returning the callback response. */
async function signIn(
  provider: 'google' | 'github',
  identity: Parameters<OAuthProviderStub['approve']>[1],
  opts: { returnTo?: string; startCookie?: string; tamperState?: string } = {},
): Promise<{ start: Res; callback: Res; callbackPath: string; callbackCookie: string }> {
  const stub = provider === 'google' ? googleStub : githubStub;
  const qs = opts.returnTo ? `?returnTo=${encodeURIComponent(opts.returnTo)}` : '';
  const start = await get(`/auth/oauth/${provider}/start${qs}`);
  expect(start.status).toBe(302);

  const authorizationUrl = new URL(start.location!);
  const query = stub.approve(authorizationUrl, identity);
  if (opts.tamperState) query.set('state', opts.tamperState);

  const callbackPath = `/auth/oauth/${provider}/callback?${query.toString()}`;
  const callbackCookie = opts.startCookie ?? cookieHeader(start.cookies, OAUTH_COOKIE);
  const callback = await get(callbackPath, { cookie: callbackCookie });

  return { start, callback, callbackPath, callbackCookie };
}

describe('a full sign-in', () => {
  it('creates an account and issues a session redirecting to the default path', async () => {
    const { callback } = await signIn('google', { id: 'sub-1', email: 'new@example.com' });

    expect(callback.status).toBe(302);
    expect(callback.location).toBe(`${WEB_BASE_URL}/`);
    expect(callback.cookies[SESSION_COOKIE]).toBeDefined();
    // The state cookie is cleared regardless of outcome.
    expect(callback.cookies[OAUTH_COOKIE]).toBe('');

    const me = await get('/auth/me', {
      cookie: cookieHeader(callback.cookies, SESSION_COOKIE),
    });
    expect(me.status).toBe(200);
  });

  it('reaches the same account on a later sign-in with the same identity', async () => {
    await signIn('google', { id: 'sub-2', email: 'again@example.com' });
    const second = await signIn('google', { id: 'sub-2', email: 'again@example.com' });

    expect(second.callback.status).toBe(302);
    expect(second.callback.cookies[SESSION_COOKIE]).toBeDefined();
  });

  it('works for GitHub too, using the numeric id', async () => {
    const { callback } = await signIn('github', { id: 42, email: 'octo@example.com' });
    expect(callback.status).toBe(302);
    expect(callback.cookies[SESSION_COOKIE]).toBeDefined();
  });
});

describe('the state cookie is required and single-use', () => {
  it('refuses a callback with no state cookie', async () => {
    const start = await get('/auth/oauth/google/start');
    const authorizationUrl = new URL(start.location!);
    const query = googleStub.approve(authorizationUrl, { id: 'sub-3', email: 'x@example.com' });

    const callback = await get(`/auth/oauth/google/callback?${query.toString()}`);

    expect(callback.status).toBe(302);
    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=OAUTH_STATE_INVALID`);
    expect(callback.cookies[SESSION_COOKIE]).toBeUndefined();
  });

  it('refuses a callback whose state belongs to a different flow', async () => {
    const a = await get('/auth/oauth/google/start');
    const b = await get('/auth/oauth/google/start');

    const urlB = new URL(b.location!);
    const queryB = googleStub.approve(urlB, { id: 'sub-4', email: 'b@example.com' });

    // A's cookie, B's completed authorization query.
    const callback = await get(`/auth/oauth/google/callback?${queryB.toString()}`, {
      cookie: cookieHeader(a.cookies, OAUTH_COOKIE),
    });

    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=OAUTH_STATE_INVALID`);
  });

  it('refuses a replayed callback', async () => {
    const {
      callback: first,
      callbackPath,
      callbackCookie,
    } = await signIn('google', {
      id: 'sub-5',
      email: 'replay@example.com',
    });
    expect(first.status).toBe(302);
    expect(first.cookies[SESSION_COOKIE]).toBeDefined();

    // The exact same URL and cookie, again. The pending row was deleted by
    // the first callback (single use), so this finds nothing to consume --
    // and the code was already redeemed at the provider too, which would
    // refuse it independently.
    const replay = await get(callbackPath, { cookie: callbackCookie });

    expect(replay.location).toBe(`${WEB_BASE_URL}/login?error=OAUTH_STATE_INVALID`);
    expect(replay.cookies[SESSION_COOKIE]).toBeUndefined();
  });

  it('refuses an expired authorization', async () => {
    const start = await get('/auth/oauth/google/start');
    const authorizationUrl = new URL(start.location!);
    const query = googleStub.approve(authorizationUrl, { id: 'sub-6', email: 'x@example.com' });

    // Force it into the past directly, rather than waiting out the TTL.
    const db = app.get(DbService);
    await db.kysely
      .updateTable('oauth_authorizations')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();

    const callback = await get(`/auth/oauth/google/callback?${query.toString()}`, {
      cookie: cookieHeader(start.cookies, OAUTH_COOKIE),
    });

    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=OAUTH_STATE_INVALID`);
  });
});

describe('returnTo', () => {
  it('honours a valid site-relative path', async () => {
    const { callback } = await signIn(
      'google',
      { id: 'sub-7', email: 'r@example.com' },
      { returnTo: '/services' },
    );
    expect(callback.location).toBe(`${WEB_BASE_URL}/services`);
  });

  it.each(['//evil.com', 'https://evil.com', '/\\evil.com'])(
    'falls back to the default for %s',
    async (returnTo) => {
      const { callback } = await signIn(
        'google',
        { id: `sub-return-${returnTo}`, email: 'r2@example.com' },
        { returnTo },
      );
      expect(callback.location).toBe(`${WEB_BASE_URL}/`);
    },
  );
});

describe('session fixation', () => {
  it('the callback issues a brand-new session, ignoring any cookie already present', async () => {
    // Sign in as A first, keep A's session.
    const a = await signIn('google', { id: 'fixation-a', email: 'a@example.com' });
    const aSessionCookie = cookieHeader(a.callback.cookies, SESSION_COOKIE);

    // Start a second flow and complete it while presenting A's session cookie
    // alongside the oauth state cookie -- as if an attacker had planted it.
    const start = await get('/auth/oauth/google/start');
    const authorizationUrl = new URL(start.location!);
    const query = googleStub.approve(authorizationUrl, {
      id: 'fixation-b',
      email: 'b@example.com',
    });

    const callback = await get(`/auth/oauth/google/callback?${query.toString()}`, {
      cookie: `${cookieHeader(start.cookies, OAUTH_COOKIE)}; ${aSessionCookie}`,
    });

    const bSessionCookie = cookieHeader(callback.cookies, SESSION_COOKIE);
    expect(bSessionCookie).not.toBe(aSessionCookie);

    // A's own session is untouched.
    const meA = await get('/auth/me', { cookie: aSessionCookie });
    expect(meA.status).toBe(200);
    const meB = await get('/auth/me', { cookie: bSessionCookie });
    expect(meB.status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('refuses /start once the ip budget is spent', async () => {
    // AUTH_MAX_PER_IP is 30 for this whole file (set at boot, in beforeAll).
    // Every attempt counts on /start, not only failures, so a burst well past
    // that admits some and refuses the rest.
    const results = await Promise.all(
      Array.from({ length: 40 }, () => get('/auth/oauth/google/start')),
    );
    expect(results.some((r) => r.status === 429)).toBe(true);
    expect(results.some((r) => r.status === 302)).toBe(true);
  });
});
