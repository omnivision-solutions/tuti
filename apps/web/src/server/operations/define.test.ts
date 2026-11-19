import { expect, test } from "vitest";
import { z } from "zod";

import { defineOperation } from "./define";

// Under the tests every run's result is checked against the operation's output, so the spec and MCP's outputSchema
// stay whole wherever an operation runs.
test("a run whose result isn't what its output says fails under the tests", async () => {
  const returning = (value: unknown) =>
    defineOperation({
      name: "test.check",
      title: "Check",
      summary: "Returns what it's given",
      method: "GET",
      path: "/check",
      scope: "read",
      access: "team",
      input: z.object({}),
      output: z.object({ a: z.string(), when: z.string() }).describe("A value"),
      run: async () => value as { a: string; when: string },
    });
  const context = { actor: { kind: "user" as const, userId: "u" }, projectId: "p" };
  const when = new Date("2026-11-19T12:00:00Z");
  // A date goes out as its ISO string, as the API sends it.
  await expect(returning({ a: "x", when }).run(context, {})).resolves.toEqual({ a: "x", when });
  await expect(returning({ a: "x", when, extra: 1 }).run(context, {})).rejects.toThrow("test.check returned what its output doesn't say: fields it doesn't declare");
  await expect(returning({ a: 1, when }).run(context, {})).rejects.toThrow("test.check returned what its output doesn't say");
  await expect(returning({ when }).run(context, {})).rejects.toThrow("test.check returned what its output doesn't say");
});
