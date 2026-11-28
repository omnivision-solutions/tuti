// Run by vitest.setup.test.ts, before 2-checks: changes what a test file can change, and undoes none of it.
import { expect, test, vi } from "vitest";

process.env.TUTI_LEAK_IMPORT = "set at import";
process.env.NODE_ENV = "production";
vi.stubEnv("TUTI_LEAK_STUB", "stubbed");
vi.stubGlobal("tutiLeak", "stubbed");

test("leaves the environment, a global, fake timers and a spy changed", () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect([process.env.TUTI_LEAK_IMPORT, process.env.TUTI_LEAK_STUB, (globalThis as { tutiLeak?: string }).tutiLeak, vi.isFakeTimers(), vi.isMockFunction(console.warn)]).toEqual(["set at import", "stubbed", "stubbed", true, true]);
});
