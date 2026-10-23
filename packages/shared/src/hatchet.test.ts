import { setTimeout as sleep } from "node:timers/promises";

import { expect, test, vi } from "vitest";

import { splitLogLine, withRunLogs } from "./hatchet";
import { log } from "./log";

/** A run context whose earlier sends take longer to land, so lines sent all at once would arrive reversed. */
function fakeRun() {
  const sent: string[] = [];
  let calls = 0;
  const send = (level: string) => async (message: string) => {
    await sleep(Math.max(0, 30 - 5 * calls++));
    sent.push(`${level} ${message.slice(0, 20)}`);
  };
  const ctx = { logger: { info: send("info"), debug: send("debug"), warn: send("warn"), error: send("error") } } as never;
  return { ctx, sent };
}

test("each run gets its own console and log lines, in order, while runs overlap", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const a = fakeRun();
  const b = fakeRun();
  const task = withRunLogs(async (name: string) => {
    console.log(`${name} 1`);
    console.log("y".repeat(1500));
    await sleep(Math.random() * 5);
    setTimeout(() => console.log(`${name} from a timer`), 1);
    log.info(`${name} 2`);
    await sleep(10);
    console.warn(`${name} 3`, { n: 3 });
    return name;
  });

  console.log("outside any run");
  expect(await Promise.all([task("a", a.ctx), task("b", b.ctx)])).toEqual(["a", "b"]);
  await sleep(300);

  // The 1,500-character line goes out in two parts, as Hatchet drops lines over 1,000.
  const lines = (name: string) => [`info ${name} 1`, `info [part 1/2] ${"y".repeat(9)}`, `info [part 2/2] ${"y".repeat(9)}`, `info ${name} 2`, `info ${name} from a timer`, `warn ${name} 3 { n: 3 }`];
  expect(a.sent).toEqual(lines("a"));
  expect(b.sent).toEqual(lines("b"));
  vi.restoreAllMocks();
});

test("a line too long for Hatchet goes out in parts it accepts, losing nothing", () => {
  expect(splitLogLine("x".repeat(1000))).toEqual(["x".repeat(1000)]);

  const frames = Array.from({ length: 60 }, (_, i) => `    at frame${i} (file:///app/module-${i}.js:1:1)`);
  const line = ["Error: boom", ...frames].join("\n");
  const parts = splitLogLine(line);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(1000);
  expect(parts[0]).toMatch(/^\[part 1\/\d\] Error: boom/);
  const bodies = parts.map((part) => part.replace(/^\[part \d+\/\d+\] /, ""));
  // Cut at newlines, not mid-frame.
  for (const body of bodies.slice(0, -1)) expect(body.endsWith("\n")).toBe(true);
  expect(bodies.join("")).toBe(line);
});
