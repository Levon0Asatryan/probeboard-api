/**
 * A name server that fails on demand, for the guard path's real-resolver tests.
 *
 * The guard resolves through c-ares (`resolve4`/`resolve6`), and the codes
 * c-ares raises are what the failure taxonomy has to read. Feeding
 * `classifyGuardRejection` a hand-built `{ code: 'ESERVFAIL' }` proves the
 * table, not that the table agrees with what c-ares actually says -- the
 * lesson of #49, where three rows passed against synthetic errors and failed
 * against real ones. So this answers real DNS queries over real UDP, and a
 * `dns.promises.Resolver` pointed at it produces each code the way a broken
 * name server on the internet would.
 *
 * It speaks just enough DNS to fail: it echoes the query back as a response
 * with the chosen RCODE and no records. Binds `127.0.0.1` explicitly, for the
 * reason `probe-server.ts` gives.
 */
import dgram from 'node:dgram';
import { promises as dns } from 'node:dns';
import type { DnsResolver } from '../core/ssrf/host-validator.js';

/**
 * How the server answers.
 *
 * The RCODEs are RFC 1035 §4.1.1's: `formerr` 1, `servfail` 2, `nxdomain` 3,
 * `notimp` 4, `refused` 5. `nodata` is a clean NOERROR with no answer.
 * `silent` never answers, `garbage` answers with three bytes that are not a
 * DNS message.
 */
export type DnsFailureMode =
  'nodata' | 'formerr' | 'servfail' | 'nxdomain' | 'notimp' | 'refused' | 'silent' | 'garbage';

const RCODE: Record<Exclude<DnsFailureMode, 'silent' | 'garbage'>, number> = {
  nodata: 0,
  formerr: 1,
  servfail: 2,
  nxdomain: 3,
  notimp: 4,
  refused: 5,
};

export interface TestDnsServer {
  port: number;
  /** Queries received, so a test can prove the resolver really asked. */
  queries: () => number;
  close: () => Promise<void>;
}

/** `mode` answers A queries; `aaaaMode` answers AAAA, defaulting to the same. */
export async function startDnsServer(
  mode: DnsFailureMode,
  aaaaMode: DnsFailureMode = mode,
): Promise<TestDnsServer> {
  const socket = dgram.createSocket('udp4');
  let received = 0;

  socket.on('message', (query, peer) => {
    received += 1;
    const answer = respond(query, qtypeOf(query) === 28 ? aaaaMode : mode);
    if (answer !== undefined) socket.send(answer, peer.port, peer.address);
  });

  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));

  return {
    port: socket.address().port,
    queries: () => received,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/**
 * A c-ares resolver that asks only `port`, once, and gives up after
 * `timeoutMs` -- so a `silent` server produces `ETIMEOUT` well inside a
 * probe's deadline rather than after c-ares' default retries.
 */
export function resolverFor(port: number, timeoutMs = 200): DnsResolver {
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([`127.0.0.1:${String(port)}`]);
  return {
    resolve4: (hostname) => resolver.resolve4(hostname),
    resolve6: (hostname) => resolver.resolve6(hostname),
  };
}

/** The QTYPE of the first question: after the 12-byte header and the QNAME. */
function qtypeOf(query: Buffer): number | undefined {
  let offset = 12;
  while (offset < query.length && query[offset] !== 0) offset += query[offset] + 1;
  return offset + 2 < query.length ? query.readUInt16BE(offset + 1) : undefined;
}

function respond(query: Buffer, mode: DnsFailureMode): Buffer | undefined {
  if (mode === 'silent') return undefined;
  // The query's own id, so the resolver matches it, then nothing it can parse.
  if (mode === 'garbage') return Buffer.from([query[0], query[1], 0x81]);

  const answer = Buffer.from(query);
  // QR=1, keep the query's RD bit; RA=1 and the RCODE in the low nibble.
  answer[2] = 0x80 | (query[2] & 0x01);
  answer[3] = 0x80 | RCODE[mode];
  // No answer, authority or additional records.
  answer.writeUInt16BE(0, 6);
  answer.writeUInt16BE(0, 8);
  answer.writeUInt16BE(0, 10);
  return answer;
}
