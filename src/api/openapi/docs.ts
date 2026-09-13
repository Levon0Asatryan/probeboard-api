import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from '../../core/config/schema.js';
import { buildOpenApiDocument } from './document.js';

/** Where the browsable documentation is served, when it is served at all. */
export const DOCS_PATH = 'docs';

/**
 * Serves Swagger UI over the same document `openapi.yaml` is generated from,
 * so the page and the file can never disagree.
 *
 * Off unless `API_DOCS_ENABLED` says otherwise, like every other switch in
 * this service that widens what is reachable. Swagger UI is a large piece of
 * third-party browser code with its own history of cross-site scripting
 * advisories, and it exists for the people building against this API rather
 * than for the people using it — so it belongs on a developer's machine and in
 * staging, not on by default in front of the internet. `docker compose` turns
 * it on, which is where it is wanted.
 *
 * Registered with the document built in-process rather than by scanning
 * decorators: the schemas are zod, which `@nestjs/swagger` cannot read, and a
 * second source of truth is the thing this whole file is avoiding.
 *
 * Returns whether it mounted, so the caller can say so in the boot log and a
 * test can assert the switch works in both directions.
 */
export function setupApiDocs(app: INestApplication, cfg: AppConfig): boolean {
  if (!cfg.API_DOCS_ENABLED) return false;

  SwaggerModule.setup(DOCS_PATH, app, buildOpenApiDocument(cfg) as unknown as OpenAPIObject, {
    customSiteTitle: 'probeboard API',
    swaggerOptions: {
      // The session is an HttpOnly cookie, so "Try it out" has to send
      // credentials or every authenticated call from this page answers 401 and
      // looks like a broken API.
      withCredentials: true,
      persistAuthorization: true,
      // Collapsed by default: eleven operations fit on one screen that way,
      // and the first thing a reader wants is the shape of the surface.
      docExpansion: 'list',
      defaultModelsExpandDepth: 2,
    },
  });

  return true;
}
