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
import { zodBody, zodQuery } from '../common/pipes/zod-validation.pipe.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { SessionGuard, type RequestUser } from '../auth/guards/session.guard.js';
import { createServiceSchema, type CreateServiceRequest } from './dto/create-service.dto.js';
import { updateServiceSchema, type UpdateServiceRequest } from './dto/update-service.dto.js';
import { listQuerySchema, type ListQuery } from './dto/list-query.dto.js';
import { ServicesService, type CreateServiceResult } from './services/services.service.js';
import type { EndpointDto } from './dto/endpoint-response.dto.js';
import type { ServiceDto } from './dto/service-response.dto.js';
import { EndpointsService } from './services/endpoints.service.js';
import { createEndpointSchema, type CreateEndpointRequest } from './dto/create-endpoint.dto.js';

@Controller('services')
@UseGuards(SessionGuard)
export class ServicesController {
  constructor(
    private readonly services: ServicesService,
    private readonly endpoints: EndpointsService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: RequestUser,
    @Body(zodBody(createServiceSchema)) body: CreateServiceRequest,
  ): Promise<CreateServiceResult> {
    return this.services.create(user.id, body);
  }

  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query(zodQuery(listQuerySchema)) query: ListQuery,
  ): Promise<ServiceDto[]> {
    return this.services.list(user.id, query);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ServiceDto> {
    return this.services.get(user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateServiceSchema)) body: UpdateServiceRequest,
  ): Promise<ServiceDto> {
    return this.services.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.services.delete(user.id, id);
  }

  @Get(':id/endpoints')
  async listEndpoints(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodQuery(listQuerySchema)) query: ListQuery,
  ): Promise<EndpointDto[]> {
    return this.endpoints.listForService(user.id, id, query);
  }

  @Post(':id/endpoints')
  async createEndpoint(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(createEndpointSchema)) body: CreateEndpointRequest,
  ): Promise<EndpointDto> {
    return this.endpoints.createForService(user.id, id, body);
  }
}
