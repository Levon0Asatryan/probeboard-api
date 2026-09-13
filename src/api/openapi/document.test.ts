import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthController } from '../auth/auth.controller.js';
import { API_VERSION_PREFIX, UNVERSIONED_PATHS } from '../bootstrap.js';
import { HealthController } from '../health/health.controller.js';
import { buildOpenApiDocument } from './document.js';

/**
 * The document has to describe the routes that exist, not the ones somebody
 * remembered to write down.
 *
 * So the route table is read back out of Nest's own decorator metadata — the
 * same metadata the router builds from — and compared with the document in
 * both directions. An endpoint added without a spec entry fails here, and so
 * does a spec entry for an endpoint that was removed. Without this the
 * document is prose that happens to live in a .ts file.
 */

interface Route {
  method: string;
  path: string;
}

/** Every route Nest would register for a controller, prefixed as it will serve. */
function routesOf(controller: new (...args: never[]) => unknown): Route[] {
  const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
  const proto = controller.prototype as object;

  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = (proto as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return [];

      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (path === undefined || verb === undefined) return [];

      const segments = [base, path].filter((s) => s && s !== '/');
      const joined = `/${segments.join('/')}`;
      // Health paths are excluded from the global prefix; everything else
      // carries it. Mirrors bootstrap.ts, and the assertion below proves the
      // two agree.
      const unversioned = UNVERSIONED_PATHS.includes(path);

      return [
        {
          method: RequestMethod[verb].toLowerCase(),
          path: unversioned ? joined : `/${API_VERSION_PREFIX}${joined}`,
        },
      ];
    });
}

const actual = [...routesOf(AuthController), ...routesOf(HealthController)];

const documented = Object.entries(buildOpenApiDocument().paths as Record<string, object>).flatMap(
  ([path, operations]) => Object.keys(operations).map((method) => ({ method, path })),
);

const key = (r: Route) => `${r.method.toUpperCase()} ${r.path}`;

describe('the document and the router agree', () => {
  it('documents every route the controllers serve', () => {
    const missing = actual.filter((r) => !documented.some((d) => key(d) === key(r)));
    expect(missing.map(key)).toEqual([]);
  });

  it('documents no route the controllers do not serve', () => {
    const extra = documented.filter((d) => !actual.some((r) => key(r) === key(d)));
    expect(extra.map(key)).toEqual([]);
  });

  it('found the routes at all, so an empty comparison cannot pass by accident', () => {
    // Both lists above would agree if the reflection silently returned
    // nothing. This is the assertion that makes the other two mean something.
    expect(actual.length).toBeGreaterThanOrEqual(8);
  });
});

describe('shapes come from the schemas the server validates with', () => {
  const doc = buildOpenApiDocument();
  const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> }).schemas;

  it('rejects unknown fields, because the zod schemas are strict', () => {
    for (const name of ['RegisterRequest', 'LoginRequest', 'ChangePasswordRequest']) {
      expect(schemas[name].additionalProperties, name).toBe(false);
    }
  });

  it('carries the real bounds rather than a hand-copied guess', () => {
    const register = schemas.RegisterRequest as {
      properties: { email: { maxLength: number }; password: { maxLength: number } };
      required: string[];
    };
    expect(register.properties.email.maxLength).toBe(254);
    expect(register.properties.password.maxLength).toBe(256);
    expect(register.required).toEqual(['email', 'password']);
  });

  it('does not promise a minimum password length, which is configuration', () => {
    // The bound is enforced in AuthService from config, so a schema that
    // advertised one would be describing a value the deployment can change.
    const register = schemas.RegisterRequest as {
      properties: { password: Record<string, unknown> };
    };
    expect(register.properties.password.minLength).toBe(1);
  });

  it('describes login as accepting any non-empty password', () => {
    // Deliberately not the registration policy: a login must not reveal it,
    // and must not answer differently for an address that exists.
    const login = schemas.LoginRequest as { properties: { password: { minLength: number } } };
    expect(login.properties.password.minLength).toBe(1);
  });
});

describe('the error contract', () => {
  const doc = buildOpenApiDocument();
  const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> }).schemas;

  it('lists every code a client may have to branch on', () => {
    const codes = (schemas.Error as { properties: { code: { enum: string[] } } }).properties.code
      .enum;
    for (const code of [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'INVALID_CREDENTIALS',
      'RATE_LIMITED',
      'NO_PASSWORD_SET',
      'PAYLOAD_TOO_LARGE',
      'INTERNAL_ERROR',
    ]) {
      expect(codes).toContain(code);
    }
  });

  it('requires code and message on every failure', () => {
    expect((schemas.Error as { required: string[] }).required).toEqual(['code', 'message']);
  });
});

describe('authentication', () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as Record<string, Record<string, { security?: unknown[] }>>;

  it('leaves the routes that must work without a session unauthenticated', () => {
    for (const path of ['/healthz', '/readyz', '/v1/auth/register', '/v1/auth/login']) {
      const [operation] = Object.values(paths[path]);
      expect(operation.security, path).toEqual([]);
    }
  });

  it('requires the session cookie everywhere else, by the document default', () => {
    for (const path of ['/v1/auth/me', '/v1/auth/logout', '/v1/auth/logout-all']) {
      const [operation] = Object.values(paths[path]);
      // No per-operation override, so the document-level requirement applies.
      expect(operation.security, path).toBeUndefined();
    }
    expect(doc.security).toEqual([{ sessionCookie: [] }]);
  });
});
