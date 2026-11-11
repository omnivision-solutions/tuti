import { test as base } from "@playwright/test";

export * from "@playwright/test";

/** Sessions opened through browser.newContext() belong to the journey, just like the built-in page fixture. */
export const test = base.extend<{ journeyContexts: void }>({
  journeyContexts: [async ({ browser }, use) => {
    try {
      await use();
    } finally {
      // Close after hooks while Playwright still records failures, screenshots and traces.
      await Promise.all(browser.contexts().map((context) => context.close()));
    }
  }, { auto: true }],
});
