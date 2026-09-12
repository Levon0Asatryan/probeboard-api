import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AppError } from '../../../core/errors/app-error.js';
import { describeError } from '../../../core/errors/describe.js';
import { SESSION_COOKIE } from '../utils/session-cookie.js';
import { hashToken, looksLikeToken } from '../utils/session-token.js';
import { SessionRepository } from '../repositories/session.repository.js';

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
  constructor(
    private readonly sessions: SessionRepository,
    @InjectPinoLogger(SessionGuard.name) private readonly logger: PinoLogger,
  ) {}

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
    //
    // Not awaited, because a request must not wait on telemetry — but the
    // rejection is handled rather than discarded: an unhandled rejection
    // terminates the process in Node 22, so a database restart between the
    // lookup and this write would take the api down.
    this.sessions.touch(session.sessionId).catch((err: unknown) => {
      this.logger.warn({ cause: describeError(err) }, 'could not record session activity');
    });

    return true;
  }
}
