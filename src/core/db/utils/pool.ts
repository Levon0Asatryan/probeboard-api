import { Pool } from 'pg';
import type { AppConfig } from '../../config/index.js';
import { describeError } from '../../errors/describe.js';

/** Reported when an idle pooled connection dies. */
export type PoolErrorHandler = (message: string, fields: { cause: string }) => void;

export function createPool(cfg: AppConfig, onError: PoolErrorHandler): Pool {
  const pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    // A connection that cannot be established must fail fast rather than
    // hanging a probe or a request indefinitely.
    connectionTimeoutMillis: 5_000,
  });

  // Required, not optional. pg emits 'error' on the pool when an *idle*
  // client's connection dies -- a database restart, a failover, a dropped
  // link. Node escalates an unhandled 'error' event on an EventEmitter into a
  // fatal uncaught exception, so without this listener a routine database
  // restart terminates the api and every worker simultaneously.
  //
  // The pool discards the broken client on its own; later queries open a new
  // connection. So this handler records the event and does nothing else.
  pool.on('error', (err) => {
    onError('idle database connection lost', { cause: describeError(err) });
  });

  return pool;
}
