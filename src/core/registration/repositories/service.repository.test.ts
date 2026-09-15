import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { createDb } from '../../db/utils/kysely.js';
import { ServiceRepository } from './service.repository.js';

// No I/O: `.compile()` only builds SQL text and a parameter list, it never
// opens a connection. The Pool below is never queried.
const db = createDb(new Pool({ connectionString: 'postgres://unused:unused@localhost:1/unused' }));
const services = new ServiceRepository({ kysely: db } as DbService);

describe('ServiceRepository.listQuery', () => {
  it('binds a fixed number of parameters for a tag filter, not one per matching row', () => {
    // The regression this guards: a materialized id list joined in as
    // `id IN (...ids)` binds one parameter per matching row, eventually
    // exceeding Postgres's 65535 bind-parameter limit. `WHERE EXISTS`
    // never does -- its parameter count is the same whether zero rows or a
    // million rows in `tags` match, which this compiles to check without
    // needing a database or any rows at all.
    const compiled = services
      .listQuery('11111111-1111-4111-8111-111111111111', {
        limit: 50,
        cursor: '22222222-2222-4222-8222-222222222222',
        tag: { key: 'env', value: 'prod' },
      })
      .compile();

    // userId, cursor, key, value, limit -- five literal parameters.
    expect(compiled.parameters).toHaveLength(5);
  });

  it('binds three parameters with no tag filter', () => {
    const compiled = services
      .listQuery('11111111-1111-4111-8111-111111111111', {
        limit: 50,
        cursor: '22222222-2222-4222-8222-222222222222',
      })
      .compile();

    expect(compiled.parameters).toHaveLength(3);
  });
});
