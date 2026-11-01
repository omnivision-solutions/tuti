import { randomInt, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

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

/** Creates a project from /app/new, skips the first run's setup and waits for its Home (`portal`: the portal's address on the page's server). */
export async function createProject(page: Page, name: string, slug: string, portal = portalUrl) {
  await page.goto("/app/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("URL").fill(slug);
  // It says the portal's address as it's typed.
  await expect(page.getByText(`Your portal will be ${new URL(portal(slug)).host}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create project" }).click();
  await skipSetup(page, slug);
}

/** The first run's setup, right after "Create project" (first-run.spec.ts goes through it): skipped, to Home. */
export async function skipSetup(page: Page, slug: string) {
  await page.waitForURL(`**/app/${slug}/setup`);
  await page.getByRole("link", { name: "Skip setup" }).click();
  await page.waitForURL(`**/app/${slug}`);
}

/** A read and write API key for project `slug`, made in its settings, and a call to the API with it (a POST unless `method` says otherwise). */
/**
 * Posts feedback from the board's dialog and waits for it on the board. Saving runs the post's
 * jobs (inline here) before it answers, so it gets longer than an assertion's usual 5 seconds.
 */
export async function postFeedback(page: Page, title: string) {
  await page.getByRole("button", { name: "Submit post" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Submit post" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: 15_000 });
}

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

/** A grey PNG `width` by `height` pixels. */
export function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => (bytes.reduce((c, byte) => crcTable[(c ^ byte) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  // Each row: filter byte 0, then a grey pixel per column.
  const rows = Buffer.alloc((width + 1) * height, 0x88);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
