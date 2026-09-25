import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailable } from './database-unavailable.js';

const withCode = (code: string) => Object.assign(new Error('x'), { code });

describe('isDatabaseUnavailable', () => {
  it.each(['08000', '08001', '08003', '08006', '57P02', '57P03', '53300'])(
    'recognises SQLSTATE %s',
    (code) => {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    },
  );

  it('recognises pg-pool running out of time to hand over a connection', () => {
    expect(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isDatabaseUnavailable(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('leaves everything else to be a 500', () => {
    expect(isDatabaseUnavailable(withCode('42P01'))).toBe(false);
    expect(isDatabaseUnavailable(withCode('22P02'))).toBe(false);
    // This process closing its own client is not an outage.
    expect(isDatabaseUnavailable(new Error('Connection terminated'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('boom'))).toBe(false);
    expect(isDatabaseUnavailable({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isDatabaseUnavailable('ECONNREFUSED')).toBe(false);
  });

  it('reads only the top-level code, never a wrapped cause', () => {
    // fetch() wraps a socket error in a TypeError. The api's outbound calls
    // are the OAuth providers, and a provider being down is not the database.
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: withCode('ECONNREFUSED'),
    });
    expect(isDatabaseUnavailable(wrapped)).toBe(false);
  });
});
