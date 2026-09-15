import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { AppError } from '../errors/app-error.js';

/**
 * Save-time SSRF validation (docs/m2-plan.md §5.1, §6).
 *
 * This is deliberately not the full guard chapter 7.4 describes for the
 * probe executor (M3): steps 1-3 below, never step 4 (pinning the connection
 * to the validated IP). There is no connection to pin at save time -- a
 * hostname can resolve to a public address now and a private one when M3
 * actually connects (DNS rebinding), and no amount of care here closes that
 * window. M3 reuses this module's classification and resolution but adds its
 * own connect-time pin; this module's job ends at "reject what is already
 * wrong before storing it."
 */

export type SsrfRejectionCode =
  | 'SCHEME_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'PORT_NOT_ALLOWED'
  | 'URL_UNRESOLVABLE'
  | 'ADDRESS_NOT_ALLOWED';

export class SsrfValidationError extends AppError {
  constructor(code: SsrfRejectionCode, message: string, details?: unknown) {
    super(code, message, 400, details);
  }
}

export interface SsrfGuardConfig {
  /** SSRF_GUARD_ENABLED. false skips DNS resolution and address classification only. */
  enabled: boolean;
  /** SSRF_BLOCKED_PORTS, parsed. */
  blockedPorts: number[];
}

export interface ValidatedUrl {
  hostname: string;
  /** Every A/AAAA address the hostname resolved to, in whatever order dns returned them. */
  addresses: string[];
  /** null when the URL carries no explicit port (the scheme's default applies). */
  port: number | null;
}

/**
 * Hostnames whose only purpose is resolving to a link-local metadata
 * address. Rejected by name before DNS runs at all, because the point of
 * checking every resolved address (rule below) does not help here: the
 * whole reason these names exist is to resolve to exactly the address
 * that check would also catch, so this is belt-and-braces, not a substitute.
 */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.internal']);

let blockList: BlockList | undefined;

