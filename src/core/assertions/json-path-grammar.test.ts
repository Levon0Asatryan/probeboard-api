import { describe, expect, it } from 'vitest';
import {
  isSupportedJsonPath,
  JSON_PATH_ACCEPTED,
  JSON_PATH_PATTERN,
  JSON_PATH_REJECTED,
  parseJsonPath,
} from './json-path-grammar.js';

describe('the accepted subset', () => {
  it.each([...JSON_PATH_ACCEPTED])('accepts %j', (path) => {
    expect(isSupportedJsonPath(path)).toBe(true);
  });

  it.each([...JSON_PATH_REJECTED])('rejects %j', (path) => {
    expect(isSupportedJsonPath(path)).toBe(false);
  });

  it('has real examples on both sides, so neither loop above can pass vacuously', () => {
    expect(JSON_PATH_ACCEPTED.length).toBeGreaterThan(5);
    expect(JSON_PATH_REJECTED.length).toBeGreaterThan(5);
  });
});

describe('anchoring', () => {
  it('rejects a trailing newline', () => {
    expect(isSupportedJsonPath('a\n')).toBe(false);
    expect(isSupportedJsonPath('$.data.id\n')).toBe(false);
  });

  it('terminates on a lookahead rather than `$`, so the published pattern travels', () => {
    // Not redundant, and not provable from this runtime: JS `$` without `m`
    // already means end-of-input, so both spellings behave identically here.
    // The difference shows up in the consumers of the OpenAPI `pattern` this
    // same source string becomes -- Python's `re`, behind the usual
    // jsonschema package, matches `^a$` against "a\n". Swapping this back to
    // `$` would leave a generated client accepting a path the server
    // rejects, and nothing in the JS suite would notice; this assertion is
    // what notices.
    expect(JSON_PATH_PATTERN.source.endsWith('(?![\\s\\S])')).toBe(true);
  });

  it('rejects a newline anywhere inside the path', () => {
    expect(isSupportedJsonPath('a\nb')).toBe(false);
    expect(isSupportedJsonPath('\na')).toBe(false);
  });

  it('is flagless, so a shared instance keeps no state between calls', () => {
    expect(JSON_PATH_PATTERN.flags).toBe('');
    expect(isSupportedJsonPath('data.id')).toBe(true);
    expect(isSupportedJsonPath('data.id')).toBe(true);
  });
});

describe('parseJsonPath', () => {
  it.each([...JSON_PATH_REJECTED])('returns null for the rejected path %j', (path) => {
    expect(parseJsonPath(path)).toBeNull();
  });

  it('treats `$` as the root rather than a segment', () => {
    expect(parseJsonPath('$')).toEqual([]);
  });

  it('reads `$.a` and `a` as the same path', () => {
    expect(parseJsonPath('$.a')).toEqual(parseJsonPath('a'));
  });

  it('parses names and indices in order', () => {
    expect(parseJsonPath('data.items[0].id')).toEqual([
      { kind: 'name', name: 'data' },
      { kind: 'name', name: 'items' },
      { kind: 'index', index: 0 },
      { kind: 'name', name: 'id' },
    ]);
  });

  it('parses consecutive indices', () => {
    expect(parseJsonPath('matrix[0][1]')).toEqual([
      { kind: 'name', name: 'matrix' },
      { kind: 'index', index: 0 },
      { kind: 'index', index: 1 },
    ]);
  });

  it('parses an index at the root', () => {
    expect(parseJsonPath('[0]')).toEqual([{ kind: 'index', index: 0 }]);
  });

  it('keeps index segments numeric, so a traversal compares against array positions', () => {
    const segments = parseJsonPath('items[10]');
    expect(segments?.[1]).toEqual({ kind: 'index', index: 10 });
  });
});
