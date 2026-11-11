import { expect, test } from "./fixtures";

// Both journeys must use the same worker/browser to detect sessions left by earlier tests.
test.describe("journey browser lifetime", () => {
  test.describe.configure({ mode: "serial" });

  test("a journey can open multiple independent browser sessions", async ({ browser }) => {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext();
      await context.newPage();
    }
    expect(browser.contexts()).toHaveLength(2);
  });

  test("the next journey starts without earlier sessions or pages", async ({ browser }) => {
    expect(browser.contexts()).toHaveLength(0);
  });
});
