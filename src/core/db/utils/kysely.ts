import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { Database } from '../types.js';

export type Db = Kysely<Database>;

export function createDb(pool: Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
