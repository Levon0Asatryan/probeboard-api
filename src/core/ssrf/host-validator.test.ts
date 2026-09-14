import { describe, expect, it, vi } from 'vitest';
import type { SsrfValidationError as SsrfValidationErrorType } from './host-validator.js';

const resolve4 = vi.fn<(hostname: string) => Promise<string[]>>();
const resolve6 = vi.fn<(hostname: string) => Promise<string[]>>();

vi.mock('node:dns', () => ({
  promises: {
    resolve4: (hostname: string) => resolve4(hostname),
    resolve6: (hostname: string) => resolve6(hostname),
  },
}));

const { assertSaveableUrl, SsrfValidationError } = await import('./host-validator.js');

const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });

const cfg = { enabled: true, blockedPorts: [6379, 11211, 9200] };

/** No public hostname in this suite resolves for real -- every non-literal case says so explicitly. */
function noPublicRecords() {
  resolve4.mockRejectedValue(enotfound);
  resolve6.mockRejectedValue(enotfound);
}

function publicOnly(v4: string[] = ['93.184.216.34'], v6: string[] = []) {
  resolve4.mockResolvedValue(v4);
  if (v6.length) {
    resolve6.mockResolvedValue(v6);
  } else {
    resolve6.mockRejectedValue(enotfound);
  }
}

async function rejects(url: string, code: string, config = cfg) {
  await expect(assertSaveableUrl(url, config)).rejects.toMatchObject({ code });
}

describe('scheme, credentials, port -- checked before any DNS lookup', () => {
  it('rejects a non-http(s) scheme', async () => {
    await rejects('file:///etc/passwd', 'SCHEME_NOT_ALLOWED');
  });

  it('rejects gopher, the classic SSRF-to-non-HTTP-service vector', async () => {
    await rejects('gopher://127.0.0.1:6379/_SET%20x%201', 'SCHEME_NOT_ALLOWED');
  });

  it('rejects a malformed URL the same way as a disallowed scheme', async () => {
    await rejects('not a url', 'SCHEME_NOT_ALLOWED');
  });

  it('rejects userinfo credentials embedded in the URL', async () => {
    await rejects('http://user:pass@example.com/', 'CREDENTIALS_IN_URL');
  });

  it('rejects a blocked port even on an otherwise-public host', async () => {
    publicOnly();
    await rejects('http://public-host.example.com:6379/', 'PORT_NOT_ALLOWED');
  });

  it('accepts an unlisted port, 8080 included', async () => {
    publicOnly();
    await expect(
      assertSaveableUrl('http://public-host.example.com:8080/', cfg),
    ).resolves.toBeDefined();
  });

  it('rejects a blocked default port even with no explicit port in the URL', async () => {
    // URL normalizes `http://host` and `http://host:80` identically -- both
    // leave url.port empty -- so the denylist has to be checked against the
    // scheme's effective port, not only an explicit one.
    publicOnly();
    await rejects('http://public-host.example.com/', 'PORT_NOT_ALLOWED', {
      ...cfg,
      blockedPorts: [80],
    });
  });

  it('rejects a blocked default HTTPS port with no explicit port in the URL', async () => {
    publicOnly();
    await rejects('https://public-host.example.com/', 'PORT_NOT_ALLOWED', {
      ...cfg,
      blockedPorts: [443],
    });
  });
});

describe('numeric IPv4 obfuscation -- caught because URL.hostname already canonicalized it', () => {
  const cases: [string, string][] = [
    ['decimal', 'http://2130706433/'],
    ['octal, full', 'http://017700000001/'],
    ['octal, dotted', 'http://0177.0.0.1/'],
    ['hex, mixed', 'http://0x7f.1/'],
    ['hex, full', 'http://0x7f000001/'],
    ['short-form a.b', 'http://127.1/'],
    ['short-form a.b.c', 'http://127.0.1/'],
    ['trailing dot', 'http://127.0.0.1./'],
    ['plain loopback', 'http://127.0.0.1/'],
  ];

  it.each(cases)('%s rejected as ADDRESS_NOT_ALLOWED, no DNS query made', async (_label, url) => {
    await rejects(url, 'ADDRESS_NOT_ALLOWED');
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });
});

