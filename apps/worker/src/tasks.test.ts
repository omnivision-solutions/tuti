import { EventEmitter } from "node:events";

import { configFile } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { stopSignal, taskFn, taskOptions } from "./tasks";

const { importStep, translateArticle } = vi.hoisted(() => ({
  importStep: vi.fn(async (_input: unknown, _log: unknown, stop: () => boolean) => ({ stopped: stop() })),
  translateArticle: vi.fn(async (_input: unknown, _log: unknown, run: { lastTry: boolean }) => run),
}));
vi.mock("@tuti/jobs", () => ({ importStep, translateArticle, codeChange: vi.fn(), handlers: {} }));

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

test("an import's run may take twenty minutes (ten of pages, and a worst-case last page's read and saves), one at a time per import and ten on the whole server, the rest waiting up to an hour", () => {
  expect(taskOptions("importStep")).toMatchObject({
    name: "import-step",
    retries: 0,
    executionTimeout: "20m",
    scheduleTimeout: "1h",
    concurrency: [
      { expression: "input.importId", maxRuns: 1 },
      { expression: "'import-step'", maxRuns: 10 },
    ],
  });
  // Indexing a large API reference embeds and converts thousands of operations: longer than Hatchet's 60 seconds.
  expect(taskOptions("apiReferenceChanged")).toMatchObject({ name: "api-reference-changed", executionTimeout: "10m" });
});

test("a screenshot run may take forty minutes (two tries of the agent and keeping its images), three at once on the whole server, the rest waiting up to an hour", () => {
  expect(taskOptions("screenshotRun")).toMatchObject({ name: "screenshot-run", retries: 0, executionTimeout: "40m", scheduleTimeout: "1h", concurrency: [{ expression: "'screenshot-run'", maxRuns: 3 }] });
});

test("the team's email and push about a message run a few at once each, so waiting for translations can't fill the worker's slots", () => {
  expect(taskOptions("conversationMessage")).toMatchObject({ name: "conversation-message", concurrency: [{ expression: "'conversation-message'", maxRuns: 4 }] });
  expect(taskOptions("conversationPush")).toMatchObject({ name: "conversation-push", retries: 2, concurrency: [{ expression: "'conversation-push'", maxRuns: 4 }] });
  // The translations they wait for aren't capped by them.
  expect(taskOptions("translateMessage")).not.toHaveProperty("concurrency");
});

test("syncing API references from their URLs may take ten minutes", () => {
  expect(taskOptions("syncApiReferences")).toMatchObject({ name: "sync-api-references", executionTimeout: "10m", on: { cron: "41 * * * *" } });
});

test("an import's run is told to stop going from page to page once the worker is asked to stop, or Hatchet has given up on the run", async () => {
  const signals = new EventEmitter();
  const stopping = stopSignal(signals as never);
  const run = (cancelled: boolean) => taskFn("importStep", 0, stopping)({ importId: "import-1" }, { retryCount: () => 0, cancelled });
  expect(await run(false)).toEqual({ stopped: false });
  expect(await run(true)).toEqual({ stopped: true });
  // A deploy stops the worker with SIGTERM; Ctrl-C is SIGINT.
  signals.emit("SIGTERM");
  expect(await run(false)).toEqual({ stopped: true });
  const interrupted = new EventEmitter();
  const interrupt = stopSignal(interrupted as never);
  interrupted.emit("SIGINT");
  expect(interrupt()).toBe(true);
});

test("an article's translation may take ten minutes and wait a day for its turn, one run per page and language, told which try is its last", async () => {
  expect(taskOptions("translateArticle")).toMatchObject({
    name: "translate-article",
    retries: 3,
    executionTimeout: "10m",
    scheduleTimeout: "24h",
    concurrency: [
      { expression: "input.articleId + ':' + input.language", maxRuns: 1 },
      // …and a few on the whole server.
      { expression: "'translate-article'", maxRuns: 4 },
    ],
  });
  const run = (retryCount: number) => taskFn("translateArticle", 3, () => false)({ articleId: "a", language: "de" }, { retryCount: () => retryCount, cancelled: false });
  expect(await run(2)).toEqual({ lastTry: false });
  expect(await run(3)).toEqual({ lastTry: true });
});
