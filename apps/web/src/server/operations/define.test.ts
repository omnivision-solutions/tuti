import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test, vi } from "vitest";
import { z } from "zod";

// Loading the operations loads the app's auth, which reads its addresses: placeholders (unit tests have none).
vi.hoisted(() => {
  process.env.APP_URL = "http://tuti.localhost:3100";
  process.env.PORTAL_URL_TEMPLATE = "http://{project}.localhost:3100";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
});

import { updateAiFirst } from "./ai-first";
import { checked, defineOperation } from "./define";
import { allOperations, operations } from "./index";

const definition = (value: unknown) => ({
  name: "test.check" as const,
  title: "Check",
  summary: "Returns what it's given",
  method: "GET" as const,
  path: "/check",
  scope: "read" as const,
  access: "team" as const,
  input: z.object({}),
  output: z.object({ a: z.string(), when: z.string() }).describe("A value"),
  run: async () => value as { a: string; when: string },
});

// Under the tests every run's result is checked against the operation's output, so the spec and MCP's outputSchema
// stay whole wherever an operation runs.
test("a run whose result isn't what its output says fails under the tests", async () => {
  const returning = (value: unknown) => checked(definition(value));
  const context = { actor: { kind: "user" as const, userId: "u" }, projectId: "p" };
  const when = new Date("2026-11-19T12:00:00Z");
  // A date goes out as its ISO string, as the API sends it.
  await expect(returning({ a: "x", when })(context, {})).resolves.toEqual({ a: "x", when });
  await expect(returning({ a: "x", when, extra: 1 })(context, {})).rejects.toThrow("test.check returned what its output doesn't say: fields it doesn't declare");
  await expect(returning({ a: 1, when })(context, {})).rejects.toThrow("test.check returned what its output doesn't say");
  await expect(returning({ when })(context, {})).rejects.toThrow("test.check returned what its output doesn't say");
});

// Only the router (procedureFor) and runOperation run an operation, both behind the access, scope and owner check.
test("an operation's run is out of reach", () => {
  expect((defineOperation(definition({})) as { run?: unknown }).run).toBeUndefined();
  expect((updateAiFirst as { run?: unknown }).run).toBeUndefined();
  expect((allOperations[0] as { run?: unknown }).run).toBeUndefined();
  expect(allOperations.filter((operation) => "run" in operation)).toEqual([]);
  expect(operations.length).toBeGreaterThan(0);
});

// legacyRun skips the check: only the callers that check for themselves until they move (REST and MCP until T2,
// operations/run.ts's call until T12) may use it.
test("legacyRun has only its listed callers", () => {
  const src = fileURLToPath(new URL("../..", import.meta.url));
  const files = execFileSync("grep", ["-rl", "--include=*.ts", "--include=*.tsx", "legacyRun", "."], { cwd: src, encoding: "utf8" })
    .trim()
    .split("\n")
    .map((file) => file.replace(/^\.\//, ""))
    .filter((file) => !/\.test\.tsx?$/.test(file));
  expect(files.sort()).toEqual(["app/api/mcp/route.ts", "app/api/v1/[...path]/route.ts", "server/operations/define.ts", "server/operations/run.ts"]);
});