describe('IPv6 forms', () => {
  it.each([
    ['loopback', 'http://[::1]/'],
    ['unspecified', 'http://[::]/'],
    ['IPv4-mapped', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-compatible (deprecated)', 'http://[::127.0.0.1]/'],
    ['unique local', 'http://[fd12:3456:789a::1]/'],
    ['link-local', 'http://[fe80::1]/'],
    ['site-local (deprecated by RFC 3879, still routed on some networks)', 'http://[fec0::1]/'],
    ['NAT64 well-known prefix, embedding a private IPv4', 'http://[64:ff9b::a00:1]/'],
    ['NAT64 local-use prefix (RFC 8215)', 'http://[64:ff9b:1::1]/'],
    ['multicast (site-scoped)', 'http://[ff05::1]/'],
    [
      'SIIT extended IPv4-translatable (RFC 6145), embedding loopback',
      'http://[::ffff:0:127.0.0.1]/',
    ],
    ["AWS IMDS's IPv6 metadata address", 'http://[fd00:ec2::254]/'],
  ])('%s rejected as ADDRESS_NOT_ALLOWED', async (_label, url) => {
    await rejects(url, 'ADDRESS_NOT_ALLOWED');
  });
});

describe('0.0.0.0 and cloud/CGNAT/benchmark/multicast literals', () => {
  it.each([
    ['unspecified IPv4', 'http://0.0.0.0/'],
    ['"this network" 0.0.0.0/8, not just the single address', 'http://0.0.0.1/'],
    ['AWS/Azure metadata', 'http://169.254.169.254/'],
    ['Alibaba Cloud metadata', 'http://100.100.100.200/'],
    ['CGNAT', 'http://100.64.1.1/'],
    ['benchmark range', 'http://198.18.0.1/'],
    ['multicast', 'http://224.0.0.1/'],
    ['reserved (class E)', 'http://240.0.0.1/'],
    ['RFC1918 10/8', 'http://10.1.2.3/'],
    ['RFC1918 172.16/12', 'http://172.16.0.5/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
  ])('%s rejected as ADDRESS_NOT_ALLOWED', async (_label, url) => {
    await rejects(url, 'ADDRESS_NOT_ALLOWED');
  });
});

describe('named metadata hosts, rejected before DNS runs', () => {
  it.each(['http://metadata.google.internal/', 'http://METADATA.GOOGLE.INTERNAL/'])(
    '%s rejected without a DNS query',
    async (url) => {
      await rejects(url, 'ADDRESS_NOT_ALLOWED');
      expect(resolve4).not.toHaveBeenCalled();
    },
  );
});

describe('DNS-resolved hostnames', () => {
  it('accepts a hostname resolving only to public addresses', async () => {
    publicOnly(['93.184.216.34']);
    const result = await assertSaveableUrl('http://public-api.example.com/', cfg);
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('rejects when any one of several resolved addresses is private -- not just the first', async () => {
    resolve4.mockResolvedValue(['8.8.8.8', '127.0.0.1']);
    resolve6.mockRejectedValue(enotfound);
    await rejects('http://mixed.example.com/', 'ADDRESS_NOT_ALLOWED');
  });

  it('rejects when resolution produces no addresses at all', async () => {
    noPublicRecords();
    await rejects('http://this-does-not-exist.invalid/', 'URL_UNRESOLVABLE');
  });

  it('queries both A and AAAA records', async () => {
    publicOnly(['93.184.216.34']);
    await assertSaveableUrl('http://public-api.example.com/', cfg);
    expect(resolve4).toHaveBeenCalledWith('public-api.example.com');
    expect(resolve6).toHaveBeenCalledWith('public-api.example.com');
  });

  it('is case-insensitive on the hostname', async () => {
    publicOnly(['93.184.216.34']);
    await assertSaveableUrl('http://Public-API.EXAMPLE.com/', cfg);
    expect(resolve4).toHaveBeenCalledWith('public-api.example.com');
  });

  it('fails closed when one family definitively has no record and the other resolves public', async () => {
    // ENOTFOUND/ENODATA are a trustworthy negative -- this is the ordinary
    // "no AAAA record" case for a v4-only host, and must still succeed.
    resolve4.mockResolvedValue(['93.184.216.34']);
    resolve6.mockRejectedValue(enotfound);
    const result = await assertSaveableUrl('http://v4-only.example.com/', cfg);
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it.each(['SERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED'])(
    'fails closed on a %s resolving one family, even when the other family is public -- does not fail open',
    async (code) => {
      resolve4.mockResolvedValue(['93.184.216.34']);
      resolve6.mockRejectedValue(Object.assign(new Error(code), { code }));
      await rejects('http://half-broken.example.com/', 'URL_UNRESOLVABLE');
    },
  );

  it('does not silently accept a hostname whose only working family errored unexpectedly', async () => {
    resolve4.mockRejectedValue(Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' }));
    resolve6.mockRejectedValue(enotfound);
    await rejects('http://broken.example.com/', 'URL_UNRESOLVABLE');
  });
});

describe('SSRF_GUARD_ENABLED=false', () => {
  it('skips DNS resolution and address classification, but still enforces scheme/credentials/port', async () => {
    const disabled = { enabled: false, blockedPorts: [6379] };

    await expect(assertSaveableUrl('http://127.0.0.1:4318/', disabled)).resolves.toBeDefined();
    expect(resolve4).not.toHaveBeenCalled();

    await expect(assertSaveableUrl('file:///etc/passwd', disabled)).rejects.toMatchObject({
      code: 'SCHEME_NOT_ALLOWED',
    });
    await expect(assertSaveableUrl('http://127.0.0.1:6379/', disabled)).rejects.toMatchObject({
      code: 'PORT_NOT_ALLOWED',
    });
  });
});

describe('SsrfValidationError', () => {
  it('carries a 400 status and the rejection code as its AppError code', async () => {
    try {
      await assertSaveableUrl('file:///etc/passwd', cfg);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfValidationError);
      expect((err as SsrfValidationErrorType).status).toBe(400);
      expect((err as SsrfValidationErrorType).code).toBe('SCHEME_NOT_ALLOWED');
    }
  });
});
