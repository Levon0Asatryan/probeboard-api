import type { NestExpressApplication } from '@nestjs/platform-express';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../core/config/index.js';
import { API_VERSION_PREFIX, UNVERSIONED_PATHS, configureApp } from './bootstrap.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  API_BODY_LIMIT: '32kb',
});

function fakeApp() {
  const app = {
    setGlobalPrefix: vi.fn(),
    useGlobalFilters: vi.fn(),
    useBodyParser: vi.fn(),
    use: vi.fn(),
    set: vi.fn(),
    disable: vi.fn(),
    enableShutdownHooks: vi.fn(),
    get: vi.fn().mockReturnValue({ catch: vi.fn() }),
  };
  return app as unknown as NestExpressApplication & typeof app;
}

describe('configureApp', () => {
  it('versions the api', () => {
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.setGlobalPrefix).toHaveBeenCalledWith(API_VERSION_PREFIX, {
      exclude: UNVERSIONED_PATHS,
    });
  });

  it('leaves the health endpoints unversioned', () => {
    // An orchestrator's probe should not have to track API versions.
    expect(UNVERSIONED_PATHS).toContain('healthz');
    expect(UNVERSIONED_PATHS).toContain('readyz');
  });

  it('excludes only explicit paths, never a wildcard', () => {
    // Nest matches every exclude entry against every discovered route, so a
    // wildcard excludes the whole API from the prefix rather than one
    // controller. That is exactly what it did: /monitors was served and
    // /v1/monitors returned 404.
    expect(UNVERSIONED_PATHS.every((p) => typeof p === 'string' && !p.includes('*'))).toBe(true);
  });

  it('does not announce the framework', () => {
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.disable).toHaveBeenCalledWith('x-powered-by');
  });

  it('registers the error filter so no failure escapes unmapped', () => {
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.useGlobalFilters).toHaveBeenCalledOnce();
  });

  it('bounds the request body from configuration, not a literal', () => {
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.useBodyParser).toHaveBeenCalledWith('json', { limit: '32kb' });
  });

  it('parses cookies, since the session arrives in one', () => {
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.use).toHaveBeenCalledOnce();
  });

  it('does not trust X-Forwarded-For unless configured to', () => {
    // The per-IP rate limit keys on the client address. Trusting a header any
    // client can set would let an attacker present a fresh address per request.
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.set).toHaveBeenCalledWith('trust proxy', false);
  });

  it('trusts the proxy when a deployment opts in', () => {
    const app = fakeApp();
    configureApp(app, { ...cfg, TRUST_PROXY: true });
    expect(app.set).toHaveBeenCalledWith('trust proxy', true);
  });

  it('enables shutdown hooks so the database pool is released', () => {
    const app = fakeApp();
    configureApp(app, cfg);
    expect(app.enableShutdownHooks).toHaveBeenCalledOnce();
  });
});
