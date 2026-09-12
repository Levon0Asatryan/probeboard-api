import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CurrentUser } from '../sessions/current-user.decorator.js';
import type { RequestUser } from '../sessions/session.guard.js';

/**
 * Nest wraps a param decorator, so the factory is reached through the
 * decorator's metadata rather than called directly.
 */
function factoryOf(decorator: unknown): (data: unknown, ctx: ExecutionContext) => RequestUser {
  const target = (decorator as () => ParameterDecorator)();
  const holder = { method(_value: unknown) {} };
  target(holder, 'method', 0);

  const metadata = Reflect.getMetadata(
    '__routeArguments__',
    holder.constructor,
    'method',
  ) as Record<string, { factory: (d: unknown, c: ExecutionContext) => RequestUser }>;

  return Object.values(metadata)[0].factory;
}

const context = (user?: RequestUser) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('CurrentUser', () => {
  const factory = factoryOf(CurrentUser);

  it('returns the user the guard attached', () => {
    const user: RequestUser = { id: 'u1', email: 'alice@example.com', sessionId: 's1' };
    expect(factory(undefined, context(user))).toEqual(user);
  });

  it('throws when the guard did not run', () => {
    // Returning undefined would let a handler treat the request as belonging
    // to nobody and act unscoped, which is what A-4 forbids. This branch can
    // never be reached over HTTP, which is exactly why it needs a test.
    expect(() => factory(undefined, context())).toThrow(/not behind SessionGuard/);
  });
});
