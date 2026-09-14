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
  bl.addAddress('0.0.0.0', 'ipv4');
  // Alibaba Cloud's metadata address -- a separate literal, not covered by
  // any of the ranges above.
  bl.addAddress('100.100.100.200', 'ipv4');

  // IPv6: loopback, unspecified, unique local, link-local.
  bl.addAddress('::1', 'ipv6');
  bl.addAddress('::', 'ipv6');
  bl.addSubnet('fc00::', 7, 'ipv6');
  bl.addSubnet('fe80::', 10, 'ipv6');
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
  if (port !== null && cfg.blockedPorts.includes(port)) {
    throw new SsrfValidationError('PORT_NOT_ALLOWED', `port ${port} is not allowed`);
  }

  // `URL.hostname` keeps an IPv6 literal bracketed ("[::1]"); every other
  // check below -- the hostname denylist, net.isIP, dns.resolve, BlockList --
  // needs the bare address.
  const bracketed = url.hostname.toLowerCase();
  const hostname =
    bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed;

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

/**
 * Every A and AAAA record, not `dns.lookup`'s single address -- a hostname
 * with a mixed public/private record set must be rejected if any one of
 * them is private (docs/m2-plan.md §2.4, corpus item 22), which a function
 * that only ever sees one address cannot detect.
 */
async function resolveAll(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses: string[] = [];
  if (v4.status === 'fulfilled') addresses.push(...v4.value);
  if (v6.status === 'fulfilled') addresses.push(...v6.value);
  return addresses;
}
