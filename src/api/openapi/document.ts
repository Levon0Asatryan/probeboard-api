import { z, type ZodType } from 'zod';
import { API_VERSION_PREFIX } from '../bootstrap.js';
import { changePasswordSchema } from '../auth/dto/change-password.dto.js';
import { loginSchema } from '../auth/dto/login.dto.js';
import { registerSchema } from '../auth/dto/register.dto.js';
import { sessionCookieName } from '../auth/utils/session-cookie.js';
import { LIVENESS_PATH, READINESS_PATH } from '../health/constants.js';
import type { AppConfig } from '../../core/config/schema.js';

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
      type: 'array',
      description: 'Present only on VALIDATION_FAILED: one entry per rejected field.',
      items: {
        type: 'object',
        required: ['path', 'message'],
        properties: {
          path: {
            type: 'string',
            description: 'Dotted path to the field, or "(root)" when the body itself was wrong.',
          },
          message: { type: 'string' },
        },
      },
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
    },
    security: [{ sessionCookie: [] }],
  };
}
