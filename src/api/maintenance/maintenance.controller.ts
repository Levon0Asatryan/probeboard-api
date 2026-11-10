import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { SessionGuard, type RequestUser } from '../auth/guards/session.guard.js';
import { zodBody, zodQuery } from '../common/pipes/zod-validation.pipe.js';
import {
  createMaintenanceWindowSchema,
  maintenanceWindowQuerySchema,
  updateMaintenanceWindowSchema,
  type CreateMaintenanceWindowRequest,
  type MaintenanceWindowQuery,
  type UpdateMaintenanceWindowRequest,
} from './dto/maintenance-window.dto.js';
import type { MaintenanceWindowDto } from './dto/maintenance-window-response.dto.js';
import { MaintenanceService } from './maintenance.service.js';

/** One-off maintenance windows on a service or one endpoint (docs/m6-plan.md §3.7, §3.10). */
@Controller('maintenance-windows')
@UseGuards(SessionGuard)
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(zodBody(createMaintenanceWindowSchema)) body: CreateMaintenanceWindowRequest,
  ): Promise<MaintenanceWindowDto> {
    return this.maintenance.create(user.id, body);
  }

  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query(zodQuery(maintenanceWindowQuerySchema)) query: MaintenanceWindowQuery,
  ): Promise<MaintenanceWindowDto[]> {
    return this.maintenance.list(user.id, query);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MaintenanceWindowDto> {
    return this.maintenance.get(user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateMaintenanceWindowSchema)) body: UpdateMaintenanceWindowRequest,
  ): Promise<MaintenanceWindowDto> {
    return this.maintenance.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.maintenance.delete(user.id, id);
  }
}
