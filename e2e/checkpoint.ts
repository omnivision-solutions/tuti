import { basename, join } from "node:path";

import type { Page, TestInfo } from "@playwright/test";

/** Where journeys save their screenshots; CI posts them on the pull request. */
export const SCREENSHOTS_DIR = "e2e-screenshots";

/** Lowercase words joined by dashes, the only names scripts/publish-screenshots.sh posts. */
const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");

/**
 * Numbered full-page screenshots of a journey, in `e2e-screenshots/<spec>-<test title>/`
 * and in the HTML report, so a reviewer can see each step without running it.
 */
export function checkpoints(testInfo: TestInfo) {
  const folder = slug(`${basename(testInfo.file, ".spec.ts")} ${testInfo.title}`, 80);
  let step = 0;
  return async (page: Page, name: string) => {
    step += 1;
    const file = `${String(step).padStart(2, "0")}-${slug(name, 60) || "step"}.png`;
    const path = join(SCREENSHOTS_DIR, folder, file);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(file, { path, contentType: "image/png" });
  };
}
