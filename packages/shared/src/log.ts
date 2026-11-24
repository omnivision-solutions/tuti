type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

/**
 * An error as plain fields (JSON.stringify would drop its message and stack), with its `code` and its causes: fetch
 * says only "fetch failed", the reason (ECONNREFUSED, a certificate) is its cause's. A few levels deep, so a cycle ends.
 */
function errorFields(error: Error, depth = 0): Fields {
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(code !== undefined && { code }),
    ...(cause !== undefined && { cause: cause instanceof Error ? (depth < 4 ? errorFields(cause, depth + 1) : cause.message) : cause }),
  };
}

function serialize(fields: Fields | undefined): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = value instanceof Error ? errorFields(value) : value;
  }
  return out;
}

/**
 * One JSON line that never throws: BigInts become strings, repeated objects
 * "[Circular]", and if the fields can't be read at all (e.g. a throwing getter)
 * the entry keeps its metadata. Metadata goes last, so fields can't overwrite it.
 */
function toJson(fields: Fields | undefined, meta: { time: string; level: Level; message: string }): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify({ ...serialize(fields), ...meta }, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({ ...meta, fieldsError: true });
  }
}

function write(level: Level, message: string, fields?: Fields) {
  const args =
    process.env.NODE_ENV === "production"
      ? // One JSON object per line, for whatever collects the logs (Coolify, Docker, a log shipper).
        [toJson(fields, { time: new Date().toISOString(), level, message })]
      : [message, ...(fields ? [fields] : [])];
  // Through console (info to stdout, warn and error to stderr), so a worker run's lines reach its Hatchet logs too.
  // eslint-disable-next-line no-console -- the one place that writes to the console
  console[level](...args);
}

/** Server and worker logging. Use this instead of console (a test checks). */
export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
