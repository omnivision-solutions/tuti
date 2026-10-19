import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { log } from "./log";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("in production", () => {
  test("writes one JSON line per entry, errors with their message and stack", () => {
    vi.stubEnv("NODE_ENV", "production");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log.error("Sending the invite email failed", { error: new Error("SMTP down"), postId: "p1" });

    const entry = JSON.parse(String(stderr.mock.calls[0]![0]));
    expect(entry).toMatchObject({
      level: "error",
      message: "Sending the invite email failed",
      postId: "p1",
      error: { name: "Error", message: "SMTP down" },
    });
    expect(entry.error.stack).toContain("SMTP down");
    expect(Date.parse(entry.time)).not.toBeNaN();
  });

  test("fields can't overwrite the level or message, and odd values never make logging throw", () => {
    vi.stubEnv("NODE_ENV", "production");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const throwing = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });

    log.error("Failed", { level: "info", message: "spoofed", count: 10n, cyclic });
    expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
      level: "error",
      message: "Failed",
      count: "10",
      cyclic: { name: "loop", self: "[Circular]" },
    });

    expect(() => log.error("Still logged", { throwing })).not.toThrow();
    expect(JSON.parse(String(stderr.mock.calls[1]![0]))).toMatchObject({ message: "Still logged", fieldsError: true });
    // A throwing getter on the fields object itself, too.
    expect(() => log.error("Also logged", throwing)).not.toThrow();
    expect(JSON.parse(String(stderr.mock.calls[2]![0]))).toMatchObject({ message: "Also logged", fieldsError: true });
  });

  test("info goes to stdout", () => {
    vi.stubEnv("NODE_ENV", "production");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log.info("Email not sent", { to: "a@example.com" });
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ level: "info", to: "a@example.com" });
  });
});

test("server and worker code logs through `log`, not console", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!["node_modules", "generated", "test", "scripts"].includes(name)) walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        sources.push(path);
      }
    }
  };
  for (const dir of ["apps", "packages"]) {
    for (const pkg of readdirSync(join(root, dir))) {
      const src = join(root, dir, pkg, "src");
      if (statSync(join(root, dir, pkg)).isDirectory() && readdirSync(join(root, dir, pkg)).includes("src")) walk(src);
    }
  }
  const offenders = sources
    .filter((file) => !file.endsWith(join("shared", "src", "log.ts")))
    .filter((file) => /\bconsole\.(log|info|warn|error|debug)\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file));
  expect(offenders).toEqual([]);
});
