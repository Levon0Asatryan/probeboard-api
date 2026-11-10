import { Module } from '@nestjs/common';
import { EndpointRepository } from '../../core/registration/repositories/endpoint.repository.js';
import { ServiceRepository } from '../../core/registration/repositories/service.repository.js';
import { UsersModule } from '../../core/users/users.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { MaintenanceWindowRepository } from './repositories/maintenance-window.repository.js';

/** Declaring maintenance windows (M6). The worker reads them when it writes each result. */
@Module({
  imports: [UsersModule, AuthModule],
  controllers: [MaintenanceController],
  providers: [
    MaintenanceWindowRepository,
    MaintenanceService,
    ServiceRepository,
    EndpointRepository,
  ],
})
export class MaintenanceModule {}
