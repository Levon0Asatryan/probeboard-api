import type { Header } from '../db/types.js';

/**
 * B-4: an endpoint's effective headers are `{...serviceHeaders,
 * ...endpointHeaders}` keyed by `lower(name)`, endpoint wins -- computed at
 * read time, never stored pre-merged (docs/m2-plan.md §5.2).
 *
 * Lives in `core`, not `api/registration`, because M3's probe executor
 * (the worker) has to apply this exact same override rule to build the
 * outbound header set it actually sends, and `api`/`worker` never depend
 * on each other (AGENTS.md's structure rule). Returns raw `Header` rows,
 * ciphertext included -- the api layer's own `toHeaderDto`/`mergeHeaders`
 * wraps this for the redacted DTO the HTTP response needs; the worker
 * instead decrypts (`decryptHeaderValue`) whichever of these rows it
 * needs to actually send.
 */
export function mergeHeaderRows(serviceHeaders: Header[], endpointHeaders: Header[]): Header[] {
  const merged = new Map<string, Header>();
  for (const h of serviceHeaders) merged.set(h.name.toLowerCase(), h);
  for (const h of endpointHeaders) merged.set(h.name.toLowerCase(), h);
  return [...merged.values()];
}
