import { resetCodeChangesSettings } from "@tuti/shared";
import { afterEach, expect, test, vi } from "vitest";

import { taskOptions } from "./tasks";

afterEach(() => {
  vi.unstubAllEnvs();
  resetCodeChangesSettings();
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
  vi.stubEnv("CODE_CHANGES_LIMITS_TIMEOUT_MINUTES", "20");
  vi.stubEnv("CODE_CHANGES_LIMITS_CONCURRENT_ANALYSES", "2");
  resetCodeChangesSettings();
  expect(taskOptions("codeChange")).toMatchObject({ executionTimeout: "25m", concurrency: [{ maxRuns: 1 }, { maxRuns: 2 }] });
});

test("other jobs keep Hatchet's time limits, and their own key's one run at a time", () => {
  const other = taskOptions("postCreated", { name: "post-created", concurrencyKey: "input.postId" });
  expect(other).not.toHaveProperty("executionTimeout");
  expect(other).not.toHaveProperty("scheduleTimeout");
  expect(other).toMatchObject({ name: "post-created", retries: 3, concurrency: { expression: "input.postId", maxRuns: 1 } });
});

test("an import's page may take five minutes (Featurebase's rate limit can hold it up), one at a time per import", () => {
  expect(taskOptions("importStep")).toMatchObject({ name: "import-step", retries: 0, executionTimeout: "5m", concurrency: { expression: "input.importId", maxRuns: 1 } });
});
