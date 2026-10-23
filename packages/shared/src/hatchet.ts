import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import { HatchetClient, type Context } from "@hatchet-dev/typescript-sdk";

let client: HatchetClient | undefined;

/**
 * Lazily created so importing this module never needs Hatchet credentials
 * (e.g. during `next build`). Reads HATCHET_CLIENT_* env vars.
 */
export function getHatchet(): HatchetClient {
  client ??= HatchetClient.init();
  return client;
}

// Runs share the worker process, so console can't be swapped per run. Instead
// it's patched once, and each line goes to the run whose async context wrote
// it: AsyncLocalStorage follows awaits, timers and sockets started inside the
// run. The one way to break it is a queue shared by all runs (e.g. a
// module-level p-limit): its callbacks run in whichever run drained it.
type Level = "log" | "info" | "debug" | "warn" | "error";
type RunLog = { ctx: Context<any>; sending: Promise<void> };
const currentRun = new AsyncLocalStorage<RunLog>();

// The SDK drops (not truncates) any line over 1,000 characters, and those are
// often the ones that matter, like stack traces. So a long line goes out in
// numbered parts, cut at a newline where one is close.
const MAX_LOG_CHARS = 1000;
const PART_BODY_CHARS = MAX_LOG_CHARS - "[part 999/999] ".length;

export function splitLogLine(line: string): string[] {
  if (line.length <= MAX_LOG_CHARS) return [line];
  const bodies: string[] = [];
  for (let start = 0; start < line.length; ) {
    let end = Math.min(start + PART_BODY_CHARS, line.length);
    if (end < line.length) {
      const newline = line.lastIndexOf("\n", end - 1);
      if (newline > start + PART_BODY_CHARS / 2) end = newline + 1;
      // Never split a surrogate pair.
      else if (/[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
    }
    bodies.push(line.slice(start, end));
    start = end;
  }
  return bodies.map((body, i) => `[part ${i + 1}/${bodies.length}] ${body}`);
}

// The SDK stamps each line with the time it's sent, so lines sent at once can
// show in any order. A run's lines go out one after another instead; a send
// that hangs is given up on so it can't hold the rest back.
const SEND_TIMEOUT_MS = 10_000;

function sendInOrder(run: RunLog, level: Level, parts: string[]) {
  const send = (part: string) =>
    level === "error" ? run.ctx.logger.error(part)
    : level === "warn" ? run.ctx.logger.warn(part)
    : level === "debug" ? run.ctx.logger.debug(part)
    : run.ctx.logger.info(part);
  // Outside the run's context: the SDK logger echoes through console, and
  // inside it that echo would come back here forever.
  run.sending = run.sending.then(() =>
    currentRun.exit(async () => {
      for (const part of parts) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.resolve(send(part)).catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SEND_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
        clearTimeout(timer);
      }
    }),
  );
}

let patched = false;
function routeConsoleToRuns() {
  if (patched) return;
  patched = true;
  for (const level of ["log", "info", "debug", "warn", "error"] satisfies Level[]) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const run = currentRun.getStore();
      if (run) sendInOrder(run, level, splitLogLine(format(...args)));
      original(...args);
    };
  }
}

/**
 * Wraps a task so what it writes with console.log, info, debug, warn and error
 * (and `log`, and console.trace, table and assert, which call those) lands in
 * its run's logs in Hatchet. console.dir writes past them; nothing here uses it.
 */
export function withRunLogs<I, O, C extends Context<any>>(fn: (input: I, ctx: C) => Promise<O>): (input: I, ctx: C) => Promise<O> {
  return (input, ctx) => {
    // On the first run, so processes that only enqueue (web) are never patched.
    routeConsoleToRuns();
    return currentRun.run({ ctx, sending: Promise.resolve() }, () => fn(input, ctx));
  };
}
