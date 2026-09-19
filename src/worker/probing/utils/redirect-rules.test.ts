import { describe, expect, it } from 'vitest';
import {
  headersForHop,
  isFollowedRedirect,
  methodForRedirect,
  sameOrigin,
} from './redirect-rules.js';

describe('isFollowedRedirect', () => {
  it.each([301, 302, 303, 307, 308])('follows %i', (status) => {
    expect(isFollowedRedirect(status)).toBe(true);
  });

  it.each([300, 304, 305, 306])('does not follow %i', (status) => {
    // 304 in particular is a legitimate final answer: chasing a Location it
    // may carry would hide the real response from status/assertion checks.
    expect(isFollowedRedirect(status)).toBe(false);
  });

  it('does not follow non-redirect statuses', () => {
    expect(isFollowedRedirect(200)).toBe(false);
    expect(isFollowedRedirect(404)).toBe(false);
    expect(isFollowedRedirect(500)).toBe(false);
  });
});

describe('methodForRedirect', () => {
  it('rewrites POST to GET on 301 and 302', () => {
    // Replaying a mutating method would issue a second POST against the
    // monitored API -- which no standard client does.
    expect(methodForRedirect(301, 'POST')).toBe('GET');
    expect(methodForRedirect(302, 'POST')).toBe('GET');
  });

  it('leaves other methods alone on 301 and 302', () => {
    expect(methodForRedirect(301, 'GET')).toBe('GET');
    expect(methodForRedirect(302, 'HEAD')).toBe('HEAD');
    expect(methodForRedirect(301, 'PUT')).toBe('PUT');
  });

  it('rewrites anything but GET/HEAD to GET on 303', () => {
    expect(methodForRedirect(303, 'POST')).toBe('GET');
    expect(methodForRedirect(303, 'PUT')).toBe('GET');
    expect(methodForRedirect(303, 'DELETE')).toBe('GET');
    expect(methodForRedirect(303, 'GET')).toBe('GET');
    expect(methodForRedirect(303, 'HEAD')).toBe('HEAD');
  });

  it('preserves the method on 307 and 308, which is what they mean', () => {
    expect(methodForRedirect(307, 'POST')).toBe('POST');
    expect(methodForRedirect(308, 'PUT')).toBe('PUT');
    expect(methodForRedirect(307, 'GET')).toBe('GET');
  });

  it('normalises casing', () => {
    expect(methodForRedirect(302, 'post')).toBe('GET');
    expect(methodForRedirect(307, 'post')).toBe('POST');
  });
});

describe('sameOrigin', () => {
  const origin = new URL('https://api.example.com/health');

  it('matches an identical origin on a different path', () => {
    expect(sameOrigin(new URL('https://api.example.com/other'), origin)).toBe(true);
  });

  it('treats a default port and an explicit one as the same', () => {
    expect(sameOrigin(new URL('https://api.example.com:443/x'), origin)).toBe(true);
  });

  it('separates a different host, port or scheme', () => {
    expect(sameOrigin(new URL('https://evil.example.com/x'), origin)).toBe(false);
    expect(sameOrigin(new URL('https://api.example.com:8443/x'), origin)).toBe(false);
    expect(sameOrigin(new URL('http://api.example.com/x'), origin)).toBe(false);
  });
});

describe('headersForHop', () => {
  const origin = new URL('https://api.example.com/health');
  const headers = { Authorization: 'Bearer secret', 'X-Api-Key': 'k', 'Content-Type': 'json' };

  it('carries headers on a same-origin hop that keeps its method', () => {
    const result = headersForHop({
      headers,
      target: new URL('https://api.example.com/next'),
      origin,
      alreadyDropped: false,
      rewrittenToGet: false,
    });
    expect(result).toEqual({ headers, dropped: false });
  });

  it('drops every header on a cross-origin hop (D15)', () => {
    // The map can hold the monitor's own API key for the intended origin; a
    // redirect to an unrelated host would otherwise deliver it there.
    const result = headersForHop({
      headers,
      target: new URL('https://evil.example.com/steal'),
      origin,
      alreadyDropped: false,
      rewrittenToGet: false,
    });
    expect(result).toEqual({ headers: {}, dropped: true });
  });

  it('treats an https to http downgrade as an origin change', () => {
    const result = headersForHop({
      headers,
      target: new URL('http://api.example.com/next'),
      origin,
      alreadyDropped: false,
      rewrittenToGet: false,
    });
    expect(result.dropped).toBe(true);
  });

  it('keeps headers dropped after returning to the original origin', () => {
    // Compared against the *original* request, not the previous hop: a chain
    // that comes back must not re-admit what hop one already stripped.
    const result = headersForHop({
      headers,
      target: new URL('https://api.example.com/back'),
      origin,
      alreadyDropped: true,
      rewrittenToGet: false,
    });
    expect(result).toEqual({ headers: {}, dropped: true });
  });

  it('drops body headers on a same-origin rewrite to GET (D31)', () => {
    // D15 does not fire here -- the origin is unchanged -- so without this a
    // bodyless GET would still advertise a Content-Type.
    const result = headersForHop({
      headers,
      target: new URL('https://api.example.com/next'),
      origin,
      alreadyDropped: false,
      rewrittenToGet: true,
    });
    expect(result.headers).toEqual({ Authorization: 'Bearer secret', 'X-Api-Key': 'k' });
    expect(result.dropped).toBe(false);
  });

  it('removes body headers whatever their casing (D32)', () => {
    // M2 validates names case-insensitively but stores the user's casing, so
    // an exact-string match would strip Content-Type and miss content-type.
    const mixed = {
      'content-type': 'json',
      'CONTENT-ENCODING': 'gzip',
      'Content-Language': 'en',
      'content-LOCATION': '/x',
      'X-Keep': 'yes',
    };
    const result = headersForHop({
      headers: mixed,
      target: new URL('https://api.example.com/next'),
      origin,
      alreadyDropped: false,
      rewrittenToGet: true,
    });
    expect(result.headers).toEqual({ 'X-Keep': 'yes' });
  });
});
