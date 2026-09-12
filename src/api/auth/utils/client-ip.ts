import type { Request } from 'express';

/**
 * The address the per-IP rate limit keys on.
 *
 * `X-Forwarded-For` is set by the client unless something in front overwrites
 * it, so believing it by default would let an attacker present a fresh address
 * on every request and bypass the limit entirely — turning the protection into
 * decoration. Express only populates `req.ips` from that header when `trust
 * proxy` is enabled, which is off unless a deployment opts in.
 *
 * When trust is enabled, the *left-most* entry is the client Express derived
 * after applying the trust setting, which is the one to key on.
 */
export function clientIp(req: Request): string {
  const forwarded = req.ips;
  if (forwarded.length > 0) return forwarded[0];

  // req.ip can be undefined if the socket is already gone.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
