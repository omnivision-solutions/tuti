import { randomInt, randomUUID } from "node:crypto";

import { type Browser, expect, type Page } from "@playwright/test";

import { APP_URL, portalUrl } from "./env";

export type TestPage = Page & { email: string; ip: string };

/**
 * A new browser session for one person. Each gets its own client IP (Better Auth
 * reads a single-address X-Forwarded-For), so journeys running in parallel don't
 * share its per-IP sign-up limit.
 */
export async function newPerson(browser: Browser, baseUrl: string): Promise<Page & { ip: string }> {
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const context = await browser.newContext({ baseURL: baseUrl, extraHTTPHeaders: { "x-forwarded-for": ip } });
  return Object.assign(await context.newPage(), { ip });
}

/** A new browser session that signed up at `baseUrl` (the app or a portal). */
export async function signUp(
  browser: Browser,
  baseUrl: string,
  name: string,
  email = `e2e-${randomUUID()}@example.com`,
): Promise<TestPage> {
  const page = await newPerson(browser, baseUrl);
  await page.goto("/sign-up");
  await fillSignUp(page, name, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-up"));
  return Object.assign(page, { email });
}

/** Fills and submits the sign-up form on the current page (the email may be prefilled). */
export async function fillSignUp(page: Page, name: string, email?: string) {
  await page.getByLabel("Name").fill(name);
  if (email) {
    await page.getByLabel("Email").fill(email);
  }
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign up" }).click();
}

/** Creates a project from /app/new and waits for its dashboard. */
export async function createProject(page: Page, name: string, slug: string) {
  await page.goto("/app/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("URL").fill(slug);
  // It says the portal's address as it's typed.
  await expect(page.getByText(`Your portal will be ${new URL(portalUrl(slug)).host}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/app/${slug}`);
}

/** A read and write API key for project `slug`, made in its settings, and a call to the API with it (a POST unless `method` says otherwise). */
export async function apiFor(team: Page, slug: string) {
  await team.goto(`/app/${slug}/settings/developers`);
  await team.getByRole("textbox", { name: "Key name" }).fill("Help test");
  await team.getByRole("combobox", { name: "What the key can do" }).click();
  await team.getByRole("option", { name: "Read and write" }).click();
  await team.getByRole("button", { name: "Create key" }).click();
  const shown = team.getByRole("alert").filter({ hasText: "Copy the key for Help test now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  return async (path: string, body: object, method = "POST") => {
    const response = await fetch(`${APP_URL}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as { slug: string };
  };
}
