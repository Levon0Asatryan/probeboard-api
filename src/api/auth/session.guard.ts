import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../core/errors/app-error.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { hashToken, looksLikeToken } from './session-token.js';
import { SessionRepository } from './session.repository.js';

export class UnauthenticatedError extends AppError {
  constructor() {
    super('UNAUTHENTICATED', 'authentication required', 401);
  }
}

export interface RequestUser {
  id: string;
  email: string;
  sessionId: string;
}

/** The authenticated user, attached by the guard. */
export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
    if (typeof token !== 'string') throw new UnauthenticatedError();

    // Shape is checked before the database is touched, so a junk cookie costs
    // nothing.
    if (!looksLikeToken(token)) throw new UnauthenticatedError();

    // findActive applies expiry and revocation in the query, so there is no
    // path where a caller forgets to check them.
    const session = await this.sessions.findActive(hashToken(token));
    if (!session) throw new UnauthenticatedError();

    req.user = { id: session.userId, email: session.email, sessionId: session.sessionId };

    // Recorded for operators, and deliberately does not extend the session.
    void this.sessions.touch(session.sessionId);

    return true;
  }
}
