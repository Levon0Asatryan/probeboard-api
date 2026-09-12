import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../http/session-cookie.js';
import { generateToken } from '../sessions/session-token.js';
import { SessionGuard, UnauthenticatedError } from '../http/session.guard.js';
import type { SessionRepository } from '../sessions/session.repository.js';

const active = {
  sessionId: 's1',
  userId: 'u1',
  email: 'alice@example.com',
  expiresAt: new Date(Date.now() + 86_400_000),
};

function make(options: { found?: boolean; touch?: () => Promise<void> } = {}) {
  const sessions = {
    findActive: vi.fn().mockResolvedValue(options.found === false ? undefined : active),
    touch: vi.fn(options.touch ?? (() => Promise.resolve())),
  } as unknown as SessionRepository;
  const logger = { warn: vi.fn(), error: vi.fn() };

  return { guard: new SessionGuard(sessions, logger as never), sessions, logger };
}

const context = (cookies?: Record<string, unknown>) => {
  const req: Record<string, unknown> = { cookies };
  return {
    req,
    ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext,
  };
};

describe('SessionGuard', () => {
  it('attaches the user for a live session', async () => {
    const { guard } = make();
    const { req, ctx } = context({ [SESSION_COOKIE]: generateToken() });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'u1', email: 'alice@example.com', sessionId: 's1' });
  });

  it('refuses when there is no cookie at all', async () => {
    const { guard } = make();
    await expect(guard.canActivate(context().ctx)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('refuses a malformed token without touching the database', async () => {
    // A junk cookie must cost nothing.
    const { guard, sessions } = make();
    await expect(
      guard.canActivate(context({ [SESSION_COOKIE]: 'nonsense' }).ctx),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(sessions.findActive).not.toHaveBeenCalled();
  });

  it('refuses a well-formed token with no live session', async () => {
    const { guard } = make({ found: false });
    await expect(
      guard.canActivate(context({ [SESSION_COOKIE]: generateToken() }).ctx),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('does not fail the request when recording activity fails', async () => {
    // touch() is telemetry. A database blip between the lookup and the write
    // must not turn an authenticated request into an error.
    const { guard, logger } = make({ touch: () => Promise.reject(new Error('connection lost')) });

    await expect(
      guard.canActivate(context({ [SESSION_COOKIE]: generateToken() }).ctx),
    ).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledOnce();
    });
    expect(logger.warn.mock.calls[0]?.[0].cause).toContain('connection lost');
  });

  it('leaves no unhandled rejection behind when the touch fails', async () => {
    // An unhandled rejection terminates the process in Node 22, so a discarded
    // promise here would let a database restart take the api down.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const { guard } = make({ touch: () => Promise.reject(new Error('connection lost')) });
    await guard.canActivate(context({ [SESSION_COOKIE]: generateToken() }).ctx);

    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
  });
});
