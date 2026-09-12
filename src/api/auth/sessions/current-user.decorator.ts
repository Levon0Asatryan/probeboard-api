import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, RequestUser } from '../sessions/session.guard.js';

/**
 * The authenticated user, as attached by SessionGuard.
 *
 * Throws rather than returning undefined if the guard did not run: a handler
 * reading an absent user would otherwise treat the request as belonging to
 * nobody and could act unscoped, which is exactly what A-4 forbids.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) {
      throw new Error('CurrentUser used on a route that is not behind SessionGuard');
    }
    return req.user;
  },
);
