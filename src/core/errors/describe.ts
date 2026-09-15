/**
 * Renders any thrown value as a single log-safe line.
 *
 * **This function must never throw.** It is called from error paths only,
 * including a `pool.on('error')` listener where an exception would be an
 * uncaught exception and would terminate the process — the exact failure this
 * project fixed in M0, which would otherwise be reachable through the fix
 * itself. Every branch below is therefore defensive, and the whole body is
 * wrapped as a last resort.
 */
export function describeError(err: unknown): string {
  try {
    return describe(err);
  } catch {
    // A getter threw, a proxy misbehaved, or something else surprising. The
    // caller is already handling a failure; it must not be handed a second one.
    return safeTypeOf(err);
  }
}

function describe(err: unknown): string {
  if (err instanceof AggregateError) {
    // Node reports a failed connection to a host with several addresses this
    // way, and an AggregateError carries no message of its own.
    const parts = err.errors.map(describeError).filter(Boolean);
    const unique = [...new Set(parts)];
    return unique.length > 0 ? unique.join('; ') : err.message || 'AggregateError';
  }

  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const base = err.message
      ? code
        ? `${code}: ${err.message}`
        : err.message
      : (code ?? err.name);

    // The standard ES2022 `cause` chain, e.g. a resolver failure attached to
    // an SsrfValidationError so it reaches the log without ever being
    // serialized into the client-facing response (`AppError.details` is
    // what toErrorResponse exposes; `cause` deliberately is not). One level
    // only, not recursive: a pathological circular cause chain must not
    // recurse forever inside a function whose entire contract is "never
    // throws".
    const cause = (err as { cause?: unknown }).cause;
    if (cause === undefined) return base;
    const causeCode = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
    const causeText =
      // A multi-address connection failure's cause chain, e.g. Node's own
      // ECONNREFUSED across several resolved addresses. AggregateError.message
      // is usually empty, so reading it the same way as an ordinary Error
      // below would discard every constituent error and log just the
      // uninformative string "AggregateError". Expanded one level -- the
      // constituents' own messages, not their own further cause chains --
      // to keep this bounded rather than recursive.
      cause instanceof AggregateError
        ? describeAggregateShallow(cause)
        : cause instanceof Error
          ? causeCode && cause.message !== causeCode
            ? `${causeCode}: ${cause.message}`
            : cause.message
              ? cause.message
              : (causeCode ?? cause.name)
          : cause === null
            ? 'null'
            : typeof cause === 'string'
              ? cause
              : safeTypeOf(cause);
    return `${base} (cause: ${causeText})`;
  }

  if (typeof err === 'string') return err;
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'bigint') return `${err.toString()}n`;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  // String(symbol) is safe; a template literal on one would throw.
  if (typeof err === 'symbol') return err.toString();
  if (typeof err === 'function') return `[function ${err.name || 'anonymous'}]`;

  return safeStringify(err);
}

/**
 * `AggregateError.errors`, one level deep -- each constituent's own
 * message/code, not its own `cause` chain or, if it is itself an
 * AggregateError, its own constituents. Bounded on purpose: this exists to
 * stop `cause instanceof AggregateError` from collapsing to the useless
 * string "AggregateError", not to fully replicate the top-level
 * `describe()` AggregateError branch's unbounded recursion into a `cause`
 * position, where a error->cause->error cycle would need to terminate.
 */
function describeAggregateShallow(agg: AggregateError): string {
  const parts = agg.errors
    .map((e: unknown) => {
      if (e instanceof Error) {
        const code = (e as NodeJS.ErrnoException).code;
        return e.message ? (code ? `${code}: ${e.message}` : e.message) : (code ?? e.name);
      }
      if (typeof e === 'string') return e;
      return safeTypeOf(e);
    })
    .filter(Boolean);
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join('; ') : agg.message || 'AggregateError';
}

/**
 * JSON.stringify throws on circular structures, BigInt values, and any
 * `toJSON` that throws. None of those may escape from an error path.
 */
function safeStringify(value: object): string {
  const seen = new WeakSet<object>();

  const json = JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[circular]';
      seen.add(val);
    }
    return val;
  });

  // stringify returns undefined for values it cannot represent at the top
  // level, such as a bare function or symbol.
  return json ?? safeTypeOf(value);
}

function safeTypeOf(value: unknown): string {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '[unrepresentable]';
  }
}
