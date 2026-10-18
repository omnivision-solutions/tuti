import type { Page, TestInfo } from "@playwright/test";

/**
 * Numbered full-page screenshots of a journey, attached to the HTML report
 * (and uploaded by CI), so a reviewer can see each step without running it.
 */
export function checkpoints(testInfo: TestInfo) {
  let step = 0;
  return async (page: Page, name: string) => {
    step += 1;
    const file = `${String(step).padStart(2, "0")}-${name}.png`;
    const path = testInfo.outputPath(file);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(file, { path, contentType: "image/png" });
  };
}
