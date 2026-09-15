import { z, type ZodType } from 'zod';
import { API_VERSION_PREFIX } from '../bootstrap.js';
import { changePasswordSchema } from '../auth/dto/change-password.dto.js';
import { loginSchema } from '../auth/dto/login.dto.js';
import { registerSchema } from '../auth/dto/register.dto.js';
import { sessionCookieName } from '../auth/utils/session-cookie.js';
import { LIVENESS_PATH, READINESS_PATH } from '../health/constants.js';
import type { AppConfig } from '../../core/config/schema.js';
import { updateServiceSchema } from '../registration/dto/update-service.dto.js';
import { createEndpointSchema } from '../registration/dto/create-endpoint.dto.js';
import { updateEndpointSchema } from '../registration/dto/update-endpoint.dto.js';
import { jsonValueSchema } from '../registration/dto/endpoint-fields.js';
import { headerListSchema } from '../registration/dto/header.dto.js';
import { tagListSchema } from '../registration/dto/tag.dto.js';

/**
 * The OpenAPI description of what this service serves.
 *
 * Built from the same zod schemas the request pipeline validates against, so
 * the document cannot describe a body the server would reject. `docs/README.md`
 * asks for reference material to be generated rather than written for exactly
 * this reason: a hand-maintained spec is wrong the first time a field changes
 * and nobody notices until a client is already built on it.
 *
 * What is *not* derived is the part zod knows nothing about — which statuses a
 * route answers with, what the cookie is called, what each error code means.
 * That is written out below, and `openapi.test.ts` checks it against the real
 * route table rather than trusting it.
 */

/** Emitted by zod, in the dialect OpenAPI 3.0 accepts. */
function schemaOf(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' });
}

/**
 * `z.toJSONSchema`'s handling of a recursive schema (`jsonValueSchema`,
 * `endpoint-fields.ts`) is not a valid OpenAPI 3.0 document on its own: a
 * schema converted standalone self-references as `$ref: "#"` (document
 * root), and one nested inside a larger conversion (`assertionSchema`
 * inside `createEndpointSchema`/`updateEndpointSchema`) instead gets a
 * `definitions` object *nested inside that field's own schema* with
 * `$ref: "#/definitions/__schema0"` -- `definitions` is a Swagger 2.0/JSON
 * Schema keyword OpenAPI 3.0 does not recognize at all, and even if it
 * did, the ref is relative to the document root, not to wherever this
 * function embeds the field, so no conformant resolver finds either.
 *
 * Rewritten here to a single shared `components.schemas.JsonValue`
 * (registered once, below) that every occurrence -- the standalone
 * conversion and any nested one -- references by its real path, with the
 * orphaned local `definitions` block dropped.
 */
function inlineJsonValueRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(inlineJsonValueRefs);
  if (node === null || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string' && (obj.$ref === '#' || obj.$ref.startsWith('#/definitions/'))) {
    return { $ref: '#/components/schemas/JsonValue' };
  }

  const { definitions: _dropped, ...rest } = obj;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    out[key] = inlineJsonValueRefs(value);
  }
  return out;
}

/**
 * Every failure this API can produce, as one shape.
 *
 * `code` is the contract and `message` is prose: a client branches on the
 * former and shows the latter. Documented as an enum so a frontend can
 * exhaustively switch on it and a reviewer can see when a new one appears.
 */
const ERROR_CODES = [
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'NOT_FOUND',
  'CONFLICT',
  'NO_PASSWORD_SET',
  'LAST_CREDENTIAL',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'DATABASE_UNAVAILABLE',
  'INTERNAL_ERROR',
  // Registration (M2): save-time SSRF validation (docs/m2-plan.md §5.1).
  'SCHEME_NOT_ALLOWED',
  'CREDENTIALS_IN_URL',
  'PORT_NOT_ALLOWED',
  'URL_UNRESOLVABLE',
  'ADDRESS_NOT_ALLOWED',
  // Registration: header validation (§5.2) and the endpoint quota (§5.3).
  'HEADER_NOT_ALLOWED',
  'HEADER_INVALID',
  'QUOTA_EXCEEDED',
] as const;

const errorSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: {
      type: 'string',
      enum: [...ERROR_CODES],
      description: 'Stable machine-readable code. Branch on this, never on `message`.',
    },
    message: {
      type: 'string',
      description: 'Human-readable prose. Safe to display; never contains internal detail.',
    },
    details: {
      description:
        'Shape depends on `code`: an array of field issues on VALIDATION_FAILED, ' +
        '`{limit, count}` on QUOTA_EXCEEDED, absent on every other code.',
      oneOf: [
        {
          type: 'array',
          description: 'VALIDATION_FAILED: one entry per rejected field.',
          items: {
            type: 'object',
            required: ['path', 'message'],
            properties: {
              path: {
                type: 'string',
                description:
                  'Dotted path to the field, or "(root)" when the body itself was wrong.',
              },
              message: { type: 'string' },
            },
          },
        },
        {
          type: 'object',
          description: 'QUOTA_EXCEEDED: the configured cap and the count that reached it (B-8).',
          required: ['limit', 'count'],
          properties: {
            limit: { type: 'integer' },
            count: { type: 'integer' },
          },
        },
        {
          type: 'object',
          description: 'ADDRESS_NOT_ALLOWED: the disallowed address a hostname resolved to (§5.1).',
          required: ['address'],
          properties: {
            address: { type: 'string' },
          },
        },
      ],
    },
  },
} as const;

/** A `$ref` to the one error shape, with a description of when it happens. */
function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

function jsonBody(ref: string) {
  return {
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
  };
}

const idParam = {
  name: 'id',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const, format: 'uuid' },
};

const cursorParam = {
  name: 'cursor',
  in: 'query' as const,
  required: false,
  description: 'Opaque: the `id` of the last row of the previous page.',
  schema: { type: 'string' as const, format: 'uuid' },
};

const limitParam = {
  name: 'limit',
  in: 'query' as const,
  required: false,
  description:
    'Defaults to 50. The effective maximum is deployment-configured ' +
    '(MAX_LIST_LIMIT), not the 1000 this schema structurally accepts -- a ' +
    'request over the configured cap returns that many rows, not an error.',
  schema: { type: 'integer' as const, minimum: 1, maximum: 1000, default: 50 },
};

const tagParam = {
  name: 'tag',
  in: 'query' as const,
  required: false,
  description:
    'B-5: "key:value", split on the first colon only. Matches services/endpoints ' +
    'carrying that exact tag; no match returns an empty list, not an error.',
  // Matches tagFilterSchema's own grammar: at least one non-colon character
  // (the key), then a colon, then anything at all (the value, which may
  // itself contain colons -- only the *first* one is the split point).
  schema: {
    type: 'string' as const,
    pattern: '^[^:]+:.*$',
    example: 'env:prod',
  },
};

/** Shared by every authenticated route. */
const authErrors = {
  '401': errorResponse('No session cookie, or one that is expired, revoked or unknown.'),
  '429': errorResponse('Too many requests from this address.'),
};

/**
 * `cfg` is only available when the document is built for a running server
 * (`docs.ts`, which knows the actual `COOKIE_SECURE`); `cli.ts` generates the
 * static file with no running config, so it falls back to the production
 * default — the same default `sessionCookieName` itself uses.
 */
