import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../core/config/index.js';
import { ErrorFilter } from './common/filters/error.filter.js';
import { configureApp, registerNotFoundFallback } from './bootstrap.js';

/**
 * Boots a real HTTP server.
 *
 * The unit tests assert that `setGlobalPrefix` was *called*, which is not the
 * same as a route being served under `/v1`. That gap hid a real bug: a
 * wildcard among the prefix exclusions matched every route, so the whole API
 * would have been served unversioned while `/v1/...` returned 404.
 */

@Controller('monitors')
class MonitorsController {
  @Get()
  list() {
    return { ok: true };
  }
}

@Controller()
class RootHealthController {
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [MonitorsController, RootHealthController],
  providers: [{ provide: ErrorFilter, useValue: { catch: () => undefined } }],
})
class HarnessModule {}

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
});

let app: NestExpressApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(HarnessModule, { logger: false });
  configureApp(app, cfg);
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
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

describe('routing on a running server', () => {
  it('serves ordinary routes under the version prefix', async () => {
    const res = await fetch(`${base}/v1/monitors`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('does not serve ordinary routes unversioned', async () => {
    expect((await fetch(`${base}/monitors`)).status).toBe(404);
  });

  it('serves health endpoints without the prefix, and only there', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/healthz`)).status).toBe(404);
  });
});

describe('response headers', () => {
  it('does not announce the framework', async () => {
    // Express sets X-Powered-By on every response unless it is disabled. The
    // assertion covers a matched route and an unmatched one, because the
    // fallback writes its response through Express directly rather than
    // through Nest.
    for (const path of ['/v1/monitors', '/healthz', '/nope']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('x-powered-by'), `on ${path}`).toBeNull();
    }
  });
});

describe('unmatched routes', () => {
  it('answer with JSON, not Express HTML, inside the prefix', async () => {
    const res = await fetch(`${base}/v1/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({
      code: 'NOT_FOUND',
      message: 'route not found',
    });
  });

  it('answer with JSON outside the prefix too', async () => {
    // The earlier controller-based fallback could only cover one of these.
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NOT_FOUND',
      message: 'route not found',
    });
  });

  it('answer on any method, not only GET', async () => {
    const res = await fetch(`${base}/v1/monitors/123`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });
});
