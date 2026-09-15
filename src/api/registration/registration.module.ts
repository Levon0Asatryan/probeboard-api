import { Module } from '@nestjs/common';
import { UsersModule } from '../../core/users/users.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EndpointRepository } from '../../core/registration/repositories/endpoint.repository.js';
import { HeaderRepository } from '../../core/registration/repositories/header.repository.js';
import { ServiceRepository } from '../../core/registration/repositories/service.repository.js';
import { TagRepository } from '../../core/registration/repositories/tag.repository.js';
import { EndpointsController } from './endpoints.controller.js';
import { ServicesController } from './services.controller.js';
import { EndpointsService } from './services/endpoints.service.js';
import { HeaderStorageService } from './services/header-storage.service.js';
import { HeaderValidationService } from './services/header-validation.service.js';
import { ServicesService } from './services/services.service.js';

/**
 * Registration (M2): services, endpoints, their headers and tags.
 *
 * One module, not two, despite `services/` and `endpoints/` looking like
 * separate resources (D8, docs/m2-plan.md §4) -- they share one SSRF guard,
 * one quota, one header/tag model, and B-3's implicit-creation flow spans
 * both in a single transaction, so they cannot be deleted independently.
 */
@Module({
  imports: [UsersModule, AuthModule],
  controllers: [ServicesController, EndpointsController],
  providers: [
    ServiceRepository,
    EndpointRepository,
    HeaderRepository,
    TagRepository,
    HeaderValidationService,
    HeaderStorageService,
    ServicesService,
    EndpointsService,
  ],
})
export class RegistrationModule {}
