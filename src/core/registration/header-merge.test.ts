import { describe, expect, it } from 'vitest';
import type { Header } from '../db/types.js';
import { mergeHeaderRows } from './header-merge.js';

function header(name: string, value: string): Header {
  return {
    id: name,
    service_id: 'svc',
    endpoint_id: null,
    name,
    is_secret: false,
    value,
    secret_ciphertext: null,
    secret_iv: null,
    secret_auth_tag: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('mergeHeaderRows', () => {
  it('endpoint row overrides service row by name, case-insensitively (B-4)', () => {
    const merged = mergeHeaderRows(
      [header('X-Api-Key', 'service-value')],
      [header('x-api-key', 'endpoint-value')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('endpoint-value');
  });

  it('keeps a service row untouched when names differ', () => {
    const merged = mergeHeaderRows([header('X-Service', 'a')], [header('X-Endpoint', 'b')]);
    expect(merged).toHaveLength(2);
  });

  it('returns the raw row, ciphertext included -- not a redacted DTO', () => {
    const secret: Header = {
      id: 'h1',
      service_id: 'svc',
      endpoint_id: null,
      name: 'X-Api-Key',
      is_secret: true,
      value: null,
      secret_ciphertext: Buffer.from('ct'),
      secret_iv: Buffer.from('iv'),
      secret_auth_tag: Buffer.from('tag'),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const merged = mergeHeaderRows([], [secret]);
    expect(merged[0].secret_ciphertext).toEqual(Buffer.from('ct'));
  });
});
