import 'reflect-metadata';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../api.module.js';
import { API_VERSION_PREFIX, UNVERSIONED_PATHS } from '../bootstrap.js';
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
 *
 * Controllers are discovered by walking `AppModule`'s own import graph rather
 * than named one by one: a hard-coded controller list agrees with the
 * document by construction whenever a new controller is added and nobody
 * remembers to list it here too, which is the exact drift this test exists to
 * catch. Walking the graph means a new controller is covered — or fails
 * loudly — the moment it is registered anywhere under `AppModule`.
 */

interface Route {
  method: string;
  path: string;
}

type Ctor = new (...args: never[]) => unknown;
/** What can appear in a `@Module()` `imports` array: a class, or the plain
 * object a `.forRoot()`/`.forRootAsync()` factory returns. */
type ModuleRef = Ctor | { module: Ctor; imports?: unknown[]; controllers?: Ctor[] };

/**
 * Every controller reachable from a module's import graph, read the same way
 * Nest itself reads it: `@Module()` decorator metadata for a static module,
 * and the object's own properties for a dynamic one (`forRootAsync()` and
 * friends return a plain object, not a decorated class).
 */
function controllersOf(root: Ctor): Ctor[] {
  const visited = new Set<Ctor>();
  const found = new Set<Ctor>();

  function visit(ref: ModuleRef): void {
    const cls = typeof ref === 'function' ? ref : ref.module;
    if (visited.has(cls)) return;
    visited.add(cls);

    const ownControllers =
      typeof ref === 'function'
        ? ((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls) as Ctor[] | undefined) ?? [])
        : (ref.controllers ?? []);
    for (const controller of ownControllers) found.add(controller);

    const imports =
      typeof ref === 'function'
        ? ((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) as unknown[] | undefined) ?? [])
        : (ref.imports ?? []);
    for (const imp of imports) visit(imp as ModuleRef);
  }

  visit(root);
  return [...found];
}

/** Every route Nest would register for a controller, prefixed as it will serve. */
function routesOf(controller: Ctor): Route[] {
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

const actual = controllersOf(AppModule).flatMap(routesOf);

const documented = Object.entries(buildOpenApiDocument().paths as Record<string, object>).flatMap(
  ([path, operations]) => Object.keys(operations).map((method) => ({ method, path })),
);

// Nest's own route metadata spells a path parameter Express-style (`:id`);
// OpenAPI requires `{id}`. Normalising here, rather than making the document
// non-standard to match, keeps the generated spec valid for the tooling that
// actually consumes it (codegen, Swagger UI's "Try it out").
const asOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const key = (r: Route) => `${r.method.toUpperCase()} ${asOpenApiPath(r.path)}`;

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

  it('encodes the tag-key colon ban as a pattern, since z.toJSONSchema drops .refine()', () => {
    const create = schemas.CreateEndpointRequest as {
      properties: { tags: { items: { properties: { key: { pattern: string } } } } };
    };
    expect(create.properties.tags.items.properties.key.pattern).toBe('^[^:]*$');
  });
});

describe('the cursor parameter', () => {
  it('documents the cursor as a uuid, matching listQuerySchema', () => {
    const doc = buildOpenApiDocument();
    const paths = doc.paths as Record<
      string,
      Record<string, { parameters?: { name: string; schema: { format?: string } }[] }>
    >;
    const get = paths['/v1/services'].get;
    const cursor = get.parameters!.find((p) => p.name === 'cursor')!;
    expect(cursor.schema.format).toBe('uuid');
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

describe('the server entry', () => {
  it('is relative, so it resolves against whatever origin serves the document', () => {
    // An absolute address baked into the document sends every "Try it out"
    // on a deployment other than exactly that address to the wrong place --
    // a hard-coded http://127.0.0.1:3000 works only on the machine that
    // string names.
    const doc = buildOpenApiDocument();
    const servers = doc.servers as { url: string }[];
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      expect(() => new URL(server.url)).toThrow();
    }
  });
});

describe('the session cookie scheme', () => {
  function cookieNameOf(cfg: { COOKIE_SECURE: boolean }): string {
    const doc = buildOpenApiDocument(cfg);
    const schemes = (doc.components as { securitySchemes: { sessionCookie: { name: string } } })
      .securitySchemes;
    return schemes.sessionCookie.name;
  }

  it('names the cookie a Secure deployment actually sets', () => {
    expect(cookieNameOf({ COOKIE_SECURE: true })).toBe('__Host-pb_session');
  });

  it('names the cookie a plain-HTTP local deployment actually sets', () => {
    // The bug this proves is fixed: the scheme used to hard-code
    // __Host-pb_session even while documenting the local compose server,
    // where COOKIE_SECURE=false makes the real cookie pb_session.
    expect(cookieNameOf({ COOKIE_SECURE: false })).toBe('pb_session');
  });

  it('defaults to the production name when built with no config, as cli.ts does', () => {
    const doc = buildOpenApiDocument();
    const schemes = (doc.components as { securitySchemes: { sessionCookie: { name: string } } })
      .securitySchemes;
    expect(schemes.sessionCookie.name).toBe('__Host-pb_session');
  });
});
