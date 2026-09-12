import { Module } from '@nestjs/common';
import { UsersModule } from '../../core/users/users.module.js';
import { AuthController } from './http/auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthMaintenanceService } from './maintenance/auth-maintenance.service.js';
import { PasswordService } from './passwords/password.service.js';
import { AuthAttemptRepository } from './rate-limiting/rate-limit.repository.js';
import { AuthRateLimitService } from './rate-limiting/rate-limit.service.js';
import { SessionGuard } from './sessions/session.guard.js';
import { SessionRepository } from './sessions/session.repository.js';

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
  ],
  exports: [AuthService, SessionGuard, PasswordService, SessionRepository, AuthRateLimitService],
})
export class AuthModule {}