/** Built once and reused -- constructing it is the only non-trivial cost here. */
function getBlockList(): BlockList {
  if (blockList) return blockList;

  const bl = new BlockList();
  // IPv4: loopback, RFC1918 private ranges, link-local (covers cloud
  // metadata's 169.254.169.254 and Azure's identical address), CGNAT,
  // benchmark, multicast, reserved (class E), the unspecified address.
  bl.addSubnet('127.0.0.0', 8, 'ipv4');
  bl.addSubnet('10.0.0.0', 8, 'ipv4');
  bl.addSubnet('172.16.0.0', 12, 'ipv4');
  bl.addSubnet('192.168.0.0', 16, 'ipv4');
  bl.addSubnet('169.254.0.0', 16, 'ipv4');
  bl.addSubnet('100.64.0.0', 10, 'ipv4');
  bl.addSubnet('198.18.0.0', 15, 'ipv4');
  bl.addSubnet('224.0.0.0', 4, 'ipv4');
  bl.addSubnet('240.0.0.0', 4, 'ipv4');
  // "This network" -- 0.0.0.0/8, not just the single address 0.0.0.0.
  bl.addSubnet('0.0.0.0', 8, 'ipv4');
  // Alibaba Cloud's metadata address -- a separate literal, not covered by
  // any of the ranges above.
  bl.addAddress('100.100.100.200', 'ipv4');
  // The rest of this function's ranges are checked entry-by-entry against
  // the IANA IPv4/IPv6 Special-Purpose Address Registries (docs/m2-verification.md
  // has the full comparison table), not just the handful of well-known ones
  // above.
  //
  // 192.0.0.0/24 "IETF Protocol Assignments" is non-global, but two single
  // addresses inside it -- 192.0.0.9 (Port Control Protocol Anycast) and
  // 192.0.0.10 (TURN Anycast) -- are marked globally reachable. Carving
  // exactly those two out of an otherwise-blocked /24 needs eight separate
  // ranges for two addresses; instead, only the three specifically-named
  // non-global sub-blocks are blocked (DS-Lite's AFTR/B4 addresses land in
  // the first one), matching every other range in this list -- each is
  // named by the registry, not swept in wholesale with its siblings.
  bl.addSubnet('192.0.0.0', 29, 'ipv4'); // IPv4 Service Continuity Prefix (DS-Lite, RFC 7335)
  bl.addAddress('192.0.0.8', 'ipv4'); // IPv4 dummy address (RFC 7600)
  bl.addSubnet('192.0.0.170', 31, 'ipv4'); // NAT64/DNS64 Discovery, .170 and .171 (RFC 7050/8880)
  bl.addSubnet('192.0.2.0', 24, 'ipv4'); // Documentation (TEST-NET-1, RFC 5737)
  bl.addSubnet('198.51.100.0', 24, 'ipv4'); // Documentation (TEST-NET-2, RFC 5737)
  bl.addSubnet('203.0.113.0', 24, 'ipv4'); // Documentation (TEST-NET-3, RFC 5737)
  // Deprecated by RFC 7526, and reclassified non-global by the registry --
  // "deprecated" is not "gone", the same reasoning fec0::/10 below gets.
  bl.addSubnet('192.88.99.0', 24, 'ipv4'); // 6to4 Relay Anycast (RFC 3068, deprecated)

  // IPv6: loopback, unspecified, unique local, link-local.
  bl.addAddress('::1', 'ipv6');
  bl.addAddress('::', 'ipv6');
  bl.addSubnet('fc00::', 7, 'ipv6');
  bl.addSubnet('fe80::', 10, 'ipv6');
  // Deprecated by RFC 3879, but "deprecated" is not "gone": some networks
  // still route site-local IPv6, and fec0::/10 falls outside every other
  // range above (it shares no prefix with fc00::/7 or fe80::/10).
  bl.addSubnet('fec0::', 10, 'ipv6');
  // The deprecated "IPv4-compatible" IPv6 form, ::a.b.c.d -- e.g. ::127.0.0.1,
  // which re-serializes as ::7f00:1 and is NOT covered by BlockList's
  // IPv4-mapped (::ffff:a.b.c.d) cross-family matching, confirmed by test:
  // that matching only recognizes the ::ffff: prefix, not a bare :: one.
  // Blocking the whole ::/96 range closes every address of this deprecated
  // form at once, ::1 and :: included (already covered above, kept
  // separately for clarity), without touching any real public IPv6 address,
  // which by definition has non-zero bits in its first 96.
  bl.addSubnet('::', 96, 'ipv6');
  // AWS's IPv6 metadata address -- a separate literal from the ULA range
  // above's coverage, since AWS assigns it out of that same fc00::/7 space
  // but it is worth naming explicitly for what it is.
  bl.addAddress('fd00:ec2::254', 'ipv6');
  // NAT64: an IPv6 address that embeds an IPv4 destination in its low bits
  // and gets translated to that IPv4 address on the way out. Blocked
  // wholesale rather than decoded and classified per-address -- a NAT64
  // gateway can translate to any IPv4, private ranges included, so treating
  // every address in either prefix as unsafe is the same posture already
  // taken for ::/96 above, and decoding RFC 8215's variable embedding
  // lengths correctly is complexity this guard does not need to take on.
  // (The IANA registry marks 64:ff9b::/96 itself "Global: Yes" -- that
  // column answers a different question, whether the well-known prefix is
  // routable on the public Internet, not whether the address it embeds is
  // safe to connect to. This guard cares about the latter, so the block
  // stays despite the registry's "Yes".)
  bl.addSubnet('64:ff9b::', 96, 'ipv6'); // RFC 6052 well-known prefix
  bl.addSubnet('64:ff9b:1::', 48, 'ipv6'); // RFC 8215 local-use prefix
  // IPv6 multicast, the counterpart to the IPv4 224.0.0.0/4 rule above --
  // site-scoped multicast (e.g. ff05::1) is not "a public address", it is
  // network-scoped, and net.isIP recognizes it fine without this rule.
  bl.addSubnet('ff00::', 8, 'ipv6');
  // RFC 6145/SIIT's extended IPv4-translatable form, ::ffff:0:a.b.c.d --
  // distinct from the plain IPv4-mapped ::ffff:a.b.c.d BlockList's
  // cross-family matching already handles. This one re-serializes with an
  // extra zero group (::ffff:0:7f00:1 for 127.0.0.1) and matches none of
  // the rules above, so it needs its own explicit range.
  bl.addSubnet('::ffff:0:0:0', 96, 'ipv6');
  // 6to4 (RFC 3056, deprecated): 2002::/16 embeds an IPv4 gateway address in
  // bits 16-48 (2002:0a00:0001:: embeds 10.0.0.1) and a 6to4 relay routes to
  // it, private ranges included. Same posture as the NAT64/SIIT rules above
  // -- blocked wholesale rather than decoding the embedded address.
  bl.addSubnet('2002::', 16, 'ipv6');
  // Teredo (RFC 4380, deprecated): 2001::/32 embeds an obfuscated IPv4
  // address (client and server addresses, each XORed with 0xffffffff) that
  // a Teredo relay decodes and routes to -- the same embedding property
  // that justifies blocking 6to4 and NAT64 wholesale above, so it gets the
  // same treatment rather than being decoded and classified per-address.
  bl.addSubnet('2001::', 32, 'ipv6');
  // The rest of this function's IPv6 ranges are, like the IPv4 ones above,
  // checked entry-by-entry against the IANA IPv6 Special-Purpose Address
  // Registry (docs/m2-verification.md has the full comparison table).
  // 2001::/23 "IETF Protocol Assignments" (which 2001::/32 above is one
  // named sub-block of) is not swept wholesale like 192.0.0.0/24's IPv4
  // counterpart: unlike that /24's two single global addresses, 2001::/23
  // carves out two entire /28s for active protocols (ORCHIDv2, Drone
  // Remote ID) -- wholesale-blocking would reject real, currently-assigned
  // global traffic, not just two obscure anycast literals. Only the
  // specifically-named non-global sub-blocks are added here, same as IPv4.
  bl.addSubnet('2001:2::', 48, 'ipv6'); // Benchmarking (RFC 5180)
  bl.addSubnet('2001:10::', 28, 'ipv6'); // Deprecated, previously ORCHID (RFC 4843, deprecated by RFC 7343)
  bl.addSubnet('2001:db8::', 32, 'ipv6'); // Documentation (RFC 3849)
  bl.addSubnet('3fff::', 20, 'ipv6'); // Documentation (RFC 9637)
  bl.addSubnet('5f00::', 16, 'ipv6'); // Segment Routing (SRv6) SIDs (RFC 9602)
  bl.addSubnet('100::', 64, 'ipv6'); // Discard-Only Address Block (RFC 6666)
  bl.addSubnet('100:0:0:1::', 64, 'ipv6'); // Dummy IPv6 Prefix (RFC 9702)

  blockList = bl;
  return bl;
}

