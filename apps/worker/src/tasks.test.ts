import { configFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { taskOptions } from "./tasks";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a code change's task: the analysis's time limit and a few minutes, a few at once on the whole server, and a day to wait its turn", () => {
  expect(taskOptions("codeChange")).toMatchObject({
    name: "code-change",
    retries: 4,
    executionTimeout: "15m",
    scheduleTimeout: "24h",
    concurrency: [
      // One run of a code change at a time (a retry waits for the run before it)…
      { expression: "input.codeChangeId", maxRuns: 1 },
      // …and a few of them on the whole server.
      { expression: "'code-change'", maxRuns: 4 },
    ],
  });
  vi.stubEnv("TUTI_CONFIG", configFile({ autopilot: { limits: { timeoutMinutes: 20, concurrentAnalyses: 2 } } }));
  expect(taskOptions("codeChange")).toMatchObject({ executionTimeout: "25m", concurrency: [{ maxRuns: 1 }, { maxRuns: 2 }] });
});

test("other jobs keep Hatchet's time limits, and their own key's one run at a time", () => {
  const other = taskOptions("postCreated", { name: "post-created", concurrencyKey: "input.postId" });
  expect(other).not.toHaveProperty("executionTimeout");
  expect(other).not.toHaveProperty("scheduleTimeout");
  expect(other).toMatchObject({ name: "post-created", retries: 3, concurrency: { expression: "input.postId", maxRuns: 1 } });
});

test("an import's run may take fifteen minutes (ten of pages, and five for its last), one at a time per import", () => {
  expect(taskOptions("importStep")).toMatchObject({ name: "import-step", retries: 0, executionTimeout: "15m", concurrency: { expression: "input.importId", maxRuns: 1 } });
  // Indexing a large API reference embeds and converts thousands of operations: longer than Hatchet's 60 seconds.
  expect(taskOptions("apiReferenceChanged")).toMatchObject({ name: "api-reference-changed", executionTimeout: "10m" });
});

test("syncing API references from their URLs may take ten minutes", () => {
  expect(taskOptions("syncApiReferences")).toMatchObject({ name: "sync-api-references", executionTimeout: "10m", on: { cron: "41 * * * *" } });
});
