import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, ConfigModule } from '../core/config/config.module.js';
import type { AppConfig } from '../core/config/schema.js';
import { DbModule } from '../core/db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { loggerOptions } from '../core/logging/index.js';
import { ErrorFilter } from './common/filters/error.filter.js';
import { HealthModule } from './health/health.module.js';
import { RegistrationModule } from './registration/registration.module.js';

/** HTTP API. Never probes — that is the worker's job (docs §7.1). */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => loggerOptions('api', cfg),
    }),
    DbModule,
    AuthModule,
    HealthModule,
    RegistrationModule,
  ],
  providers: [ErrorFilter],
})
export class AppModule {}
