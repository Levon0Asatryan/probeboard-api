import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSaveableUrl,
  SsrfValidationError,
  type DnsResolver,
} from '../../../core/ssrf/host-validator.js';
import { createConnector } from './pinned-connect.js';
import { classifyGuardRejection, isGuardRejection } from './ssrf-pin.js';

/**
 * The M2 bypass corpus, re-run through the *connect-time* path.
 *
 * `host-validator.test.ts` already proves `assertSaveableUrl` rejects each of
 * these. That is not the same claim as the one M3 has to make: the guard
 * being right is useless if the executor then reaches the address anyway. So
 * this drives the real sequence -- validate, then build the connector from
 * whatever the guard returned -- and asserts that a rejected address never
 * becomes a socket.
 *
 * The corpus itself is deliberately *not* copied here. Those tables live in
 * `host-validator.test.ts` as inline `it.each` literals, and retyping forty
 * URLs into a second table would create precisely the driftable second copy
 * D42 exists to prevent: the next address added to one would not be added to
 * the other, and nothing would fail. A representative address per class is
 * enough to prove the *wiring*, which is what this file is about -- coverage
 * of the address set stays the validator suite's job.
 */

const cfg = { enabled: true, blockedPorts: [6379, 11211, 9200] };

/** Never consulted for a literal; present so a stray call is visible. */
const unusedResolver: DnsResolver = {
  resolve4: () => Promise.reject(new Error('resolver must not be called for a literal')),
  resolve6: () => Promise.reject(new Error('resolver must not be called for a literal')),
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Runs the real sequence a probe would: guard first, connector only if the
 * guard allowed it. Returns what the executor would have done.
 */
async function probeSequence(
  url: string,
  resolver: DnsResolver = unusedResolver,
): Promise<{ connected: boolean; dialled?: string; rejection?: string }> {
  const netSpy = vi.spyOn(net, 'connect').mockReturnValue(new net.Socket());
  const tlsSpy = vi
    .spyOn(tls, 'connect')
    .mockReturnValue(new net.Socket() as unknown as tls.TLSSocket);

  try {
    const validated = await assertSaveableUrl(url, cfg, resolver);
    const target = new URL(url);
    createConnector({ address: validated.addresses[0] })(
      {
        hostname: validated.hostname,
        protocol: target.protocol,
        port: validated.port ?? undefined,
      },
      () => undefined,
    );
    const call = netSpy.mock.calls[0]?.[0] ?? tlsSpy.mock.calls[0]?.[0];
    return {
      connected: true,
      dialled: (call as { host?: string } | undefined)?.host,
    };
  } catch (error) {
    if (!isGuardRejection(error)) throw error;
    // The executor classifies and returns; no connector is ever built.
    expect(netSpy).not.toHaveBeenCalled();
    expect(tlsSpy).not.toHaveBeenCalled();
    return { connected: false, rejection: classifyGuardRejection(error).failureClass };
  }
}

describe('a corpus address never reaches a socket', () => {
  // One per rejection class in the M2 corpus, not the whole table -- see the
  // note above on why this file does not restate it.
  it.each([
    ['numeric IPv4 obfuscation, decimal', 'http://2130706433/'],
    ['numeric IPv4 obfuscation, octal', 'http://0177.0.0.1/'],
    ['cloud metadata', 'http://169.254.169.254/'],
    ['RFC1918', 'http://10.1.2.3/'],
    ['CGNAT', 'http://100.64.1.1/'],
    ['IPv6 loopback, bracketed', 'http://[::1]/'],
    ['IPv6 documentation range', 'http://[2001:db8::1]/'],
    ['unspecified IPv4', 'http://0.0.0.0/'],
  ])('%s is blocked before any connect', async (_label, url) => {
    const result = await probeSequence(url);

    expect(result.connected).toBe(false);
    expect(result.rejection).toBe('BLOCKED_BY_POLICY');
  });

  it('blocks a named metadata host before DNS is even consulted', async () => {
    const result = await probeSequence('http://metadata.google.internal/');
    expect(result).toMatchObject({ connected: false, rejection: 'BLOCKED_BY_POLICY' });
  });

  it.each([
    ['non-http scheme', 'file:///etc/passwd'],
    ['credentials in URL', 'http://user:pass@example.com/'],
    ['blocked port', 'http://93.184.216.34:6379/'],
  ])('%s is refused as policy, not attempted', async (_label, url) => {
    const result = await probeSequence(url);
    expect(result).toMatchObject({ connected: false, rejection: 'BLOCKED_BY_POLICY' });
  });
});

describe('an allowed address is the one actually dialled', () => {
  it('dials the validated literal, not a re-resolved name', async () => {
    const result = await probeSequence('http://93.184.216.34/');
    expect(result).toMatchObject({ connected: true, dialled: '93.184.216.34' });
  });

  it('dials the address the guard saw, closing the rebinding window', async () => {
    // The point of the pin: the resolver answers public once, and whatever it
    // would say on a second call cannot matter, because there is no second
    // call. A transport that re-resolved would defeat the guard entirely.
    let calls = 0;
    const rebinding: DnsResolver = {
      resolve4: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
      },
      resolve6: () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
    };

    const result = await probeSequence('http://rebinding.example.com/', rebinding);

    expect(result).toMatchObject({ connected: true, dialled: '93.184.216.34' });
    expect(calls).toBe(1);
  });

  it('rejects when the second-look address is what the guard was given', async () => {
    // The same hostname, resolved once, to the private address: the guard
    // sees it and nothing is dialled.
    const privateFirst: DnsResolver = {
      resolve4: () => Promise.resolve(['127.0.0.1']),
      resolve6: () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
    };

    const result = await probeSequence('http://rebinding.example.com/', privateFirst);
    expect(result).toMatchObject({ connected: false, rejection: 'BLOCKED_BY_POLICY' });
  });
});

describe('a real DNS failure is not reported as a policy refusal', () => {
  it('classifies an empty resolve as DNS_NXDOMAIN', async () => {
    const empty: DnsResolver = {
      resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
      resolve6: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
    };

    const result = await probeSequence('http://absent.example.com/', empty);
    expect(result).toMatchObject({ connected: false, rejection: 'DNS_NXDOMAIN' });
  });

  it('classifies a resolver outage as DNS_FAILURE', async () => {
    const failing: DnsResolver = {
      resolve4: () => Promise.reject(Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' })),
      resolve6: () => Promise.reject(Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' })),
    };

    const result = await probeSequence('http://broken-dns.example.com/', failing);
    expect(result).toMatchObject({ connected: false, rejection: 'DNS_FAILURE' });
  });
});

describe('SsrfValidationError still surfaces as itself', () => {
  it('is recognisable to the executor', async () => {
    await expect(
      assertSaveableUrl('file:///etc/passwd', cfg, unusedResolver),
    ).rejects.toBeInstanceOf(SsrfValidationError);
  });
});
