import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DbService } from '../../db/db.service.js';
import { createDb } from '../../db/utils/kysely.js';
import { EndpointRepository } from './endpoint.repository.js';

// No I/O: `.compile()` only builds SQL text and a parameter list, it never
// opens a connection. The Pool below is never queried.
const db = createDb(new Pool({ connectionString: 'postgres://unused:unused@localhost:1/unused' }));
const endpoints = new EndpointRepository({ kysely: db } as DbService);

describe('EndpointRepository.listForServiceQuery / listQuery', () => {
  it('listForService binds a fixed number of parameters for a tag filter, not one per matching row', () => {
    // The regression this guards: a materialized id list joined in as
    // `id IN (...ids)` binds one parameter per matching row, eventually
    // exceeding Postgres's 65535 bind-parameter limit -- ENDPOINT_QUOTA_PER_USER
    // permits up to 100,000. The LATERAL join never does; this compiles to
    // check that without needing a database or any rows at all.
    const compiled = endpoints
      .listForServiceQuery(
        '33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111',
        {
          limit: 50,
          cursor: '22222222-2222-4222-8222-222222222222',
          tag: { key: 'env', value: 'prod' },
        },
      )
      .compile();

    // serviceId, userId, cursor, key, value, the LATERAL subquery's own
    // LIMIT 1, limit -- seven literal parameters.
    expect(compiled.parameters).toHaveLength(7);
  });

  it('list binds a fixed number of parameters for a tag filter, not one per matching row', () => {
    const compiled = endpoints
      .listQuery('11111111-1111-4111-8111-111111111111', {
        limit: 50,
        cursor: '22222222-2222-4222-8222-222222222222',
        tag: { key: 'env', value: 'prod' },
      })
      .compile();

    // userId, cursor, key, value, the LATERAL subquery's own LIMIT 1,
    // limit -- six literal parameters.
    expect(compiled.parameters).toHaveLength(6);
  });
});
