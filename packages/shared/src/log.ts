type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

/** Errors become plain fields; JSON.stringify would drop their message and stack. */
function serialize(fields: Fields | undefined): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}

/** JSON that never throws: BigInts become strings, repeated objects become "[Circular]". */
function toJson(entry: Fields): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(entry, (_key, value: unknown) => {
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
    // e.g. a getter that throws: still log the message, never fail the caller.
    return JSON.stringify({ time: entry.time, level: entry.level, message: entry.message, fieldsError: true });
  }
}

function write(level: Level, message: string, fields?: Fields) {
  if (process.env.NODE_ENV === "production") {
    // One JSON object per line, for whatever collects the logs (Coolify, Docker, a log shipper).
    // Logger metadata goes last, so fields can't overwrite it.
    const line = toJson({ ...serialize(fields), time: new Date().toISOString(), level, message });
    (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
    return;
  }
  // eslint-disable-next-line no-console -- the one place that writes to the console
  console[level](message, ...(fields ? [fields] : []));
}

/** Server and worker logging. Use this instead of console (a test checks). */
export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
