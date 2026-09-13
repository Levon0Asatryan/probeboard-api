import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../../core/config/index.js';
import { createTestPool, truncateAll } from '../../../testing/database.js';
import { OAuthProviderStub } from '../../../testing/oauth-provider-stub.js';
import { AppModule } from '../../api.module.js';
import { configureApp, registerNotFoundFallback } from '../../bootstrap.js';
import type { OAuthProviderStrategy } from '../interfaces/oauth-provider.js';
import { GoogleStrategy } from '../strategies/google.strategy.js';
import { OAuthStrategyRegistry } from '../strategies/index.js';
import { oauthCookieName } from '../utils/oauth-cookie.js';
import { sessionCookieName } from '../utils/session-cookie.js';

/**
 * Linking a provider to an authenticated account (D13), and unlinking
 * (D14), through the real HTTP surface. The linking policy itself and the
 * unlink concurrency/last-credential guarantees are proved at the repository
 * and service layers already; this is the controller wiring on top: who is
 * allowed to call these, and which account a link actually attaches to.
 */

class StubStrategyRegistry {
  constructor(private readonly map: Map<string, OAuthProviderStrategy>) {}
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

const WEB_BASE_URL = 'http://127.0.0.1:5173';
let OAUTH_COOKIE: string;
let SESSION_COOKIE: string;

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
  process.env.AUTH_MAX_PER_IP = '200';
  process.env.PASSWORD_MIN_LENGTH = '10';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';

  googleStub = await OAuthProviderStub.start('oidc');

  const registry = new StubStrategyRegistry(
    new Map([
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
    ]),
  );

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
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

afterEach(() => {
  googleStub.requests.length = 0;
});

interface Res {
  status: number;
  location?: string;
  body: unknown;
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

async function call(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [];
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  return {
    status: res.status,
    location: res.headers.get('location') ?? undefined,
    body: text && isJson ? (JSON.parse(text) as unknown) : undefined,
    cookies: parseCookies(setCookie),
  };
}

function cookieHeader(cookies: Record<string, string>, ...names: string[]): string {
  return names
    .map((n) => `${n}=${cookies[n]}`)
    .filter((c) => !c.endsWith('=undefined'))
    .join('; ');
}

async function registerAndLogin(
  email: string,
  password = 'correct horse battery',
): Promise<string> {
  await call('/auth/register', { method: 'POST', body: { email, password } });
  const login = await call('/auth/login', { method: 'POST', body: { email, password } });
  return cookieHeader(login.cookies, SESSION_COOKIE);
}

describe('starting a link', () => {
  it('requires a session', async () => {
    const res = await call('/auth/oauth/google/link', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('sets the state cookie and returns a redirect url to follow', async () => {
    const session = await registerAndLogin('alice@example.com');
    const res = await call('/auth/oauth/google/link', { method: 'POST', cookie: session });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ redirectUrl: expect.stringContaining(googleStub.url) });
    expect(res.cookies[OAUTH_COOKIE]).toBeDefined();
  });
});

describe('completing a link', () => {
  it('attaches the identity to the session that started the flow, not a new account', async () => {
    const session = await registerAndLogin('alice@example.com');
    const start = await call('/auth/oauth/google/link', { method: 'POST', cookie: session });

    const authorizationUrl = new URL((start.body as { redirectUrl: string }).redirectUrl);
    const query = googleStub.approve(authorizationUrl, { id: 'link-1', email: 'g@example.com' });

    const callback = await call(`/auth/oauth/google/callback?${query.toString()}`, {
      cookie: cookieHeader(start.cookies, OAUTH_COOKIE),
    });

    expect(callback.status).toBe(302);
    expect(callback.location).toBe(`${WEB_BASE_URL}/`);

    const identities = await call('/auth/identities', { cookie: session });
    expect(identities.body).toEqual([
      expect.objectContaining({ provider: 'google', email: 'g@example.com' }),
    ]);
  });

  it('refuses when the provider account already belongs to somebody else (D13)', async () => {
    const owner = await registerAndLogin('owner@example.com');
    const startOwner = await call('/auth/oauth/google/link', { method: 'POST', cookie: owner });
    const ownerAuthUrl = new URL((startOwner.body as { redirectUrl: string }).redirectUrl);
    const ownerQuery = googleStub.approve(ownerAuthUrl, {
      id: 'shared-account',
      email: 'shared@example.com',
    });
    await call(`/auth/oauth/google/callback?${ownerQuery.toString()}`, {
      cookie: cookieHeader(startOwner.cookies, OAUTH_COOKIE),
    });

    const other = await registerAndLogin('other@example.com');
    const startOther = await call('/auth/oauth/google/link', { method: 'POST', cookie: other });
    const otherAuthUrl = new URL((startOther.body as { redirectUrl: string }).redirectUrl);
    const otherQuery = googleStub.approve(otherAuthUrl, {
      id: 'shared-account',
      email: 'shared@example.com',
    });

    const callback = await call(`/auth/oauth/google/callback?${otherQuery.toString()}`, {
      cookie: cookieHeader(startOther.cookies, OAUTH_COOKIE),
    });

    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=OAUTH_IDENTITY_TAKEN`);

    // Never silently moved: the owner keeps it.
    const ownerIdentities = await call('/auth/identities', { cookie: owner });
    expect(ownerIdentities.body).toEqual([expect.objectContaining({ provider: 'google' })]);
    const otherIdentities = await call('/auth/identities', { cookie: other });
    expect(otherIdentities.body).toEqual([]);
  });
});

describe('unlinking', () => {
  it('requires a session', async () => {
    expect((await call('/auth/oauth/google', { method: 'DELETE' })).status).toBe(401);
  });

  it('reports not found for a provider never linked', async () => {
    const session = await registerAndLogin('nolink@example.com');
    expect((await call('/auth/oauth/google', { method: 'DELETE', cookie: session })).status).toBe(
      404,
    );
  });

  it('removes an identity when the password remains as a way in', async () => {
    const session = await registerAndLogin('haspw@example.com');
    const start = await call('/auth/oauth/google/link', { method: 'POST', cookie: session });
    const authUrl = new URL((start.body as { redirectUrl: string }).redirectUrl);
    const query = googleStub.approve(authUrl, { id: 'haspw-1', email: 'g2@example.com' });
    await call(`/auth/oauth/google/callback?${query.toString()}`, {
      cookie: cookieHeader(start.cookies, OAUTH_COOKIE),
    });

    const res = await call('/auth/oauth/google', { method: 'DELETE', cookie: session });
    expect(res.status).toBe(204);

    const identities = await call('/auth/identities', { cookie: session });
    expect(identities.body).toEqual([]);
  });

  it('refuses to remove the last way to sign in (D14)', async () => {
    // Sign in fresh (no password) through the provider, then try to unlink.
    const start = await call('/auth/oauth/google/start');
    const authUrl = new URL(start.location!);
    const query = googleStub.approve(authUrl, { id: 'onlyway-1', email: 'only@example.com' });
    const callback = await call(`/auth/oauth/google/callback?${query.toString()}`, {
      cookie: cookieHeader(start.cookies, OAUTH_COOKIE),
    });
    const session = cookieHeader(callback.cookies, SESSION_COOKIE);

    const res = await call('/auth/oauth/google', { method: 'DELETE', cookie: session });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'LAST_CREDENTIAL' });

    // Still there afterwards -- the refusal did not half-apply.
    const identities = await call('/auth/identities', { cookie: session });
    expect(identities.body).toHaveLength(1);
  });
});
