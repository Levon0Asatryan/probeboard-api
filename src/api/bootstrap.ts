import { type INestApplication, NotFoundException } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../core/config/index.js';
import { toErrorResponse } from '../core/errors/http-mapping.js';
import { ErrorFilter } from './common/filters/error.filter.js';
import { HEALTH_PATHS } from './health/constants.js';

export const API_VERSION_PREFIX = 'v1';

/**
 * Paths served outside the version prefix, because an orchestrator's probe
 * should not have to track API versions.
 *
 * Only explicit paths belong here. Nest matches every `exclude` entry against
 * every discovered route, so a wildcard would exclude the whole API from the
 * prefix rather than one controller -- which is exactly what it did, serving
 * `/monitors` instead of `/v1/monitors`.
 */
export const UNVERSIONED_PATHS = HEALTH_PATHS;

/**
 * Applies every cross-cutting concern to the application.
 *
 * Separate from main.ts so the configuration is a value that can be inspected
 * and asserted on, rather than statements buried in a bootstrap function.
 */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): INestApplication {
  // Adding a version prefix once clients exist is a breaking change, so it
  // goes in before the first one.
  app.setGlobalPrefix(API_VERSION_PREFIX, { exclude: UNVERSIONED_PATHS });

  // One response shape for every failure, with no internal detail in any.
  app.useGlobalFilters(app.get(ErrorFilter));

  // A request body has no legitimate reason to be large here. Rejecting early
  // keeps a hostile payload from reaching a parser.
  app.useBodyParser('json', { limit: cfg.API_BODY_LIMIT });

  // The session arrives in a cookie, so it has to be parsed before any guard
  // can read it.
  app.use(cookieParser());

  // Express announces itself on every response by default. It is only a hint,
  // but it is a free one: it names the framework to fingerprint and narrows
  // which published vulnerabilities are worth trying. Nothing legitimate reads
  // it.
  app.disable('x-powered-by');

  // Whether X-Forwarded-For may be believed. Off unless a deployment opts in:
  // the per-IP rate limit keys on the client address, and trusting a header
  // any client can set would let an attacker present a fresh address per
  // request and bypass the limit entirely.
  app.set('trust proxy', cfg.TRUST_PROXY);

  // Closes the module tree on SIGTERM, which releases the database pool.
  app.enableShutdownHooks();

  return app;
}

/**
 * Answers every request no route matched, with the same JSON shape as any
 * other failure. Without it Express replies with its own HTML error page, so a
 * client that mistypes a path receives markup from a JSON API.
 *
 * This is Express middleware rather than a controller because a controller
 * would have to live either inside the version prefix, leaving unversioned
 * paths uncovered, or be excluded from it by a wildcard that also excludes
 * every real route. Middleware registered after `init()` sits behind Nest's
 * router and sees only what the router did not match.
 *
 * Since `@nestjs/platform-express` 12.0.2 the router answers an unmatched path
 * *inside* its own scope itself, by raising `NotFoundException` through the
 * global exception filter -- so this middleware now only ever sees paths the
 * router never claimed, which with a global prefix means everything outside
 * it. Both paths must answer the same thing, so this maps the same exception
 * Nest raises rather than a message of its own: a client that mistypes
 * `/v1/montiors` and one that mistypes `/montiors` get identical JSON.
 */
export async function registerNotFoundFallback(app: NestExpressApplication): Promise<void> {
  // init() mounts Nest's router; anything registered after it runs later.
  await app.init();

  const { status, body } = toErrorResponse(new NotFoundException());

  app.use((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(status).json(body);
  });
}
