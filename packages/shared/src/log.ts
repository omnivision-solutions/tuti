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

function write(level: Level, message: string, fields?: Fields) {
  if (process.env.NODE_ENV === "production") {
    // One JSON object per line, for whatever collects the logs (Coolify, Docker, a log shipper).
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...serialize(fields) });
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
