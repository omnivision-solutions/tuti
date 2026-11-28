// Run by vitest.setup.test.ts, between 1-leaves and 2-checks: changes the environment, a global and the timers, then
// fails to load, so its afterAll never runs.
import { vi } from "vitest";

process.env.TUTI_LEAK_LOAD = "set by a file that failed to load";
vi.stubGlobal("tutiLeak", "stubbed by a file that failed to load");
vi.useFakeTimers();
throw new Error("fails to load");
