import { describe, expect, it } from 'vitest';
import { describeError } from './describe.js';

describe('describeError', () => {
  it('reads a plain error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('prefixes the errno code when there is one', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(describeError(err)).toBe('ECONNREFUSED: connect failed');
  });

  it('unwraps AggregateError, which carries no message of its own', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
      code: 'ECONNREFUSED',
    });
    const agg = new AggregateError([inner], '');
    expect(describeError(agg)).toBe('ECONNREFUSED: connect ECONNREFUSED ::1:5432');
  });

  it('collapses duplicate causes from multiple resolved addresses', () => {
    const mk = () => Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(describeError(new AggregateError([mk(), mk()], ''))).toBe(
      'ECONNREFUSED: connect failed',
    );
  });

  it('falls back to the code when the message is empty', () => {
    expect(describeError(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
  });

  it('falls back to the error name when there is no message and no code', () => {
    expect(describeError(new RangeError(''))).toBe('RangeError');
  });

  it('includes the standard `cause` chain when present', () => {
    const dnsFailure = Object.assign(new Error('the resolver refused the query'), {
      code: 'SERVFAIL',
    });
    const err = new Error('the hostname could not be resolved');
    (err as Error & { cause?: unknown }).cause = dnsFailure;
    expect(describeError(err)).toBe(
      'the hostname could not be resolved (cause: SERVFAIL: the resolver refused the query)',
    );
  });

  it('does not duplicate the code when the cause message already is the code', () => {
    const dnsFailure = Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' });
    const err = new Error('outer');
    (err as Error & { cause?: unknown }).cause = dnsFailure;
    expect(describeError(err)).toBe('outer (cause: SERVFAIL)');
  });

  it('renders a non-Error cause safely', () => {
    const err = new Error('outer');
    (err as Error & { cause?: unknown }).cause = 'a plain string cause';
    expect(describeError(err)).toBe('outer (cause: a plain string cause)');
  });

  it('renders an explicit null cause as "null", not its object tag', () => {
    const err = new Error('outer');
    (err as Error & { cause?: unknown }).cause = null;
    expect(describeError(err)).toBe('outer (cause: null)');
  });

  it('handles an AggregateError that wraps nothing', () => {
    expect(describeError(new AggregateError([], ''))).toBe('AggregateError');
    expect(describeError(new AggregateError([], 'all attempts failed'))).toBe(
      'all attempts failed',
    );
  });

  it('never throws on a non-error value', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ weird: true })).toBe('{"weird":true}');
  });
});

describe('describeError never throws', () => {
  // It runs inside error paths, including a pool 'error' listener where an
  // exception is an uncaught exception and kills the process.

  it('handles a circular object', () => {
    const a: Record<string, unknown> = { kind: 'weird' };
    a.self = a;
    expect(() => describeError(a)).not.toThrow();
    expect(describeError(a)).toContain('[circular]');
  });

  it('handles an object whose toJSON throws', () => {
    const bomb = {
      toJSON() {
        throw new Error('boom');
      },
    };
    expect(() => describeError(bomb)).not.toThrow();
    expect(describeError(bomb)).toBe('[object Object]');
  });

  it('handles BigInt, which JSON.stringify refuses', () => {
    expect(describeError(10n)).toBe('10n');
    expect(describeError({ size: 10n })).toContain('10n');
  });

  it('handles a getter that throws', () => {
    const err = new Error('outer');
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('getter exploded');
      },
    });
    expect(() => describeError(err)).not.toThrow();
  });

  it('handles values JSON cannot represent at all', () => {
    expect(describeError(Symbol('s'))).toBe('Symbol(s)');
    expect(describeError(() => undefined)).toContain('function');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('renders primitives that are not errors', () => {
    expect(describeError(42)).toBe('42');
    expect(describeError(false)).toBe('false');
  });

  it('falls back when JSON.stringify represents nothing at the top level', () => {
    // An object whose own toJSON returns undefined serialises to nothing.
    expect(describeError({ toJSON: () => undefined })).toBe('[object Object]');
  });

  it('handles a value whose very type cannot be read', () => {
    // A Proxy can throw from Symbol.toStringTag, which is the last thing
    // describeError falls back to.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('even toString explodes');
        },
      },
    );
    expect(() => describeError(hostile)).not.toThrow();
    expect(describeError(hostile)).toBe('[unrepresentable]');
  });

  it('handles a circular `cause` chain without recursing forever', () => {
    // The traversal is deliberately one level deep, not recursive, so this
    // cannot infinite-loop -- but prove it rather than assume it.
    const a = new Error('a');
    (a as Error & { cause?: unknown }).cause = a;
    expect(() => describeError(a)).not.toThrow();
    expect(describeError(a)).toBe('a (cause: a)');
  });

  it('handles an AggregateError whose members are hostile', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(new AggregateError([circular, 10n], ''))).not.toThrow();
  });
});
