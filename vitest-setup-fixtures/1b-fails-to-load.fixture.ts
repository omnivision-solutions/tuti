// Run by vitest.setup.test.ts, between 1-leaves and 2-checks: sets the environment, then fails to load, so its afterAll
// never runs.
process.env.TUTI_LEAK_LOAD = "set by a file that failed to load";
throw new Error("fails to load");
