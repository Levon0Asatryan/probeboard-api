import type { Header, Service, Tag } from '../../../core/db/types.js';
import { type HeaderDto, toHeaderDto } from '../services/header-storage.service.js';
import { toTagDto, type TagDto } from './tag.dto.js';

export interface ServiceDto {
  id: string;
  name: string;
  baseUrl: string;
  headers: HeaderDto[];
  tags: TagDto[];
  createdAt: string;
  updatedAt: string;
}

export function toServiceDto(service: Service, headers: Header[], tags: Tag[]): ServiceDto {
  return {
    id: service.id,
    name: service.name,
    baseUrl: service.base_url,
    headers: headers.map(toHeaderDto),
    tags: tags.map(toTagDto),
    createdAt: service.created_at.toISOString(),
    updatedAt: service.updated_at.toISOString(),
  };
}