function isBlockedAddress(address: string): boolean {
  const bl = getBlockList();
  // net.isIP distinguishes the family; BlockList.check needs to be told
  // which one explicitly. dns.resolve4/resolve6 already segregate these, so
  // this is only ever called with a clean literal from one of those two.
  return address.includes(':') ? bl.check(address, 'ipv6') : bl.check(address, 'ipv4');
}

/**
 * Validates a URL is saveable per the SSRF policy: absolute http(s), no
 * embedded credentials, not on a blocked port, and every address it resolves
 * to is public.
 *
 * Runs on every save -- create and update alike (docs/m2-plan.md §4 D10)
 * -- never only once. The caller passes the raw string exactly as the user
 * submitted it; this function is where `new URL()` first parses it, so no
 * caller-side regex or substring check on the raw string can be trusted
 * ahead of this (docs/m2-plan.md §2.4 -- Node's own parser already
 * canonicalizes the numeric-IPv4-obfuscation corpus, which is the entire
 * reason to parse here and nowhere earlier).
 */
export async function assertSaveableUrl(
  rawUrl: string,
  cfg: SsrfGuardConfig,
): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfValidationError('SCHEME_NOT_ALLOWED', 'must be an absolute http(s) URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfValidationError('SCHEME_NOT_ALLOWED', 'must be an absolute http(s) URL');
  }

  if (url.username !== '' || url.password !== '') {
    throw new SsrfValidationError('CREDENTIALS_IN_URL', 'must not contain credentials');
  }

  const port = url.port === '' ? null : Number(url.port);
  // The denylist is checked against the *effective* port. `URL` normalizes
  // `http://host` and `http://host:80` identically -- both leave `url.port`
  // empty -- so checking only an explicit port would let an operator add 80
  // or 443 to SSRF_BLOCKED_PORTS and have every default-port URL sail past
  // it silently.
  const effectivePort = port ?? (url.protocol === 'https:' ? 443 : 80);
  if (cfg.blockedPorts.includes(effectivePort)) {
    throw new SsrfValidationError('PORT_NOT_ALLOWED', `port ${effectivePort} is not allowed`);
  }

  // `URL.hostname` keeps an IPv6 literal bracketed ("[::1]"); every other
  // check below -- the hostname denylist, net.isIP, dns.resolve, BlockList --
  // needs the bare address.
  const bracketed = url.hostname.toLowerCase();
  const unbracketed =
    bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed;
  // A trailing dot marks an absolute FQDN ("metadata.google.internal.") and
  // resolves identically to the same name without one, but is a different
  // string -- stripped here so the denylist fast-path below cannot be
  // sidestepped by it. Not itself a bypass either way: DNS still resolves
  // the dotted form and the address check below would still catch it, but
  // an unstripped miss here would silently skip the "reject by name before
  // DNS runs" fast path this set exists for.
  const hostname = unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfValidationError('ADDRESS_NOT_ALLOWED', 'resolves to a disallowed address');
  }

  if (!cfg.enabled) {
    return { hostname, addresses: [], port };
  }

  // An IP literal never reaches DNS: `dns.resolve4`/`resolve6` perform an
  // actual query and reject a literal address with ENOTFOUND, since it is
  // not a name to look up. Node's URL parser already canonicalized every
  // numeric-IPv4-obfuscation form (decimal, octal, hex, short-form) into a
  // literal by this point (docs/m2-plan.md §2.4), so this branch is exactly
  // where that corpus is caught.
  const addresses = isIP(hostname) ? [hostname] : await resolveAll(hostname);
  if (addresses.length === 0) {
    throw new SsrfValidationError('URL_UNRESOLVABLE', 'the hostname does not resolve');
  }

  const blocked = addresses.find(isBlockedAddress);
  if (blocked) {
    throw new SsrfValidationError('ADDRESS_NOT_ALLOWED', 'resolves to a disallowed address', {
      address: blocked,
    });
  }

  return { hostname, addresses, port };
}

