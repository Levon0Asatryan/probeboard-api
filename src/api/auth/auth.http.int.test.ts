import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../core/config/index.js';
import { DbService } from '../../core/db/db.service.js';
import { truncateAll } from '../../testing/database.js';
import { AppModule } from '../api.module.js';
import { configureApp, registerNotFoundFallback } from '../bootstrap.js';
import { SESSION_COOKIE } from './session-cookie.js';

/**
 * The HTTP surface against a real server and a real database: real cookies,
 * real status codes, real middleware order.
 *
 * The unit tests assert what each piece does in isolation. Only this can show
 * that a cookie set by login is actually accepted by the guard, which depends
 * on cookie-parser running before the guard and on the cookie's attributes
 * matching between set and clear.
 */

let app: NestExpressApplication;
let base: string;
let db: DbService;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '1';
  process.env.COOKIE_SECURE = 'false';
  process.env.PASSWORD_MIN_LENGTH = '10';
  // Every request in this file comes from 127.0.0.1, but each test truncates
  // the attempts table, so the counter starts fresh per test.
  process.env.AUTH_MAX_PER_IP = '30';
  process.env.AUTH_MAX_FAILURES_PER_EMAIL = '5';
  process.env.LOG_LEVEL = 'fatal';

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app, loadConfig());
  await registerNotFoundFallback(app);
  // Bound to 127.0.0.1 explicitly, not 0.0.0.0.
  //
  // listen(0) on all interfaces succeeds even when another process already
  // holds 127.0.0.1 on the port the OS picks, and that more specific bind wins
  // for loopback traffic -- so the test's own requests can reach a different
  // server entirely. This suite saw exactly that once, as unexplained 403 and
  // 429 responses from routes that cannot produce them. Binding the loopback
  // address makes the port genuinely ours or the bind fails loudly.
  await app.listen(0, '127.0.0.1');

  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/v1`;
  db = app.get(DbService);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll((db as unknown as { pool: import('pg').Pool }).pool);
});

interface Res {
  status: number;
  body: unknown;
  cookie?: string;
  setCookieRaw?: string;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const raw = res.headers.get('set-cookie') ?? undefined;
  const text = await res.text();

  return {
    status: res.status,
    body: text ? (JSON.parse(text) as unknown) : undefined,
    setCookieRaw: raw,
    cookie: raw ? raw.split(';')[0] : undefined,
  };
}

const register = (email: string, password: string) =>
  call('/auth/register', { body: { email, password } });
const login = (email: string, password: string) =>
  call('/auth/login', { body: { email, password } });

describe('register', () => {
  it('creates an account and issues no session', async () => {
    // Deliberately no auto-login: see the duplicate case below.
    const res = await register('alice@example.com', 'correct horse battery');
    expect(res.status).toBe(204);
    expect(res.setCookieRaw).toBeUndefined();
  });

  it('A-1: a taken address is indistinguishable from a fresh one', async () => {
    const first = await register('alice@example.com', 'correct horse battery');
    const duplicate = await register('alice@example.com', 'different password');

    expect(duplicate.status).toBe(first.status);
    expect(duplicate.body).toEqual(first.body);
    expect(duplicate.setCookieRaw).toBe(first.setCookieRaw);
  });

  it('does not let a duplicate registration overwrite the password', async () => {
    await register('alice@example.com', 'original password');
    await register('alice@example.com', 'attacker password');

    expect((await login('alice@example.com', 'original password')).status).toBe(200);
    expect((await login('alice@example.com', 'attacker password')).status).toBe(401);
  });

  it('enforces the configured minimum length', async () => {
    const res = await register('alice@example.com', 'short');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a malformed address and an unknown field', async () => {
    expect((await register('not-an-email', 'correct horse battery')).status).toBe(400);
    expect(
      (
        await call('/auth/register', {
          body: { email: 'a@example.com', password: 'correct horse battery', isAdmin: true },
        })
      ).status,
    ).toBe(400);
  });
});

describe('login', () => {
  it('returns a session cookie the guard accepts', async () => {
    await register('alice@example.com', 'correct horse battery');
    const res = await login('alice@example.com', 'correct horse battery');

    expect(res.status).toBe(200);
    expect(res.cookie).toContain(SESSION_COOKIE);

    const me = await call('/auth/me', { method: 'GET', cookie: res.cookie });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'alice@example.com' });
  });

  it('sets the cookie HttpOnly, SameSite=Lax and scoped to the site', async () => {
    await register('alice@example.com', 'correct horse battery');
    const raw = (await login('alice@example.com', 'correct horse battery')).setCookieRaw!;

    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//i);
    // COOKIE_SECURE is false in this test, standing in for local development.
    expect(raw).not.toMatch(/Secure/i);
  });

  it('never puts the session token in the response body', async () => {
    await register('alice@example.com', 'correct horse battery');
    const res = await login('alice@example.com', 'correct horse battery');
    expect(JSON.stringify(res.body)).not.toContain('pbs_');
  });

  it('A-2: an unknown address and a wrong password are indistinguishable', async () => {
    await register('alice@example.com', 'correct horse battery');

    const unknown = await login('nobody@example.com', 'whatever');
    const wrong = await login('alice@example.com', 'wrong password');

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('the session guard', () => {
  it('refuses a request with no cookie', async () => {
    const res = await call('/auth/me', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a forged or malformed cookie', async () => {
    for (const cookie of [
      `${SESSION_COOKIE}=nonsense`,
      `${SESSION_COOKIE}=pbs_${'a'.repeat(43)}`,
      `${SESSION_COOKIE}=`,
    ]) {
      expect((await call('/auth/me', { method: 'GET', cookie })).status).toBe(401);
    }
  });

  it('refuses a revoked session', async () => {
    await register('alice@example.com', 'correct horse battery');
    const { cookie } = await login('alice@example.com', 'correct horse battery');

    expect((await call('/auth/logout', { cookie })).status).toBe(204);
    expect((await call('/auth/me', { method: 'GET', cookie })).status).toBe(401);
  });
});

describe('logout', () => {
  it('clears the cookie with the same attributes it was set with', async () => {
    // A browser treats a cookie with different flags as a different cookie, so
    // a mismatch would leave the original in place.
    await register('alice@example.com', 'correct horse battery');
    const { cookie } = await login('alice@example.com', 'correct horse battery');

    const res = await call('/auth/logout', { cookie });
    expect(res.setCookieRaw).toMatch(/HttpOnly/i);
    expect(res.setCookieRaw).toMatch(/SameSite=Lax/i);
    expect(res.setCookieRaw).toMatch(/Path=\//i);
  });

  it('logout-all ends every session, not just this one', async () => {
    await register('alice@example.com', 'correct horse battery');
    const a = await login('alice@example.com', 'correct horse battery');
    const b = await login('alice@example.com', 'correct horse battery');

    expect((await call('/auth/logout-all', { cookie: a.cookie })).status).toBe(204);

    expect((await call('/auth/me', { method: 'GET', cookie: a.cookie })).status).toBe(401);
    expect((await call('/auth/me', { method: 'GET', cookie: b.cookie })).status).toBe(401);
  });
});

describe('A-5: changing the password', () => {
  it('keeps this session and ends the others', async () => {
    await register('alice@example.com', 'correct horse battery');
    const mine = await login('alice@example.com', 'correct horse battery');
    const other = await login('alice@example.com', 'correct horse battery');

    const res = await call('/auth/password', {
      cookie: mine.cookie,
      body: { currentPassword: 'correct horse battery', newPassword: 'a different one' },
    });
    expect(res.status).toBe(204);

    expect((await call('/auth/me', { method: 'GET', cookie: mine.cookie })).status).toBe(200);
    expect((await call('/auth/me', { method: 'GET', cookie: other.cookie })).status).toBe(401);
  });

  it('requires the current password', async () => {
    await register('alice@example.com', 'correct horse battery');
    const { cookie } = await login('alice@example.com', 'correct horse battery');

    const res = await call('/auth/password', {
      cookie,
      body: { currentPassword: 'wrong', newPassword: 'a different one' },
    });
    expect(res.status).toBe(401);
  });

  it('applies the policy to the new password', async () => {
    await register('alice@example.com', 'correct horse battery');
    const { cookie } = await login('alice@example.com', 'correct horse battery');

    const res = await call('/auth/password', {
      cookie,
      body: { currentPassword: 'correct horse battery', newPassword: 'short' },
    });
    expect(res.status).toBe(400);
  });

  it('swaps which password works', async () => {
    await register('alice@example.com', 'correct horse battery');
    const { cookie } = await login('alice@example.com', 'correct horse battery');

    await call('/auth/password', {
      cookie,
      body: { currentPassword: 'correct horse battery', newPassword: 'a different one' },
    });

    expect((await login('alice@example.com', 'correct horse battery')).status).toBe(401);
    expect((await login('alice@example.com', 'a different one')).status).toBe(200);
  });
});

describe('registration cannot be used against an account', () => {
  it('duplicate registrations do not lock the owner out', async () => {
    // Otherwise an unauthenticated attacker submits N duplicate registrations
    // for a victim's address, exhausts the credential-failure counter, and the
    // victim's correct password returns 429 for the whole window.
    await register('victim3@example.com', 'correct horse battery');

    for (let i = 0; i < 8; i++) await register('victim3@example.com', 'whatever it takes');

    const res = await login('victim3@example.com', 'correct horse battery');
    expect(res.status).toBe(200);
  });

  it('registration is still limited, by address rather than by account', async () => {
    // Mass registration from one host is throttled; it just does not touch the
    // credential-failure counter belonging to any account.
    const results: number[] = [];
    for (let i = 0; i < 600; i++) {
      results.push(
        (await register(`flood${String(i)}@example.com`, 'correct horse battery')).status,
      );
    }
    expect(results).toContain(429);
  });
});

describe('changing a password is rate limited too', () => {
  it('refuses after repeated wrong current passwords', async () => {
    // Otherwise anyone holding a session -- including a stolen one -- can
    // brute-force the current password, and spend one Argon2 verification of
    // our CPU per guess, without ever meeting the limiter.
    await register('pw-brute@example.com', 'correct horse battery');
    const { cookie } = await login('pw-brute@example.com', 'correct horse battery');

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push(
        (
          await call('/auth/password', {
            cookie,
            body: { currentPassword: `guess ${String(i)}`, newPassword: 'a brand new one' },
          })
        ).status,
      );
    }

    expect(statuses).toContain(429);
  });
});

describe('A-6: rate limiting through HTTP', () => {
  it('locks an account after repeated failures and says so', async () => {
    await register('victim@example.com', 'correct horse battery');

    for (let i = 0; i < 5; i++) await login('victim@example.com', 'wrong');

    const res = await login('victim@example.com', 'correct horse battery');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('a forged X-Forwarded-For does not buy a fresh limit', async () => {
    // trust proxy is off, so the header is ignored and every request keys on
    // the same socket address.
    await register('victim2@example.com', 'correct horse battery');

    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${String(i)}` },
        body: JSON.stringify({ email: 'victim2@example.com', password: 'wrong' }),
      });
    }

    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.99' },
      body: JSON.stringify({ email: 'victim2@example.com', password: 'correct horse battery' }),
    });
    expect(res.status).toBe(429);
  });
});
