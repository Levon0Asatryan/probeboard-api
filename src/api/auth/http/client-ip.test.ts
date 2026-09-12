import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { clientIp } from '../http/client-ip.js';

const request = (parts: Partial<Request>) =>
  ({ ips: [], socket: {}, ...parts }) as unknown as Request;

describe('clientIp', () => {
  it('uses the socket address when no proxy is trusted', () => {
    expect(clientIp(request({ ip: '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('ignores a forged X-Forwarded-For when trust proxy is off', () => {
    // Express leaves req.ips empty unless trust proxy is enabled, so a client
    // that sets the header itself changes nothing. Without that, an attacker
    // could present a fresh address per request and the IP limit would be
    // decoration.
    const forged = request({
      ip: '203.0.113.5',
      ips: [],
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(clientIp(forged)).toBe('203.0.113.5');
  });

  it('uses the client Express derived when a proxy is trusted', () => {
    expect(clientIp(request({ ip: '10.0.0.1', ips: ['198.51.100.7', '10.0.0.1'] }))).toBe(
      '198.51.100.7',
    );
  });

  it('falls back to the socket when req.ip is missing', () => {
    expect(clientIp(request({ socket: { remoteAddress: '192.0.2.9' } as never }))).toBe(
      '192.0.2.9',
    );
  });

  it('never returns undefined, which would collapse every caller into one key', () => {
    expect(clientIp(request({}))).toBe('unknown');
  });
});
