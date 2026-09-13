import { Module } from '@nestjs/common';
import { UsersModule } from '../../core/users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthMaintenanceService } from './services/auth-maintenance.service.js';
import { PasswordService } from './services/password.service.js';
import { AuthAttemptRepository } from './repositories/auth-attempt.repository.js';
import { AuthRateLimitService } from './services/rate-limit.service.js';
import { SessionGuard } from './guards/session.guard.js';
import { SessionRepository } from './repositories/session.repository.js';
import { OAuthAuthorizationRepository } from './repositories/oauth-authorization.repository.js';
import { OAuthIdentityRepository } from './repositories/oauth-identity.repository.js';

/**
 * Authentication. Lives in `api` because the worker never authenticates a
 * user; the user *repository* is in `core` because M7's notifier reads an
 * address from the worker to send an alert.
 */
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionGuard,
    PasswordService,
    SessionRepository,
    AuthAttemptRepository,
    AuthRateLimitService,
    AuthMaintenanceService,
    OAuthIdentityRepository,
    OAuthAuthorizationRepository,
  ],
  exports: [
    AuthService,
    SessionGuard,
    PasswordService,
    SessionRepository,
    AuthRateLimitService,
    OAuthIdentityRepository,
    OAuthAuthorizationRepository,
  ],
})
export class AuthModule {}
