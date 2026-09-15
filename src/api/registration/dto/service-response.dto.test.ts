import { describe, expect, it } from 'vitest';
import { toServiceDto } from './service-response.dto.js';
import type { Header, Service, Tag } from '../../../core/db/types.js';

const service: Service = {
  id: 'svc-1',
  user_id: 'user-1',
  name: 'My API',
  base_url: 'https://example.com',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
};

describe('toServiceDto', () => {
  it('maps id, name, baseUrl and timestamps', () => {
    const dto = toServiceDto(service, [], []);
    expect(dto).toMatchObject({
      id: 'svc-1',
      name: 'My API',
      baseUrl: 'https://example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('maps headers through toHeaderDto, never exposing a secret value', () => {
    const headers: Header[] = [
      {
        id: 'h1',
        service_id: 'svc-1',
        endpoint_id: null,
        name: 'X-Api-Key',
        is_secret: true,
        value: null,
        secret_ciphertext: Buffer.from('ct'),
        secret_iv: Buffer.from('iv'),
        secret_auth_tag: Buffer.from('tag'),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const dto = toServiceDto(service, headers, []);
    expect(dto.headers).toEqual([{ name: 'X-Api-Key', isSecret: true }]);
    expect(dto.headers[0]).not.toHaveProperty('value');
  });

  it('maps tags', () => {
    const tags: Tag[] = [
      { id: 't1', service_id: 'svc-1', endpoint_id: null, key: 'env', value: 'prod' },
    ];
    const dto = toServiceDto(service, [], tags);
    expect(dto.tags).toEqual([{ key: 'env', value: 'prod' }]);
  });
});
