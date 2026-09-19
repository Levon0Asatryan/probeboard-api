import { describe, expect, it } from 'vitest';
import { readJsonPath, structurallyEqual } from './json-path.js';
import { JSON_PATH_REJECTED, parseJsonPath } from '../../../core/assertions/json-path-grammar.js';

const BODY = {
  data: {
    items: [
      { id: 1, status: 'ok', tags: ['a', 'b'] },
      { id: 2, status: 'down', tags: [] },
    ],
    total: 2,
    nothing: null,
  },
  'kebab-key': 'yes',
};

describe('readJsonPath', () => {
  it('reads a dot path', () => {
    expect(readJsonPath(BODY, '$.data.total')).toEqual({ found: true, value: 2 });
  });

  it('reads through an array index', () => {
    expect(readJsonPath(BODY, '$.data.items[0].status')).toEqual({ found: true, value: 'ok' });
    expect(readJsonPath(BODY, '$.data.items[1].id')).toEqual({ found: true, value: 2 });
  });

  it('treats a rooted path and a bare path as the same value', () => {
    expect(readJsonPath(BODY, 'data.total')).toEqual(readJsonPath(BODY, '$.data.total'));
  });

  it('distinguishes a null value from a missing path', () => {
    // Both would be `undefined` under a naive lookup, and an `equals: null`
    // assertion has to be able to tell them apart.
    expect(readJsonPath(BODY, '$.data.nothing')).toEqual({ found: true, value: null });
    expect(readJsonPath(BODY, '$.data.absent')).toEqual({ found: false });
  });

  it('reports a miss rather than throwing on a missing path', () => {
    expect(readJsonPath(BODY, '$.data.items[0].nope')).toEqual({ found: false });
    expect(readJsonPath(BODY, '$.nope.deeper')).toEqual({ found: false });
  });

  it('bounds-checks array indices instead of reading undefined', () => {
    // `arr[5]` on a two-element array is `undefined`, not an error -- and an
    // `equals: undefined` comparison would then quietly succeed.
    expect(readJsonPath(BODY, '$.data.items[5]')).toEqual({ found: false });
    expect(readJsonPath(BODY, '$.data.items[1].tags[0]')).toEqual({ found: false });
  });

  it('refuses to index a non-array or walk into a primitive', () => {
    expect(readJsonPath(BODY, '$.data[0]')).toEqual({ found: false });
    expect(readJsonPath(BODY, '$.data.total.nope')).toEqual({ found: false });
  });

  it('never resolves a prototype property', () => {
    // D55: plain `value[segment]` access walks the prototype chain, so
    // `$.constructor.name` resolves against *any* object and an assertion
    // whose path is absent from the response would report a healthy endpoint
    // from a value the API never sent.
    expect(readJsonPath({}, '$.constructor.name')).toEqual({ found: false });
    expect(readJsonPath({}, '$.__proto__.x')).toEqual({ found: false });
    expect(readJsonPath(BODY, '$.data.constructor')).toEqual({ found: false });
    expect(readJsonPath(BODY, '$.data.items[0].toString')).toEqual({ found: false });
  });

  it("still reads an array's own `length`, which is not a prototype value", () => {
    // Drawing the line where D55 draws it: `length` is an *own* data property
    // of every array, so reporting it is reporting something the API really
    // sent. The rule is about the inherited chain -- `constructor`,
    // `__proto__`, `toString` -- not about every property with a familiar
    // name. Asserted explicitly so this is not later "fixed" by weakening the
    // own-property check into something narrower.
    expect(Object.hasOwn([], 'length')).toBe(true);
    expect(readJsonPath([], '$.length')).toEqual({ found: true, value: 0 });
    expect(readJsonPath(BODY, '$.data.items.length')).toEqual({ found: true, value: 2 });
  });

  it('misses on a path the shared grammar does not accept', () => {
    // The DTO rejects these at save time; a legacy row can still hold one,
    // and "nothing was verified" is the honest answer rather than a throw.
    for (const path of JSON_PATH_REJECTED) {
      expect(parseJsonPath(path)).toBeNull();
      expect(readJsonPath(BODY, path)).toEqual({ found: false });
    }
  });

  it('reads a key containing a hyphen, which the grammar allows', () => {
    expect(readJsonPath(BODY, '$.kebab-key')).toEqual({ found: true, value: 'yes' });
  });
});

describe('structurallyEqual', () => {
  it('compares primitives by value', () => {
    expect(structurallyEqual(1, 1)).toBe(true);
    expect(structurallyEqual('ok', 'ok')).toBe(true);
    expect(structurallyEqual(null, null)).toBe(true);
    expect(structurallyEqual(1, '1')).toBe(false);
    expect(structurallyEqual(null, undefined)).toBe(false);
  });

  it('compares objects regardless of key order', () => {
    // JSON.stringify comparison fails here, turning a correct response into a
    // false ASSERTION_FAILED and a false report of downtime.
    expect(structurallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('compares nested objects and arrays', () => {
    expect(
      structurallyEqual(
        { a: [1, { b: 'x' }], c: { d: null } },
        { c: { d: null }, a: [1, { b: 'x' }] },
      ),
    ).toBe(true);
  });

  it('is not reference equality', () => {
    // `===` would fail this, so every object-valued `equals` would be
    // unsatisfiable.
    expect(structurallyEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(structurallyEqual([1, 2], [1, 2])).toBe(true);
  });

  it('detects a genuine structural difference', () => {
    expect(structurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structurallyEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(structurallyEqual([1, 2], [2, 1])).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structurallyEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('does not treat an array and an object as equal', () => {
    expect(structurallyEqual([], {})).toBe(false);
    expect(structurallyEqual({ 0: 'a', length: 1 }, ['a'])).toBe(false);
  });

  it('treats two NaNs as equal, so the assertion is merely false and not unsatisfiable', () => {
    expect(structurallyEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(structurallyEqual(Number.NaN, 0)).toBe(false);
  });

  it('ignores inherited keys', () => {
    const parent = { inherited: true };
    const child = Object.create(parent) as Record<string, unknown>;
    child.own = 1;
    expect(structurallyEqual(child, { own: 1 })).toBe(true);
  });
});
