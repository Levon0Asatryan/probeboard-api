import { describe, expect, it } from 'vitest';
import type { EndpointAssertion } from '../../../core/db/types.js';
import { evaluateAssertion, evaluateAssertions, type ResponseBody } from './evaluate.js';

const whole = (text: string): ResponseBody => ({ text, truncated: false });
const cut = (text: string): ResponseBody => ({ text, truncated: true });

describe('body_contains', () => {
  const assertion: EndpointAssertion = { type: 'body_contains', value: 'healthy' };

  it('passes when the substring is present', () => {
    expect(evaluateAssertion(assertion, whole('{"status":"healthy"}'))).toEqual({ passed: true });
  });

  it('fails when it is absent', () => {
    expect(evaluateAssertion(assertion, whole('{"status":"down"}')).passed).toBe(false);
  });

  it('still passes on a truncated body that already contains it', () => {
    expect(evaluateAssertion(assertion, cut('{"status":"healthy", "more')).passed).toBe(true);
  });

  it('fails on a truncated body that does not contain it, which is the sound answer', () => {
    // The target may have been in the unread tail. Failing a *positive* claim
    // from an incomplete read is conservative and correct.
    expect(evaluateAssertion(assertion, cut('{"status":"deg')).passed).toBe(false);
  });
});

describe('body_not_contains', () => {
  const assertion: EndpointAssertion = { type: 'body_not_contains', value: 'ERROR' };

  it('passes when the whole body lacks the substring', () => {
    expect(evaluateAssertion(assertion, whole('all good'))).toEqual({ passed: true });
  });

  it('fails when the body contains it', () => {
    expect(evaluateAssertion(assertion, whole('ERROR: nope')).passed).toBe(false);
  });

  it('fails on a truncated body even when the read prefix is clean (D23)', () => {
    // The forbidden string could be sitting past the cap. Absence cannot be
    // proven from an incomplete read, so it is never asserted -- the first
    // draft reported "healthy" here.
    const result = evaluateAssertion(assertion, cut('all good so far'));
    expect(result.passed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('truncated') });
  });
});

describe('json_path', () => {
  const statusOk: EndpointAssertion = {
    type: 'json_path',
    path: '$.data.status',
    equals: 'ok',
  };

  it('passes when the value at the path matches', () => {
    expect(evaluateAssertion(statusOk, whole('{"data":{"status":"ok"}}'))).toEqual({
      passed: true,
    });
  });

  it('fails when the value differs', () => {
    expect(evaluateAssertion(statusOk, whole('{"data":{"status":"down"}}')).passed).toBe(false);
  });

  it('fails when the path is absent, rather than throwing', () => {
    expect(evaluateAssertion(statusOk, whole('{"data":{}}')).passed).toBe(false);
  });

  it('fails on a body that is not JSON, rather than crashing', () => {
    const result = evaluateAssertion(statusOk, whole('<html>502 Bad Gateway</html>'));
    expect(result).toMatchObject({ passed: false, reason: expect.stringContaining('valid JSON') });
  });

  it('fails on a truncated body without parsing it (D28)', () => {
    // The prefix here is valid JSON on its own, and the full body would not
    // have been. Parsing it would report a value from data that does not
    // represent the real response.
    const result = evaluateAssertion(statusOk, cut('{"data":{"status":"ok"}}'));
    expect(result).toMatchObject({ passed: false, reason: expect.stringContaining('truncated') });
  });

  it('fails a path outside the supported grammar instead of throwing', () => {
    const wildcard: EndpointAssertion = { type: 'json_path', path: '$.items[*].id', equals: 1 };
    expect(evaluateAssertion(wildcard, whole('{"items":[{"id":1}]}')).passed).toBe(false);
  });

  it('compares structurally, so key order does not matter (D33)', () => {
    const nested: EndpointAssertion = {
      type: 'json_path',
      path: '$.data',
      equals: { b: [1, 2], a: 'x' },
    };
    expect(evaluateAssertion(nested, whole('{"data":{"a":"x","b":[1,2]}}'))).toEqual({
      passed: true,
    });
  });

  it('does not resolve a prototype property (D55)', () => {
    const proto: EndpointAssertion = {
      type: 'json_path',
      path: '$.constructor.name',
      equals: 'Object',
    };
    // Plain `value[segment]` access would find "Object" here and report a
    // healthy endpoint from a value the API never sent.
    expect(evaluateAssertion(proto, whole('{}')).passed).toBe(false);
  });

  it('distinguishes a null value from a missing path', () => {
    const wantsNull: EndpointAssertion = { type: 'json_path', path: '$.a', equals: null };
    expect(evaluateAssertion(wantsNull, whole('{"a":null}')).passed).toBe(true);
    expect(evaluateAssertion(wantsNull, whole('{"b":1}')).passed).toBe(false);
  });
});

describe('evaluateAssertions', () => {
  it('passes when there are none', () => {
    expect(evaluateAssertions([], whole('anything'))).toEqual({ passed: true });
  });

  it('passes only when every assertion passes', () => {
    const all: EndpointAssertion[] = [
      { type: 'body_contains', value: 'ok' },
      { type: 'body_not_contains', value: 'ERROR' },
      { type: 'json_path', path: '$.status', equals: 'ok' },
    ];
    expect(evaluateAssertions(all, whole('{"status":"ok"}'))).toEqual({ passed: true });
  });

  it('reports the first failure', () => {
    const all: EndpointAssertion[] = [
      { type: 'body_contains', value: 'ok' },
      { type: 'body_contains', value: 'absent-marker' },
      { type: 'json_path', path: '$.status', equals: 'nope' },
    ];
    const result = evaluateAssertions(all, whole('{"status":"ok"}'));
    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringContaining('expected substring'),
    });
  });
});
