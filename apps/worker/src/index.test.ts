import { expect, test, vi } from "vitest";

const { getHatchet, waited } = vi.hoisted(() => {
  let release = () => {};
  const waited = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
  const getHatchet = vi.fn(() => ({ task: vi.fn(), worker: vi.fn(async () => ({ start: vi.fn() })) }));
  return { getHatchet, waited };
});
vi.mock("./migrations", () => ({ waitForMigration: vi.fn(() => waited.promise) }));
vi.mock("@tuti/shared/hatchet", () => ({ getHatchet }));
vi.mock("@tuti/jobs", () => ({ handlers: {} }));

test("a built worker takes no jobs until the database has its migrations", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://test");
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.example.com");
  vi.stubEnv("TUTI_SCHEMA_MIGRATION", "20261019120000_ship_emails");
  const started = import("./index");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(getHatchet).not.toHaveBeenCalled();

  waited.release();
  await started;
  expect(getHatchet).toHaveBeenCalled();
});