/** No record of this type exists -- a definitive, trustworthy negative. */
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Every A and AAAA record, not `dns.lookup`'s single address -- a hostname
 * with a mixed public/private record set must be rejected if any one of
 * them is private (docs/m2-plan.md §2.4, corpus item 22), which a function
 * that only ever sees one address cannot detect.
 *
 * A failure resolving one family is only ever treated as "no addresses of
 * that family" when the failure itself says so (ENOTFOUND, ENODATA). Any
 * other resolver error -- SERVFAIL, a timeout, a refused query -- means this
 * function does not actually know what that family would have resolved to,
 * and folding that unknown into "no addresses" would let the other family's
 * public record wave the whole URL through while a private one could have
 * been sitting behind the very failure that got silently discarded. Fails
 * closed instead: the whole validation fails, not just that family.
 */
async function resolveAll(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses: string[] = [];

  for (const result of [v4, v6]) {
    if (result.status === 'fulfilled') {
      addresses.push(...result.value);
      continue;
    }
    const code = (result.reason as NodeJS.ErrnoException).code;
    if (!code || !NO_RECORD_CODES.has(code)) {
      // The resolver's raw code (SERVFAIL, ETIMEOUT, ...) is internal DNS
      // state, not something to hand to whoever submitted the URL --
      // AppError's `details` is serialized straight into the HTTP response
      // (toErrorResponse), so it never goes there. Attached as the standard
      // `cause` instead, which stays off the response and is available to
      // whatever catches and logs this once this module is wired into a
      // service (docs/m2-plan.md PR4).
      const error = new SsrfValidationError(
        'URL_UNRESOLVABLE',
        'the hostname could not be resolved',
      );
      error.cause = result.reason;
      throw error;
    }
  }

  return addresses;
}
