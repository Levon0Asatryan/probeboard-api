import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import type { Header } from '../../../core/db/types.js';
import {
  HeaderKeepWithoutExistingError,
  HeaderStorageService,
  mergeHeaders,
  toHeaderDto,
} from './header-storage.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
});

const service = new HeaderStorageService(cfg);

function toRow(row: {
  name: string;
  value?: string | null;
  is_secret?: boolean;
  secret_ciphertext?: Buffer | null;
  secret_iv?: Buffer | null;
  secret_auth_tag?: Buffer | null;
}): Header {
  return {
    id: 'h1',
    service_id: 'svc',
    endpoint_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    name: row.name,
    value: row.value ?? null,
    is_secret: row.is_secret ?? false,
    secret_ciphertext: row.secret_ciphertext ?? null,
    secret_iv: row.secret_iv ?? null,
    secret_auth_tag: row.secret_auth_tag ?? null,
  };
}

function existingSecret(name: string): Header {
  const row = service.toStorageRows([{ name, value: 'original-secret', isSecret: true }], []);
  return toRow(row[0]);
}

describe('HeaderStorageService.toStorageRows', () => {
  it('stores a plain header as-is', () => {
    const rows = service.toStorageRows([{ name: 'X-Foo', value: 'bar', isSecret: false }], []);
    expect(rows).toEqual([
      {
        name: 'X-Foo',
        is_secret: false,
        value: 'bar',
        secret_ciphertext: null,
        secret_iv: null,
        secret_auth_tag: null,
      },
    ]);
  });

  it('encrypts a secret header being replaced', () => {
    const rows = service.toStorageRows(
      [{ name: 'X-Api-Key', value: 'super-secret', isSecret: true }],
      [],
    );
    expect(rows[0].is_secret).toBe(true);
    expect(rows[0].value).toBeNull();
    expect(rows[0].secret_ciphertext).toBeInstanceOf(Buffer);
    expect(rows[0].secret_iv).toBeInstanceOf(Buffer);
    expect(rows[0].secret_auth_tag).toBeInstanceOf(Buffer);
    // Never anywhere as plaintext.
    expect(JSON.stringify(rows)).not.toContain('super-secret');
  });

  it("keeps an existing secret's ciphertext verbatim when no value is given", () => {
    const existing = existingSecret('X-Api-Key');
    const rows = service.toStorageRows([{ name: 'X-Api-Key', isSecret: true }], [existing]);
    expect(rows[0].secret_ciphertext).toBe(existing.secret_ciphertext);
    expect(rows[0].secret_iv).toBe(existing.secret_iv);
    expect(rows[0].secret_auth_tag).toBe(existing.secret_auth_tag);
  });

  it('matches the existing header by name case-insensitively', () => {
    const existing = existingSecret('X-Api-Key');
    const rows = service.toStorageRows([{ name: 'x-api-key', isSecret: true }], [existing]);
    expect(rows[0].secret_ciphertext).toBe(existing.secret_ciphertext);
  });

  it('rejects "keep" when there is no existing secret with that name', () => {
    expect(() => service.toStorageRows([{ name: 'X-Never-Set', isSecret: true }], [])).toThrow(
      HeaderKeepWithoutExistingError,
    );
  });

  it('rejects "keep" when the existing header with that name is not a secret', () => {
    const plain = service.toStorageRows([{ name: 'X-Foo', value: 'bar', isSecret: false }], []);
    const existing = toRow(plain[0]);
    expect(() => service.toStorageRows([{ name: 'X-Foo', isSecret: true }], [existing])).toThrow(
      HeaderKeepWithoutExistingError,
    );
  });
});

describe('toHeaderDto', () => {
  it('never includes a value for a secret header', () => {
    const secret = existingSecret('X-Api-Key');
    expect(toHeaderDto(secret)).toEqual({ name: 'X-Api-Key', isSecret: true });
  });

  it('includes the value for a plain header', () => {
    const rows = service.toStorageRows([{ name: 'X-Foo', value: 'bar', isSecret: false }], []);
    const header = toRow(rows[0]);
    expect(toHeaderDto(header)).toEqual({ name: 'X-Foo', isSecret: false, value: 'bar' });
  });
});

describe('mergeHeaders (B-4)', () => {
  function plainHeader(name: string, value: string): Header {
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

  it('endpoint header overrides service header by name, case-insensitively', () => {
    const merged = mergeHeaders(
      [plainHeader('X-Api-Key', 'service-value')],
      [plainHeader('x-api-key', 'endpoint-value')],
    );
    expect(merged).toEqual([{ name: 'x-api-key', isSecret: false, value: 'endpoint-value' }]);
  });

  it('keeps a service header untouched by the endpoint when names differ', () => {
    const merged = mergeHeaders([plainHeader('X-Service', 'a')], [plainHeader('X-Endpoint', 'b')]);
    expect(merged).toHaveLength(2);
  });
});
