import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../core/config/index.js';
import { ErrorFilter } from '../common/filters/error.filter.js';
import { configureApp, registerNotFoundFallback } from '../bootstrap.js';
import { DOCS_PATH, setupApiDocs } from './docs.js';

/**
 * The documentation page against a running server.
 *
 * Two things need proving and neither is visible from the unit level: that the
 * switch actually withholds the page when it is off, and that mounting it
 * before the not-found fallback is what makes its assets load. Registered the
 * other way round, the page renders and every request it makes answers the
 * JSON 404 — which looks like a broken document rather than a wiring mistake.
 */

@Controller('monitors')
class MonitorsController {
  @Get()
  list() {
    return { ok: true };
  }
}

@Module({
  controllers: [MonitorsController],
  providers: [{ provide: ErrorFilter, useValue: { catch: () => undefined } }],
})
class HarnessModule {}

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard' };

async function serve(
  env: Record<string, string>,
): Promise<{ url: string; app: NestExpressApplication }> {
  const cfg = loadConfig({ ...base, ...env });
  const app = await NestFactory.create<NestExpressApplication>(HarnessModule, { logger: false });
  configureApp(app, cfg);
  setupApiDocs(app, cfg);
  await registerNotFoundFallback(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, app };
}

let enabled: Awaited<ReturnType<typeof serve>>;
let disabled: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  enabled = await serve({ API_DOCS_ENABLED: 'true' });
  disabled = await serve({ API_DOCS_ENABLED: 'false' });
});

afterAll(async () => {
  await enabled.app.close();
  await disabled.app.close();
});

describe('when enabled', () => {
  it('serves the documentation page', async () => {
    const res = await fetch(`${enabled.url}/${DOCS_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves the document the page renders from', async () => {
    const res = await fetch(`${enabled.url}/${DOCS_PATH}-json`);
    expect(res.status).toBe(200);

    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.0.3');
    // The same paths the generated file carries, not a decorator scan.
    expect(Object.keys(doc.paths)).toContain('/v1/auth/login');
  });

  it('does not shadow the API it documents', async () => {
    expect((await fetch(`${enabled.url}/v1/monitors`)).status).toBe(200);
  });

  it('still answers JSON for an unmatched route', async () => {
    const res = await fetch(`${enabled.url}/v1/nope`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('when disabled', () => {
  it('withholds the page, rather than serving it unlisted', async () => {
    const res = await fetch(`${disabled.url}/${DOCS_PATH}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('withholds the document too', async () => {
    expect((await fetch(`${disabled.url}/${DOCS_PATH}-json`)).status).toBe(404);
  });
});