export function buildOpenApiDocument(
  cfg?: Pick<AppConfig, 'COOKIE_SECURE'>,
): Record<string, unknown> {
  const cookieName = sessionCookieName(cfg ?? { COOKIE_SECURE: true });

  return {
    openapi: '3.0.3',
    info: {
      title: 'probeboard API',
      version: '0.1.0',
      description: [
        'Backend for probeboard, an API monitoring dashboard.',
        '',
        '**Authentication** is an opaque session token in an HttpOnly cookie, set by',
        '`POST /v1/auth/login` and cleared by logout. Script cannot read it, so a',
        'browser client sends credentials by making requests with `credentials:',
        '"include"` and never handles the token itself. There is no bearer scheme and',
        'no refresh token: the session is server-side state and is revocable.',
        '',
        'The cookie is named `__Host-pb_session` when it is marked Secure, and',
        '`pb_session` over plain HTTP in local development. Clients never need to read',
        'the name — the browser sends it — but tooling that inspects headers does.',
        '',
        '**Every failure** answers with the same JSON shape: a stable `code`, a',
        'human-readable `message`, and `details` only on validation failures.',
        'Branch on `code`.',
        '',
        'This document is generated from the zod schemas the server validates with',
        '(`npm run openapi`), so a request body it describes is one the server accepts.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    // Relative, so it resolves against whichever origin serves the document.
    // An absolute URL would send every "Try it out" on a staging deployment
    // to the visitor's own machine instead of the API that served the page.
    servers: [{ url: '/', description: 'The origin serving this document' }],
    tags: [
      { name: 'health', description: 'Liveness and readiness, served outside the version prefix.' },
      { name: 'auth', description: 'Accounts and sessions.' },
      { name: 'oauth', description: 'Sign in with Google or GitHub, and linked identities.' },
      { name: 'services', description: 'Monitored services: their origin, headers and tags.' },
      { name: 'endpoints', description: 'Monitored endpoints under a service.' },
    ],
    components: {
      schemas: {
        Error: errorSchema,
        RegisterRequest: schemaOf(registerSchema),
        LoginRequest: schemaOf(loginSchema),
        ChangePasswordRequest: schemaOf(changePasswordSchema),
        CurrentUser: {
          type: 'object',
          required: ['id', 'email', 'identities'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email', description: 'Normalised to lowercase.' },
            identities: { type: 'array', items: { $ref: '#/components/schemas/OAuthIdentity' } },
          },
        },
        Ok: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: ['ok'] } },
        },
        Readiness: {
          type: 'object',
          required: ['status', 'database'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            database: { type: 'string', enum: ['ok'] },
          },
        },
        OAuthLinkResponse: {
          type: 'object',
          required: ['redirectUrl'],
          properties: {
            redirectUrl: { type: 'string', format: 'uri' },
          },
        },
        OAuthIdentity: {
          type: 'object',
          required: ['provider', 'email', 'linkedAt'],
          properties: {
            provider: { type: 'string', enum: ['google', 'github'] },
            email: {
              type: 'string',
              format: 'email',
              nullable: true,
              description: 'Display text from the provider. Never the lookup key.',
            },
            linkedAt: { type: 'string', format: 'date-time' },
          },
        },
        // Hand-written, not schemaOf(createServiceSchema): z.toJSONSchema
        // does not encode a zod .refine(), so the generated form would mark
        // name/baseUrl/url all optional and let a generated client send a
        // body (e.g. {}) the server actually rejects.
        CreateServiceRequest: {
          description:
            'Exactly one of the two forms below. Explicit: {name, baseUrl}. ' +
            'Implicit (B-3): {url}, with name optional.',
          oneOf: [
            {
              type: 'object',
              required: ['name', 'baseUrl'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 200 },
                baseUrl: { type: 'string', minLength: 1 },
                headers: schemaOf(headerListSchema),
                tags: schemaOf(tagListSchema),
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1, maxLength: 200 },
                headers: schemaOf(headerListSchema),
                tags: schemaOf(tagListSchema),
              },
              additionalProperties: false,
            },
          ],
        },
        UpdateServiceRequest: schemaOf(updateServiceSchema),
        // A named component, not inlined at each `equals` field: the schema
        // is recursive (an object/array can itself hold json values), which
        // OpenAPI 3.0 can only express as a schema that refs itself by a
        // real path -- see inlineJsonValueRefs above.
        JsonValue: inlineJsonValueRefs(schemaOf(jsonValueSchema)) as Record<string, unknown>,
        CreateEndpointRequest: inlineJsonValueRefs(schemaOf(createEndpointSchema)) as Record<
          string,
          unknown
        >,
        UpdateEndpointRequest: inlineJsonValueRefs(schemaOf(updateEndpointSchema)) as Record<
          string,
          unknown
        >,
        Header: {
          type: 'object',
          required: ['name', 'isSecret'],
          description:
            'A secret header never carries `value` in any response -- write-only ' +
            '(docs/m2-plan.md §5.4). The only way to keep one unchanged on a PATCH is ' +
            '`{name, isSecret: true}` with no `value` key at all.',
          properties: {
            name: { type: 'string' },
            isSecret: { type: 'boolean' },
            value: { type: 'string', description: 'Absent when isSecret is true.' },
          },
        },
        Tag: {
          type: 'object',
          required: ['key', 'value'],
          properties: { key: { type: 'string' }, value: { type: 'string' } },
        },
        Service: {
          type: 'object',
          required: ['id', 'name', 'baseUrl', 'headers', 'tags', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            baseUrl: {
              type: 'string',
              format: 'uri',
              description: 'Origin only: scheme + host [+ port].',
            },
            headers: { type: 'array', items: { $ref: '#/components/schemas/Header' } },
            tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        CreateServiceResponse: {
          type: 'object',
          required: ['service'],
          properties: {
            service: { $ref: '#/components/schemas/Service' },
            endpointId: {
              type: 'string',
              format: 'uuid',
              description:
                'Only present for the implicit form (B-3, `url` in the request): the ' +
                'endpoint that was attached to an existing service, or created with it.',
            },
          },
        },
        StatusRange: {
          type: 'object',
          required: ['min', 'max'],
          properties: {
            min: { type: 'integer', minimum: 100, maximum: 599 },
            max: { type: 'integer', minimum: 100, maximum: 599 },
          },
        },
        Endpoint: {
          type: 'object',
          required: [
            'id',
            'serviceId',
            'method',
            'path',
            'intervalS',
            'timeoutMs',
            'expectedStatus',
            'latencyWarnMs',
            'failureThreshold',
            'successThreshold',
            'followRedirects',
            'maxRedirects',
            'assertions',
            'enabled',
            'headers',
            'effectiveHeaders',
            'tags',
            'createdAt',
            'updatedAt',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            serviceId: { type: 'string', format: 'uuid' },
            method: { type: 'string' },
            path: { type: 'string' },
            intervalS: {
              type: 'integer',
              description: 'One of the configured PROBE_ALLOWED_INTERVALS_S.',
            },
            timeoutMs: { type: 'integer' },
            expectedStatus: { type: 'array', items: { $ref: '#/components/schemas/StatusRange' } },
            latencyWarnMs: { type: 'integer', nullable: true },
            failureThreshold: { type: 'integer' },
            successThreshold: { type: 'integer' },
            followRedirects: { type: 'boolean' },
            maxRedirects: { type: 'integer' },
            assertions: {
              type: 'array',
              items: {},
              description:
                'Structured, versioned (architecture ADR-5). Opaque to M2; M3 is the first reader.',
            },
            enabled: { type: 'boolean', description: 'Pause/resume (FR-9). Inert until M4.' },
            headers: {
              type: 'array',
              items: { $ref: '#/components/schemas/Header' },
              description: "This endpoint's own headers only.",
            },
            effectiveHeaders: {
              type: 'array',
              items: { $ref: '#/components/schemas/Header' },
              description:
                '`{...serviceHeaders, ...endpointHeaders}` by name, case-insensitively, ' +
                'endpoint wins (B-4).',
            },
            tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: cookieName,
          description:
            'Opaque session token, HttpOnly. Set by login; sent automatically by the browser. ' +
            'Named `__Host-pb_session` when COOKIE_SECURE is on, `pb_session` when it is off ' +
            '(local development only) — this document names the one the serving deployment ' +
            'actually sets.',
        },
      },
    },
    paths: {
      [`/${LIVENESS_PATH}`]: {
        get: {
          tags: ['health'],
          operationId: 'getLiveness',
          summary: 'Is the process running',
          description:
            'Answers only "is this process alive". Stays 200 while the database is down, ' +
            'because restarting the process would not help. Outside the version prefix, so ' +
            'an orchestrator probe does not change when the API version does.',
          security: [],
          responses: {
            '200': {
              description: 'The process is running.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
          },
        },
      },
      [`/${READINESS_PATH}`]: {
        get: {
          tags: ['health'],
          operationId: 'getReadiness',
          summary: 'Can this instance serve traffic',
          description:
            'Fails when the database is unreachable, so a load balancer routes elsewhere.',
          security: [],
          responses: {
            '200': {
              description: 'Ready.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Readiness' } },
              },
            },
            '503': errorResponse('The database is not reachable. Code: `DATABASE_UNAVAILABLE`.'),
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/register`]: {
        post: {
          tags: ['auth'],
          operationId: 'register',
          summary: 'Create an account',
          description:
            'Always 204, whether or not the address was already taken, and issues no session ' +
            'either way. Both are deliberate: answering differently for a taken address ' +
            'would let anyone test which addresses are registered, and a duplicate cannot ' +
            'be given a session without logging in whoever already owns it. Log in ' +
            'afterwards.\n\n' +
            'The minimum password length is configuration, so a rejected password reports ' +
            'the running value in `details`.',
          security: [],
          requestBody: jsonBody('RegisterRequest'),
          responses: {
            '204': { description: 'Accepted. No body, and no session.' },
            '400': errorResponse('`VALIDATION_FAILED`, or `BAD_REQUEST` for malformed JSON.'),
            '413': errorResponse('Body larger than the configured limit (64 kB by default).'),
            '429': errorResponse('Too many attempts from this address.'),
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/login`]: {
        post: {
          tags: ['auth'],
          operationId: 'login',
          summary: 'Exchange credentials for a session',
          description:
            'On success sets the session cookie. The token is never in the body, so a client ' +
            'that logs responses cannot leak it.\n\n' +
            'A wrong password and an unregistered address produce the same response and take ' +
            'the same time, so neither can be used to discover which addresses have ' +
            'accounts.',
          security: [],
          requestBody: jsonBody('LoginRequest'),
          responses: {
            '200': {
              description: 'Signed in. The session is in the `Set-Cookie` header.',
              headers: {
                'Set-Cookie': {
                  description:
                    'e.g. `__Host-pb_session=pbs_…; Path=/; Expires=…; HttpOnly; Secure; SameSite=Lax`',
                  schema: { type: 'string' },
                },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            '400': errorResponse('`VALIDATION_FAILED`, or `BAD_REQUEST` for malformed JSON.'),
            '401': errorResponse(
              'Wrong password, or no such account. Identical either way: `INVALID_CREDENTIALS`.',
            ),
            '413': errorResponse('Body larger than the configured limit.'),
            '429': errorResponse(
              'Rate limited, by address or by account. `RATE_LIMITED`. Note that an account ' +
                'locked by repeated failures answers 429 even for the correct password.',
            ),
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/me`]: {
        get: {
          tags: ['auth'],
          operationId: 'getCurrentUser',
          summary: 'Who the session belongs to',
          description: 'How a client learns whether its cookie is still good.',
          responses: {
            '200': {
              description: 'The authenticated account.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CurrentUser' } },
              },
            },
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/password`]: {
        post: {
          tags: ['auth'],
          operationId: 'changePassword',
          summary: 'Change the password',
          description:
            'Revokes every **other** session for the account. The session making the change ' +
            'survives, so changing a password does not sign you out of the device you are ' +
            'holding.',
          requestBody: jsonBody('ChangePasswordRequest'),
          responses: {
            '204': { description: 'Changed. Other sessions are now revoked.' },
            '400': errorResponse(
              '`VALIDATION_FAILED`, including a new password below the minimum.',
            ),
            '401': errorResponse(
              'No valid session, or the current password was wrong. `UNAUTHENTICATED` or ' +
                '`INVALID_CREDENTIALS`.',
            ),
            '409': errorResponse(
              '`NO_PASSWORD_SET`: this account signs in through a provider and has no password ' +
                'to change.',
            ),
            '413': errorResponse('Body larger than the configured limit.'),
            '429': errorResponse('Too many attempts from this address.'),
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/logout`]: {
        post: {
          tags: ['auth'],
          operationId: 'logout',
          summary: 'Revoke this session',
          responses: {
            '204': {
              description: 'Revoked, and the cookie is cleared.',
              headers: {
                'Set-Cookie': {
                  description: 'The same cookie with an expiry in the past.',
                  schema: { type: 'string' },
                },
              },
            },
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/logout-all`]: {
        post: {
          tags: ['auth'],
          operationId: 'logoutAll',
          summary: 'Revoke every session for this account',
          description: 'Including the one making the request.',
          responses: {
            '204': {
              description: 'All revoked, and the cookie is cleared.',
              headers: {
                'Set-Cookie': {
                  description: 'The same cookie with an expiry in the past.',
                  schema: { type: 'string' },
                },
              },
            },
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/oauth/{provider}/start`]: {
        get: {
          tags: ['oauth'],
          operationId: 'oauthStart',
          summary: 'Begin sign-in with a provider',
          description:
            'A plain redirect, so the sign-in button needs no JavaScript and no CORS ' +
            'preflight. Sets a short-lived state cookie and writes a pending row; the ' +
            'browser comes back at `callback`.\n\n' +
            '`:provider` outside `google`/`github` answers 404, the same as one with no ' +
            'configured credentials -- a half-configured provider must not be ' +
            'distinguishable from one that does not exist.',
          security: [],
          parameters: [
            {
              name: 'provider',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['google', 'github'] },
            },
            {
              name: 'returnTo',
              in: 'query',
              required: false,
              description:
                'Path to return to after sign-in. Validated server-side; anything not a ' +
                'bare site-relative path falls back to `/` silently.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '302': {
              description:
                'To the provider, carrying a PKCE S256 challenge and `state`. Sets the ' +
                'state cookie.',
            },
            '404': errorResponse('Unknown or unconfigured provider.'),
            '429': errorResponse('Too many attempts from this address.'),
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/oauth/{provider}/callback`]: {
        get: {
          tags: ['oauth'],
          operationId: 'oauthCallback',
          summary: 'Provider redirects back here',
          description:
            'Always a redirect, never JSON: this is a browser navigation the provider ' +
            'sent. On a sign-in success, to the stored `returnTo` with a new session ' +
            'cookie -- any cookie already present is ignored and overwritten. A linking ' +
            'flow instead requires the session that started it to still be active, and ' +
            'answers `OAUTH_SESSION_REVOKED` if it was signed out in the meantime. On ' +
            'failure, to `/login?error=<code>` on `WEB_BASE_URL`, with a code from a ' +
            'fixed enumeration: `OAUTH_STATE_INVALID`, `OAUTH_ACCOUNT_EXISTS`, ' +
            '`OAUTH_NO_VERIFIED_EMAIL`, `OAUTH_PROVIDER_ERROR`, `OAUTH_IDENTITY_TAKEN`, ' +
            "`OAUTH_SESSION_REVOKED`. The provider's own error text is never rendered.",
          security: [],
          parameters: [
            {
              name: 'provider',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['google', 'github'] },
            },
          ],
          responses: {
            '302': {
              description: 'To `returnTo` on success, or `/login?error=<code>` on failure.',
              headers: {
                'Set-Cookie': {
                  description: 'The session cookie, only on success.',
                  schema: { type: 'string' },
                },
              },
            },
            '429': errorResponse('Too many attempts from this address.'),
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/oauth/{provider}/link`]: {
        post: {
          tags: ['oauth'],
          operationId: 'oauthLink',
          summary: 'Begin linking a provider to the signed-in account',
          description:
            'JSON rather than a redirect, since this is called from an authenticated page ' +
            'that already has a fetch client. The browser still has to follow ' +
            '`redirectUrl` itself for the provider leg.',
          parameters: [
            {
              name: 'provider',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['google', 'github'] },
            },
            {
              name: 'returnTo',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Sets the state cookie; follow `redirectUrl` to continue.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/OAuthLinkResponse' } },
              },
            },
            '404': errorResponse('Unknown or unconfigured provider.'),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/oauth/{provider}`]: {
        delete: {
          tags: ['oauth'],
          operationId: 'oauthUnlink',
          summary: 'Remove a linked provider identity',
          parameters: [
            {
              name: 'provider',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['google', 'github'] },
            },
          ],
          responses: {
            '204': { description: 'Removed.' },
            '404': errorResponse('No identity for this provider on this account.'),
            '409': errorResponse(
              '`LAST_CREDENTIAL`: removing this would leave the account with no way to ' +
                'sign in.',
            ),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/auth/identities`]: {
        get: {
          tags: ['oauth'],
          operationId: 'listIdentities',
          summary: 'Providers linked to the signed-in account',
          responses: {
            '200': {
              description: 'Every linked identity.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/OAuthIdentity' } },
                },
              },
            },
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/services`]: {
        post: {
          tags: ['services'],
          operationId: 'createService',
          summary: 'Register a service, explicitly or from a URL (B-3)',
          description:
            'Two forms, discriminated by which of `baseUrl`/`url` is present. Explicit: ' +
            '`{name, baseUrl}` creates a service at that origin. Implicit (B-3): `{url}` ' +
            "finds-or-creates a service at the URL's origin and attaches one endpoint at " +
            'its path, in one transaction -- "a service with exactly one endpoint is the ' +
            'degenerate case."\n\n' +
            'The URL is validated by the SSRF guard before anything is stored (§5.1): ' +
            'scheme, credentials, port, DNS resolution, then every resolved address ' +
            'classified against a private/loopback/link-local/metadata denylist. Not a ' +
            'complete defense against DNS rebinding -- see docs/m2-plan.md §6.',
          requestBody: jsonBody('CreateServiceRequest'),
          responses: {
            '201': {
              description: 'Created (or attached to, in the implicit form).',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CreateServiceResponse' },
                },
              },
            },
            '400': errorResponse(
              '`VALIDATION_FAILED`, or one of the SSRF codes: `SCHEME_NOT_ALLOWED`, ' +
                '`CREDENTIALS_IN_URL`, `PORT_NOT_ALLOWED`, `URL_UNRESOLVABLE`, ' +
                '`ADDRESS_NOT_ALLOWED`; or `HEADER_NOT_ALLOWED`/`HEADER_INVALID`.',
            ),
            '409': errorResponse(
              '`CONFLICT`: a service already exists at this base URL (explicit form only). ' +
                '`QUOTA_EXCEEDED`: the endpoint quota is reached (implicit form only).',
            ),
            ...authErrors,
          },
        },
        get: {
          tags: ['services'],
          operationId: 'listServices',
          summary: 'List services owned by the signed-in account',
          parameters: [cursorParam, limitParam, tagParam],
          responses: {
            '200': {
              description: 'One page, oldest id first.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Service' } },
                },
              },
            },
            '400': errorResponse('`VALIDATION_FAILED`: a malformed cursor, limit, or tag filter.'),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/services/{id}`]: {
        get: {
          tags: ['services'],
          operationId: 'getService',
          summary: 'Fetch a service',
          parameters: [idParam],
          responses: {
            '200': {
              description: 'The service.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Service' } } },
            },
            '404': errorResponse('Not found, or it belongs to someone else -- indistinguishable.'),
            ...authErrors,
          },
        },
        patch: {
          tags: ['services'],
          operationId: 'updateService',
          summary: 'Update a service',
          description:
            'Every field optional; only what is present is changed. `headers`/`tags`, if ' +
            'present, fully replace the existing set (docs/m2-plan.md §5.4) -- a secret ' +
            'entry with no `value` keeps its current ciphertext. `baseUrl`, if present, is ' +
            're-validated by the SSRF guard even if unchanged (D10).',
          parameters: [idParam],
          requestBody: jsonBody('UpdateServiceRequest'),
          responses: {
            '200': {
              description: 'Updated.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Service' } } },
            },
            '400': errorResponse(
              '`VALIDATION_FAILED`, an SSRF code, or `HEADER_NOT_ALLOWED`/`HEADER_INVALID`.',
            ),
            '404': errorResponse('Not found, or owned by someone else.'),
            '409': errorResponse('`CONFLICT`: another service already uses this base URL.'),
            ...authErrors,
          },
        },
        delete: {
          tags: ['services'],
          operationId: 'deleteService',
          summary: 'Delete a service',
          description:
            'Cascades to its endpoints, headers and tags. Unconditional hard delete (D9).',
          parameters: [idParam],
          responses: {
            '204': { description: 'Deleted.' },
            '404': errorResponse('Not found, or owned by someone else.'),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/services/{id}/endpoints`]: {
        get: {
          tags: ['endpoints'],
          operationId: 'listServiceEndpoints',
          summary: "A service's endpoints",
          parameters: [idParam, cursorParam, limitParam, tagParam],
          responses: {
            '200': {
              description: 'One page of endpoints under this service, oldest id first.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Endpoint' } },
                },
              },
            },
            '400': errorResponse('`VALIDATION_FAILED`: a malformed cursor, limit, or tag filter.'),
            '404': errorResponse('Not found, or owned by someone else.'),
            ...authErrors,
          },
        },
        post: {
          tags: ['endpoints'],
          operationId: 'createEndpoint',
          summary: 'Add an endpoint to a service',
          description:
            'Quota-checked (§5.3: locks the user row, counts, then inserts, inside one ' +
            'transaction -- closes the check-then-act race a separate COUNT would leave ' +
            'open). The joined base URL + path is re-validated by the SSRF guard (D10).',
          parameters: [idParam],
          requestBody: jsonBody('CreateEndpointRequest'),
          responses: {
            '201': {
              description: 'Created.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Endpoint' } },
              },
            },
            '400': errorResponse(
              '`VALIDATION_FAILED`, an SSRF code, or `HEADER_NOT_ALLOWED`/`HEADER_INVALID`.',
            ),
            '404': errorResponse('Service not found, or owned by someone else.'),
            '409': errorResponse(
              '`CONFLICT`: duplicate method+path on this service. `QUOTA_EXCEEDED`: the ' +
                'endpoint quota is reached.',
            ),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/endpoints`]: {
        get: {
          tags: ['endpoints'],
          operationId: 'listEndpoints',
          summary: 'List every endpoint owned by the signed-in account, across services',
          parameters: [cursorParam, limitParam, tagParam],
          responses: {
            '200': {
              description: 'One page, oldest id first.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Endpoint' } },
                },
              },
            },
            '400': errorResponse('`VALIDATION_FAILED`: a malformed cursor, limit, or tag filter.'),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/endpoints/{id}`]: {
        get: {
          tags: ['endpoints'],
          operationId: 'getEndpoint',
          summary: 'Fetch an endpoint',
          parameters: [idParam],
          responses: {
            '200': {
              description: 'The endpoint, with its own headers and the merged effective set.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Endpoint' } },
              },
            },
            '404': errorResponse('Not found, or owned by someone else.'),
            ...authErrors,
          },
        },
        patch: {
          tags: ['endpoints'],
          operationId: 'updateEndpoint',
          summary: 'Update an endpoint',
          description:
            'Every field optional. The joined base URL + path is re-validated by the SSRF ' +
            'guard unconditionally, even when neither changed (D10).',
          parameters: [idParam],
          requestBody: jsonBody('UpdateEndpointRequest'),
          responses: {
            '200': {
              description: 'Updated.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Endpoint' } },
              },
            },
            '400': errorResponse(
              '`VALIDATION_FAILED`, an SSRF code, or `HEADER_NOT_ALLOWED`/`HEADER_INVALID`.',
            ),
            '404': errorResponse('Not found, or owned by someone else.'),
            '409': errorResponse(
              '`CONFLICT`: another endpoint on this service uses this method+path.',
            ),
            ...authErrors,
          },
        },
        delete: {
          tags: ['endpoints'],
          operationId: 'deleteEndpoint',
          summary: 'Delete an endpoint',
          parameters: [idParam],
          responses: {
            '204': { description: 'Deleted.' },
            '404': errorResponse('Not found, or owned by someone else.'),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/endpoints/{id}/pause`]: {
        post: {
          tags: ['endpoints'],
          operationId: 'pauseEndpoint',
          summary: 'Set enabled = false',
          description: "Inert until M4's scheduler reads `enabled` (FR-9).",
          parameters: [idParam],
          responses: {
            '200': {
              description: 'Paused.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Endpoint' } },
              },
            },
            '404': errorResponse('Not found, or owned by someone else.'),
            ...authErrors,
          },
        },
      },
      [`/${API_VERSION_PREFIX}/endpoints/{id}/resume`]: {
        post: {
          tags: ['endpoints'],
          operationId: 'resumeEndpoint',
          summary: 'Set enabled = true',
          parameters: [idParam],
          responses: {
            '200': {
              description: 'Resumed.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Endpoint' } },
              },
            },
            '404': errorResponse('Not found, or owned by someone else.'),
            ...authErrors,
          },
        },
      },
    },
    security: [{ sessionCookie: [] }],
  };
}
