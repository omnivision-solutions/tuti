// Run by vitest.setup.test.ts in the same worker, after 1-leaves: none of its changes are left.
import { expect, test, vi } from "vitest";

test("sees none of the file before's changes", () => {
  expect({ importEnv: process.env.TUTI_LEAK_IMPORT, nodeEnv: process.env.NODE_ENV, stubEnv: process.env.TUTI_LEAK_STUB, global: (globalThis as { tutiLeak?: string }).tutiLeak, fakeTimers: vi.isFakeTimers(), spy: vi.isMockFunction(console.warn) }).toEqual({
    importEnv: undefined,
    nodeEnv: "test",
    stubEnv: undefined,
    global: undefined,
    fakeTimers: false,
    spy: false,
  });
});
