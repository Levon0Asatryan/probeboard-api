/**
 * The Fetch standard's "bad port" list (https://fetch.spec.whatwg.org/#bad-port).
 *
 * undici's `fetch` refuses these outright, before any socket, with a
 * `TypeError('fetch failed')` whose cause is `Error('bad port')` and carries no
 * `code` -- measured on Node 22.23.2 and undici 8.11.2 (docs/m6-plan.md §2.4.4).
 * An endpoint on one can therefore never be probed: before this check it
 * recorded `unknown / unknown_error` for ever, and uptime excludes `unknown`, so
 * the monitor was invisible rather than down (M3 D73).
 *
 * Not configuration, unlike `SSRF_BLOCKED_PORTS`: it is the HTTP client's hard
 * limit, not a policy choice, and an operator removing a port here would only
 * move the refusal from save time back into every probe. A drift test compares
 * it with undici's own list, so an upgrade that changes it fails CI.
 *
 * Not only obscure services: 6000 (X11), 6665-6669 (IRC) and 10080 are ports
 * someone could plausibly serve HTTP on.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
