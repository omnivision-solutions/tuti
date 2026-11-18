import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** Groups Posts, Comments and Admin, a server with no host, and four kinds of things the reader can't read (two of one). */
const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Acme API", version: "1.4.0" },
  servers: [{ url: "/v1" }],
  paths: {
    "/posts": {
      get: {
        tags: ["Posts"],
        summary: "List posts",
        responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } }, "400 - Bad Request": { description: "Bad" } },
      },
      post: { tags: ["Posts"], summary: "Create a post", responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Gone" } } } } } },
    },
    "/comments": { get: { tags: ["Comments"], responses: { "200": { description: "OK" } } } },
    "/admin/purge": { delete: { tags: ["Admin"], summary: "Purge everything", responses: { "204": { description: "Gone" } } } },
  },
});

test("An API reference's Settings: its name and address, base address, tree, group order and Try it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/api-references", { name: "API reference", spec: SPEC });
  await team.setViewportSize({ width: 1280, height: 900 });

  // Settings is the second tab under the header.
  await team.goto(`/app/${slug}/docs/references/api-reference`);
  const tabs = team.getByRole("navigation", { name: "API reference" });
  await expect(tabs.getByRole("link", { name: "Endpoints 4" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Settings" }).click();
  await team.waitForURL(`**/docs/references/api-reference/settings`);
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");

  // Where it's read from.
  const source = team.getByRole("region", { name: "Source" });
  await expect(source).toContainText("Uploaded file");
  await expect(source).toContainText("OpenAPI · version 1.4.0");
  await expect(source.getByRole("button", { name: "Upload new version" })).toBeVisible();

  // What couldn't be read: a row per kind, with how many, and where once it's opened.
  const warnings = team.getByRole("region", { name: "What couldn’t be read" });
  await expect(warnings.getByRole("listitem").filter({ hasText: /^\d/ })).toHaveCount(4);
  const unknownRef = warnings.locator("li").filter({ hasText: "A reference points at nothing in the spec" }).first();
  await expect(unknownRef.locator("[data-slot=badge]")).toHaveText(/^2/);
  await expect(unknownRef.getByText("POST /posts › responses › 201")).toBeHidden();
  await unknownRef.getByText("Show where").click();
  await expect(unknownRef.getByText("POST /posts › responses › 201")).toBeVisible();
  await expect(warnings).toContainText("An operation has no summary or operationId");
  // The pane scrolls, not the page: a tall window shows all of it.
  const shoot = async (name: string, width: number, height: number) => {
    await team.setViewportSize({ width, height });
    await checkpoint(team, name, { fullPage: false });
    await team.setViewportSize({ width: 1280, height: 900 });
  };
  await shoot("settings", 1280, 1400);

  // Renamed and moved, in one Save: its Settings are at the new address, with nothing left at the old one.
  await team.getByRole("textbox", { name: "Name", exact: true }).fill("Acme API");
  await team.getByRole("textbox", { name: "Address", exact: true }).fill("acme-api");
  await expect(team.getByText("2 unsaved changes")).toBeVisible();
  await team.getByRole("button", { name: "Save" }).click();
  await team.waitForURL(`**/docs/references/acme-api/settings`);
  await expect(team.getByRole("heading", { name: "Acme API", level: 1 })).toBeVisible();
  // The redirect to the new address is the save working, not failing.
  await expect(team.getByText("Settings saved")).toBeVisible();
  await expect(team.getByText("Couldn't save that")).toBeHidden();
  await expect(team.getByText("unsaved change")).toBeHidden();

  // The base address: https only.
  const base = team.getByRole("textbox", { name: "Base address", exact: true });
  await base.fill("http://api.acme.example");
  await team.getByRole("button", { name: "Save" }).click();
  expect(await base.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await base.fill("https://api.acme.example");
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Settings saved")).toBeVisible();
  await expect(team.getByText("unsaved change")).toBeHidden();

  // The tree's style saves as it's picked.
  await team.getByRole("radio", { name: /^Groups as headings/ }).check();
  await expect(team.getByText("Groups as headings saved")).toBeVisible();

  // Admin to the top with the keyboard, a step at a time; its handle keeps the focus.
  const admin = team.getByRole("button", { name: "Move Admin", exact: true });
  const groups = team.getByRole("region", { name: "Group order" }).getByRole("listitem");
  await expect(groups).toHaveText([/^Posts/, /^Comments/, /^Admin/]);
  for (const order of [
    [/^Posts/, /^Admin/, /^Comments/],
    [/^Admin/, /^Posts/, /^Comments/],
  ]) {
    await admin.focus();
    await team.keyboard.press("Enter");
    await team.getByRole("menuitem", { name: "Move up" }).press("Enter");
    await expect(groups).toHaveText(order);
    await expect(admin).toBeEnabled();
    await expect(admin).toBeFocused();
  }
  await expect(team.getByText("Group order saved").first()).toBeVisible();

  // Try it off.
  const tryIt = team.getByRole("switch", { name: /^Let readers try requests/ });
  await expect(tryIt).toBeChecked();
  await tryIt.uncheck();
  await expect(team.getByText("Try it switched off")).toBeVisible();
  await expect.poll(async () => ((await api("/api-references/acme-api", undefined, "GET")) as unknown as { tryIt: boolean }).tryIt).toBe(false);

  // All kept.
  await team.reload();
  await expect(base).toHaveValue("https://api.acme.example");
  await expect(team.getByRole("radio", { name: /^Groups as headings/ })).toBeChecked();
  await expect(groups).toHaveText([/^Admin/, /^Posts/, /^Comments/]);
  await expect(tryIt).not.toBeChecked();
  await shoot("settings-saved", 1280, 1400);

  // Endpoints lists the groups in that order.
  await tabs.getByRole("link", { name: /^Endpoints/ }).click();
  await team.waitForURL(`**/docs/references/acme-api`);
  await expect(team.getByRole("region", { name: /^(Admin|Posts|Comments)$/ })).toHaveText([/^Admin/, /^Posts/, /^Comments/]);

  // On the help center: groups as headings, in that order, and requests go to the base address.
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/acme-api");
  await expect(reader).toHaveURL(/\/docs\/acme-api\/[a-z-]+$/);
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("group")).toHaveText([/^Admin/, /^Posts/, /^Comments/]);
  await expect(reader.getByRole("region", { name: "Request example" }).getByText(/^curl '.*'/)).toHaveText(/^curl 'https:\/\/api\.acme\.example\/v1\//);
  // Nothing is left at the old address.
  expect((await reader.goto("/docs/api-reference"))?.status()).toBe(404);

  // A phone: the sections one under the other, nothing wider than the window.
  await team.goto(`/app/${slug}/docs/references/acme-api/settings`);
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(team.getByRole("region", { name: "What couldn’t be read" })).toBeVisible();
  expect(await team.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(team, "settings-phone", { fullPage: false });
  await team.getByRole("region", { name: "What couldn’t be read" }).scrollIntoViewIfNeeded();
  await checkpoint(team, "settings-phone-warnings", { fullPage: false });
});
