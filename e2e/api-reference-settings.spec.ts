import { randomUUID } from "node:crypto";

import pg from "pg";

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
  // A base address saved before https was required: the API refuses one now.
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE api_reference SET "baseUrl" = 'http://api.acme.example' FROM project WHERE project.id = api_reference."projectId" AND project.slug = $1`, [slug]);
  } finally {
    await client.end();
  }
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

  // Renamed and moved, in one Save (the old http base address, left alone, doesn't hold it up): its Settings are at the
  // new address, with nothing left at the old one.
  await team.getByRole("textbox", { name: "Name", exact: true }).fill("Acme API");
  await team.getByRole("textbox", { name: "Address", exact: true }).fill("acme-api");
  await expect(team.getByText("2 unsaved changes")).toBeVisible();
  await team.getByRole("button", { name: "Save" }).click();
  await team.waitForURL(`**/docs/references/acme-api/settings`);
  await expect(team.getByRole("heading", { name: "Acme API", level: 1 })).toBeVisible();
  await expect(team.getByRole("textbox", { name: "Base address", exact: true })).toHaveValue("http://api.acme.example");
  // The redirect to the new address is the save working, not failing.
  await expect(team.getByText("Settings saved")).toBeVisible();
  await expect(team.getByText("Couldn't save that")).toBeHidden();
  await expect(team.getByText("unsaved change")).toBeHidden();

  // A teammate renames it meanwhile: once another save refreshes the page, the name shows theirs, not as a change of
  // ours, and the next Save doesn't put ours back.
  await api("/api-references/acme-api", { name: "Acme public API" }, "PATCH");
  await team.getByRole("radio", { name: /^Groups as headings/ }).check();
  await expect(team.getByText("Groups as headings saved")).toBeVisible();
  await expect(team.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Acme public API");
  await expect(team.getByText("unsaved change")).toBeHidden();

  // The base address: https only, once it's changed.
  const base = team.getByRole("textbox", { name: "Base address", exact: true });
  await expect(base).toHaveValue("http://api.acme.example");
  await base.fill("http://api.acme.example/v2");
  await team.getByRole("button", { name: "Save" }).click();
  expect(await base.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await base.fill("https://api.acme.example");
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("unsaved change")).toBeHidden();
  await expect.poll(async () => ((await api("/api-references/acme-api", undefined, "GET")) as unknown as { name: string; baseUrl: string })).toMatchObject({
    name: "Acme public API",
    baseUrl: "https://api.acme.example",
  });

  // Admin to the top with the keyboard, a step at a time; its handle keeps the focus.
  const admin = team.getByRole("button", { name: "Move Admin", exact: true });
  const groups = team.getByRole("region", { name: "Group order" }).getByRole("listitem");
  await expect(groups).toHaveText([/^Posts/, /^Comments/, /^Admin/]);
  // Every order the list shows from here, to check below that a saved move never shows the order before it again (the
  // page refreshes after the save answers: a move made in between would start from the old order).
  await team.getByRole("region", { name: "Group order" }).locator("ol").evaluate((list) => {
    const shown = ((window as unknown as { groupOrders: string[] }).groupOrders = [] as string[]);
    const record = () => {
      const order = [...list.querySelectorAll<HTMLElement>("[data-group-key]")].map((row) => row.dataset.groupKey).join(", ");
      if (shown.at(-1) !== order) shown.push(order);
    };
    record();
    new MutationObserver(record).observe(list, { childList: true, subtree: true });
  });
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
  // By now the moves' refreshes have come (Try it's came after them): each order showed once, in turn.
  expect(await team.evaluate(() => (window as unknown as { groupOrders: string[] }).groupOrders)).toEqual(["Posts, Comments, Admin", "Posts, Admin, Comments", "Admin, Posts, Comments"]);

  // Two styles picked in a row, the first save held here and then lost: its failure puts back nothing of the second
  // pick, which shows until its own save has answered.
  let failFirst = () => {};
  let releaseSecond = () => {};
  const first = new Promise<void>((resolve) => (failFirst = resolve));
  const second = new Promise<void>((resolve) => (releaseSecond = resolve));
  let saves = 0;
  const settingsPage = `**/docs/references/acme-api/settings`;
  await team.route(settingsPage, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (saves++ === 0) {
      await first;
      return route.abort();
    }
    await second;
    await route.continue();
  });
  const style = (name: string) => team.getByRole("radio", { name: new RegExp(`^${name}`) });
  await style("Groups as folders").check();
  await style("One entry").check();
  failFirst();
  await expect(team.getByText("Couldn't save that. Try again.")).toBeVisible();
  await expect(style("One entry")).toBeChecked();
  releaseSecond();
  await expect(team.getByText("One entry saved")).toBeVisible();
  await expect(style("One entry")).toBeChecked();
  await team.unroute(settingsPage);
  // Back to headings for the help center below.
  await style("Groups as headings").check();
  await expect(team.getByText("Groups as headings saved").last()).toBeVisible();

  // All kept.
  await team.reload();
  await expect(base).toHaveValue("https://api.acme.example");
  await expect(team.getByRole("radio", { name: /^Groups as headings/ })).toBeChecked();
  await expect(groups).toHaveText([/^Admin/, /^Posts/, /^Comments/]);
  await expect(tryIt).not.toBeChecked();
  await shoot("settings-saved", 1280, 1400);

  // Dragged: a row dropped on one above goes before it, on one below after it.
  const row = (name: string) => groups.filter({ hasText: name });
  await row("Comments").dragTo(row("Admin"));
  await expect(groups).toHaveText([/^Comments/, /^Admin/, /^Posts/]);
  await expect(row("Comments").getByRole("button")).toBeEnabled();
  await row("Comments").dragTo(row("Posts"));
  await expect(groups).toHaveText([/^Admin/, /^Posts/, /^Comments/]);
  await expect(row("Comments").getByRole("button")).toBeEnabled();
  await expect.poll(async () => ((await api("/api-references/acme-api", undefined, "GET")) as unknown as { groups: { key: string }[] }).groups.map((group) => group.key)).toEqual([
    "Admin",
    "Posts",
    "Comments",
  ]);

  // Endpoints lists the groups in that order.
  await tabs.getByRole("link", { name: /^Endpoints/ }).click();
  await team.waitForURL(`**/docs/references/acme-api`);
  await expect(team.getByRole("region", { name: /^(Admin|Posts|Comments)$/ })).toHaveText([/^Admin/, /^Posts/, /^Comments/]);

  // On the help center: groups as headings, in that order, and requests go to the base address.
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/acme-api/list-posts");
  await expect(reader.getByRole("heading", { name: "List posts", level: 1 })).toBeVisible();
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("group")).toHaveText([/^Admin/, /^Posts/, /^Comments/]);
  await expect(reader.getByRole("region", { name: "Request example" }).getByText(/^curl '.*'/)).toHaveText(/^curl 'https:\/\/api\.acme\.example\/v1\//);

  // Try it is off: the operation's page has no Try it. Switched back on, it's there.
  await expect(reader.getByRole("button", { name: "Try it" })).toHaveCount(0);
  await tabs.getByRole("link", { name: "Settings" }).click();
  await team.waitForURL(`**/docs/references/acme-api/settings`);
  await tryIt.check();
  await expect(team.getByText("Try it switched on")).toBeVisible();
  await reader.reload();
  await expect(reader.getByRole("heading", { name: "List posts", level: 1 })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Try it" })).toBeVisible();

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
