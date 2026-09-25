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
const { toErrorResponse } = await import('../errors/http-mapping.js');

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
    ['6to4 (RFC 3056), embedding a private IPv4 gateway', 'http://[2002:0a00:0001::]/'],
    ['Teredo (RFC 4380), embedding an obfuscated private IPv4', 'http://[2001:0:1234::1]/'],
    ["AWS IMDS's IPv6 metadata address", 'http://[fd00:ec2::254]/'],
  ])('%s rejected as ADDRESS_NOT_ALLOWED', async (_label, url) => {
    await rejects(url, 'ADDRESS_NOT_ALLOWED');
  });
});

describe('IANA special-purpose registry ranges added after the review round (docs/m2-verification.md)', () => {
  it.each([
    ['IPv4 Service Continuity Prefix (DS-Lite AFTR)', 'http://192.0.0.1/'],
    ['IPv4 Service Continuity Prefix (DS-Lite B4)', 'http://192.0.0.2/'],
    ['IPv4 dummy address', 'http://192.0.0.8/'],
    ['NAT64/DNS64 Discovery, first address', 'http://192.0.0.170/'],
    ['NAT64/DNS64 Discovery, second address', 'http://192.0.0.171/'],
    ['Documentation (TEST-NET-1)', 'http://192.0.2.1/'],
    ['Documentation (TEST-NET-2)', 'http://198.51.100.1/'],
    ['Documentation (TEST-NET-3)', 'http://203.0.113.1/'],
    ['6to4 Relay Anycast, deprecated and reclassified non-global', 'http://192.88.99.1/'],
    ['IPv6 Benchmarking', 'http://[2001:2::1]/'],
    ['IPv6 deprecated ORCHID', 'http://[2001:10::1]/'],
    ['IPv6 documentation (RFC 3849)', 'http://[2001:db8::1]/'],
    ['IPv6 documentation (RFC 9637)', 'http://[3fff::1]/'],
    ['IPv6 Segment Routing (SRv6) SIDs', 'http://[5f00::1]/'],
    ['IPv6 Discard-Only Address Block', 'http://[100::1]/'],
    ['IPv6 Dummy IPv6 Prefix', 'http://[100:0:0:1::1]/'],
    // Unnamed by the registry -- no RFC assigns this specific address --
    // but still non-global by inheriting 192.0.0.0/24's own "IETF Protocol
    // Assignments" classification. A second review round found these two
    // unblocked: naming only the registry's own named sub-blocks (the ones
    // above) left every other address in the enclosing /24 and /23 outside
    // the block, even though nothing more specific overrides their
    // parent's non-global status.
    ['unnamed address inside the non-global 192.0.0.0/24', 'http://192.0.0.11/'],
    ['unnamed address inside the non-global 2001::/23', 'http://[2001:5::1]/'],
  ])('%s rejected as ADDRESS_NOT_ALLOWED', async (_label, url) => {
    await rejects(url, 'ADDRESS_NOT_ALLOWED');
  });

  it.each([
    ['Port Control Protocol Anycast', 'http://192.0.0.9/'],
    ['Traversal Using Relays around NAT Anycast', 'http://192.0.0.10/'],
    ['IPv6 Port Control Protocol Anycast', 'http://[2001:1::1]/'],
    ['IPv6 Traversal Using Relays around NAT Anycast', 'http://[2001:1::2]/'],
    ['IPv6 DNS-SD Service Registration Protocol Anycast', 'http://[2001:1::3]/'],
    ['AMT', 'http://[2001:3::1]/'],
    ['AS112-v6', 'http://[2001:4:112::1]/'],
    ['ORCHIDv2', 'http://[2001:20::1]/'],
    ['Drone Remote ID Protocol Entity Tags', 'http://[2001:30::1]/'],
  ])(
    '%s is a documented exception inside a wholesale-blocked parent range and is not rejected',
    async (_label, url) => {
      const result = await assertSaveableUrl(url, cfg);
      expect(result.addresses.length).toBeGreaterThan(0);
    },
  );
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
  it.each([
    'http://metadata.google.internal/',
    'http://METADATA.GOOGLE.INTERNAL/',
    // A trailing dot marks an absolute FQDN and resolves identically to the
    // same name without one -- it must not sidestep the denylist fast path.
    'http://metadata.google.internal./',
  ])('%s rejected without a DNS query', async (url) => {
    await rejects(url, 'ADDRESS_NOT_ALLOWED');
    expect(resolve4).not.toHaveBeenCalled();
  });
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

  it('keeps the resolver failure code out of the client-visible details, but on cause', async () => {
    const dnsError = Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' });
    resolve4.mockResolvedValue(['93.184.216.34']);
    resolve6.mockRejectedValue(dnsError);

    try {
      await assertSaveableUrl('http://half-broken.example.com/', cfg);
      expect.unreachable();
    } catch (err) {
      const e = err as SsrfValidationErrorType;
      // details is what AppError's own mapping serializes straight into the
      // HTTP response -- SERVFAIL must never appear there.
      expect(JSON.stringify(e.details ?? null)).not.toContain('SERVFAIL');
      expect(e.cause).toBe(dnsError);
    }
  });

  it('keeps the resolved private address out of the response and puts it in the log (#72, C-7)', async () => {
    // A name answering privately: with the address in `details`, the save
    // endpoint told any signed-in user what an internal name resolves to.
    resolve4.mockResolvedValue(['172.30.0.10']);
    resolve6.mockRejectedValue(enotfound);

    const err: unknown = await assertSaveableUrl('http://db.internal.example/', cfg).catch(
      (e: unknown) => e,
    );

    const mapped = toErrorResponse(err);
    expect(mapped.body).toEqual({
      code: 'ADDRESS_NOT_ALLOWED',
      message: 'resolves to a disallowed address',
    });
    expect(JSON.stringify(mapped.body)).not.toContain('172.30.0.10');
    // Still recorded where an operator can see it.
    expect(mapped.logDetail).toContain('172.30.0.10');
  });

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

describe('an injected resolver (D13)', () => {
  // Passed as an argument rather than through the module mock above, because
  // the claim is that the *injected* resolver is used instead of Node's. The
  // module spies staying untouched is what proves it.
  //
  // M3 needs this to drive a DNS-rebinding proof: the same hostname must
  // answer public on one call and private on the next, which no real resolver
  // will do on request. Injecting here keeps one resolution path and one
  // address classifier, instead of a second copy inside `worker/`.
  const enodata = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });

  function fakeResolver(v4: string[], v6: string[] = []) {
    return {
      resolve4: () => Promise.resolve(v4),
      resolve6: () => (v6.length ? Promise.resolve(v6) : Promise.reject(enodata)),
    };
  }

  it('is used instead of the real resolver', async () => {
    noPublicRecords(); // the module mock would reject this hostname outright
    resolve4.mockClear();
    resolve6.mockClear();

    const result = await assertSaveableUrl(
      'http://injected.example.com/',
      cfg,
      fakeResolver(['93.184.216.34']),
    );

    expect(result.addresses).toEqual(['93.184.216.34']);
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  it('rejects on a private address the injected resolver returns', async () => {
    await expect(
      assertSaveableUrl('http://rebinding.example.com/', cfg, fakeResolver(['169.254.169.254'])),
    ).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });

  it('rejects a mixed record set on the private address, not the public one', async () => {
    // The reason resolve4/resolve6 are used rather than dns.lookup: a
    // single-address view cannot see the private record hiding behind a
    // public one.
    await expect(
      assertSaveableUrl(
        'http://mixed.example.com/',
        cfg,
        fakeResolver(['93.184.216.34', '10.0.0.5']),
      ),
    ).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });

  it('can answer differently on successive calls, which is what a rebinding proof needs', async () => {
    let call = 0;
    const rebinding = {
      resolve4: () => {
        call += 1;
        return Promise.resolve(call === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
      },
      resolve6: () => Promise.reject(enodata),
    };

    const first = await assertSaveableUrl('http://tocttou.example.com/', cfg, rebinding);
    expect(first.addresses).toEqual(['93.184.216.34']);

    await expect(
      assertSaveableUrl('http://tocttou.example.com/', cfg, rebinding),
    ).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });

  it('still fails closed on a resolver error that is not a definitive negative', async () => {
    // SERVFAIL through the injected path must behave exactly as it does
    // through the real one: not knowing what a family resolves to is not the
    // same as knowing it has no records.
    const servfail = {
      resolve4: () => Promise.resolve(['93.184.216.34']),
      resolve6: () => Promise.reject(Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' })),
    };

    await expect(
      assertSaveableUrl('http://half-broken.example.com/', cfg, servfail),
    ).rejects.toMatchObject({ code: 'URL_UNRESOLVABLE' });
  });

  it('is not consulted for an IP literal, which never reaches DNS', async () => {
    let called = false;
    const spy = {
      resolve4: () => {
        called = true;
        return Promise.resolve([]);
      },
      resolve6: () => Promise.reject(enodata),
    };

    const result = await assertSaveableUrl('http://93.184.216.34/', cfg, spy);
    expect(result.addresses).toEqual(['93.184.216.34']);
    expect(called).toBe(false);
  });
});
