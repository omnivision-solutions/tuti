import { expect, test, vi } from "vitest";

const { getHatchet, fillArticleVectors, waited } = vi.hoisted(() => {
  let release = () => {};
  let called = () => {};
  const waited = {
    promise: new Promise<void>((resolve) => (release = resolve)),
    release: () => release(),
    /** Resolves once the worker is waiting for its migrations. */
    reached: new Promise<void>((resolve) => (called = resolve)),
    call: () => called(),
  };
  const getHatchet = vi.fn(() => ({ task: vi.fn(), worker: vi.fn(async () => ({ start: vi.fn() })) }));
  const fillArticleVectors = vi.fn(async () => {});
  return { getHatchet, fillArticleVectors, waited };
});
vi.mock("./migrations", () => ({
  waitForMigration: vi.fn(() => {
    waited.call();
    return waited.promise;
  }),
}));
vi.mock("@tuti/shared/hatchet", () => ({ getHatchet, withRunLogs: (fn: unknown) => fn }));
vi.mock("@tuti/jobs", () => ({ handlers: {}, fillArticleVectors }));
vi.mock("@tuti/db", () => ({ prisma: {} }));

test("a built worker takes no jobs until the database has its migrations, then fills articles' vectors", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://test");
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.example.com");
  vi.stubEnv("TUTI_SCHEMA_MIGRATION", "20261019120000_ship_emails");
  const started = import("./index");
  await waited.reached;
  expect(getHatchet).not.toHaveBeenCalled();
  expect(fillArticleVectors).not.toHaveBeenCalled();

  waited.release();
  await started;
  expect(getHatchet).toHaveBeenCalled();
  // What the previous release's worker embedded during the deploy (see fillArticleVectors).
  expect(fillArticleVectors).toHaveBeenCalledTimes(1);
});
