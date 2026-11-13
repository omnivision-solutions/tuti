import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, portalUrl, SERVER_LOG } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("someone buying a licence sees which installation and project it's for, and buys it with Stripe", async ({ page }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const installation = `e2e-installation-${randomUUID().slice(0, 8)}`;
  const project = `e2e-project-${randomUUID().slice(0, 8)}`;
  // Where "Get a licence" in Branding → Powered by tuti goes, on tuti.so (the cloud's server here: its billing file prices it).
  await page.goto(`${CLOUD_URL}/app/license?installation=${installation}&project=${project}`);
  await expect(page.getByRole("heading", { name: 'Remove "Powered by tuti"' })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: installation })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: project })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy for $588 a year" })).toBeVisible();
  // Buying is under tuti.so's terms (the marketing site's pages, on the same domain).
  await expect(page.getByText("By buying, you agree to the Terms of Service and Privacy Policy.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  await checkpoint(page, "license-page");

  // Stripe's page (the fake), then back, licensed: the installation's next check gets its key.
  await page.getByRole("button", { name: "Buy for $49 a month" }).click();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await page.waitForURL(/\/license\?.*paid=1/);
  await expect(page.getByRole("status")).toContainText("This project is licensed.");
  await expect(page.getByRole("status")).toContainText("To cancel it, change the card or get invoices, email hello@tuti.so.");
  await expect(page.getByRole("button", { name: "Buy for $49 a month" })).toBeHidden();
  await checkpoint(page, "license-page-licensed");

  // Without the ids, it says where to start.
  await page.goto(`${CLOUD_URL}/app/license?installation=${installation}`);
  await expect(page.getByText("Open this page from your Tuti")).toBeVisible();
});

// A portal page renews the project's licence key (at most daily) without tying it to the request: once a request closes,
// Next.js's after() made the rest of its render throw on headers() and cookies(), a stack in the server's log each time.
test("a reader leaving a portal page as it loads leaves no errors in the server's log", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/feedback/feature-requests");

  // Requests dropped at later and later points of the page's render (somewhere in it, however fast the machine).
  await reader.evaluate(async () => {
    for (let ms = 0; ms < 300; ms += 10) {
      const leaving = new AbortController();
      const request = fetch("/feedback/feature-requests", { signal: leaving.signal }).then((response) => response.text()).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, ms));
      leaving.abort();
      await request;
    }
    // The renders they leave behind finish.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  });
  expect(readFileSync(SERVER_LOG, "utf8")).not.toContain("inside `after()`");
});
