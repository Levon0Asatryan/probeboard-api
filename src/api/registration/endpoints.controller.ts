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
import { updateEndpointSchema, type UpdateEndpointRequest } from './dto/update-endpoint.dto.js';
import { listQuerySchema, type ListQuery } from './dto/list-query.dto.js';
import type { EndpointDto } from './dto/endpoint-response.dto.js';
import { EndpointsService } from './services/endpoints.service.js';

@Controller('endpoints')
@UseGuards(SessionGuard)
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query(zodQuery(listQuerySchema)) query: ListQuery,
  ): Promise<EndpointDto[]> {
    return this.endpoints.list(user.id, query);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EndpointDto> {
    return this.endpoints.get(user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateEndpointSchema)) body: UpdateEndpointRequest,
  ): Promise<EndpointDto> {
    return this.endpoints.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.endpoints.delete(user.id, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EndpointDto> {
    return this.endpoints.setEnabled(user.id, id, false);
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EndpointDto> {
    return this.endpoints.setEnabled(user.id, id, true);
  }
}
