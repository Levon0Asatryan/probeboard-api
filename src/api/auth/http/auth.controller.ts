import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../../../core/config/config.module.js';
import type { AppConfig } from '../../../core/config/schema.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type RegisterRequest,
} from '../http/auth.schemas.js';
import { AuthService } from '../auth.service.js';
import { clientIp } from '../http/client-ip.js';
import { CurrentUser } from '../http/current-user.decorator.js';
import { SessionRepository } from '../sessions/session.repository.js';
import { SessionGuard, type RequestUser } from '../http/session.guard.js';
import {
  clearSessionCookieOptions,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../http/session-cookie.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly auth: AuthService,
    private readonly sessions: SessionRepository,
  ) {}

  /**
   * Registers an account.
   *
   * Always 204, whether or not the address was already taken, and issues no
   * session either way (A-1). Auto-login would make the two cases
   * distinguishable: a duplicate cannot be given a session without logging in
   * whoever owns the address, and withholding one is observable.
   */
  @Post('register')
  @HttpCode(204)
  async register(
    @Req() req: Request,
    @Body(zodBody(registerSchema)) body: RegisterRequest,
  ): Promise<void> {
    await this.auth.register(body.email, body.password, clientIp(req));
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(zodBody(loginSchema)) body: LoginRequest,
  ): Promise<{ status: 'ok' }> {
    const session = await this.auth.login(body.email, body.password, clientIp(req));

    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(this.cfg, session.expiresAt));
    return { status: 'ok' };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revoke(user.sessionId);
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(this.cfg));
  }

  /** Revokes every session, including this one. */
  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logoutAll(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revokeAllForUser(user.id);
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(this.cfg));
  }

  /** How a client learns whether its cookie is still good. */
  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: RequestUser): { id: string; email: string } {
    return { id: user.id, email: user.email };
  }

  /** Changes the password and revokes every other session (A-5). */
  @Post('password')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async changePassword(
    @Req() req: Request,
    @CurrentUser() user: RequestUser,
    @Body(zodBody(changePasswordSchema)) body: ChangePasswordRequest,
  ): Promise<void> {
    await this.auth.changePassword(
      user.id,
      user.sessionId,
      body.currentPassword,
      body.newPassword,
      clientIp(req),
    );
  }
}
