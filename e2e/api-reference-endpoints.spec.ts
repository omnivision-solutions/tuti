import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

/** An OpenAPI spec: each operation as "GET /posts" with its tag and summary. */
function spec(operations: Record<string, [tag: string, summary: string]>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, [tag, summary]] of Object.entries(operations)) {
    const [method, path] = key.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = { tags: [tag], summary, responses: { 200: { description: "OK" } } };
  }
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Acme API", version: "1" },
    tags: [{ name: "Posts", description: "What people asked for." }, { name: "Admin", description: "For the team only." }],
    paths,
  });
}

const POSTS = { "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"], "DELETE /posts/{id}": ["Admin", "Delete a post"] } satisfies Parameters<typeof spec>[0];

test("An API reference's Endpoints: switches for the help center, a new version's New, unpublishing and deleting", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/api-references", { name: "API reference", spec: spec(POSTS) });
  const saved = async () => (await api("/api-references/api-reference", undefined, "GET")) as unknown as { counts: { onHelpCenter: number; new: number } };
  await team.setViewportSize({ width: 1280, height: 900 });

  await team.goto(`/app/${slug}/docs/references/api-reference`);
  await expect(team.getByRole("heading", { name: "API reference", level: 1 })).toBeVisible();
  // Exactly: only a draft's count goes on to "when published".
  await expect(team.getByText("3 of 3 on the help center", { exact: true })).toBeVisible();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await expect(team.getByRole("link", { name: "View on help center" })).toHaveAttribute("href", /\/docs\/api-reference$/);
  // It opens the reference's page on the help center.
  const [helpCenter] = await Promise.all([team.context().waitForEvent("page"), team.getByRole("link", { name: "View on help center" }).click()]);
  await expect(helpCenter.getByRole("heading", { name: "API reference", level: 1 })).toBeVisible();
  await expect(helpCenter).toHaveURL(/\/docs\/api-reference$/);
  await helpCenter.close();
  const posts = team.getByRole("region", { name: "Posts", exact: true });
  await expect(posts.getByText("What people asked for.")).toBeVisible();
  await expect(posts.getByRole("listitem").filter({ hasText: "List posts" })).toContainText("GET/posts");

  // One operation off, then a whole group: its operations' switches grey, keeping their own choice.
  await team.getByRole("switch", { name: "Create a post (POST /posts): on the help center" }).uncheck();
  await expect(team.getByText("2 of 3 on the help center")).toBeVisible();
  await team.getByRole("switch", { name: "Admin: on the help center" }).uncheck();
  await expect(team.getByText("1 of 3 on the help center")).toBeVisible();
  const deletePost = team.getByRole("switch", { name: "Delete a post (DELETE /posts/{id}): on the help center" });
  await expect(deletePost).toBeDisabled();
  await expect(deletePost).toBeChecked();
  // Why, in the row; and the switch is still reached by Tab, where a click changes nothing.
  await expect(team.getByRole("region", { name: "Admin", exact: true }).getByRole("listitem")).toContainText("Off while Admin is off");
  await deletePost.focus();
  await expect(deletePost).toBeFocused();
  await team.keyboard.press("Space");
  await expect(deletePost).toBeChecked();
  // The header's actions fit beside the docs' tree at desktop widths, and on a phone below.
  const more = team.getByRole("button", { name: "More actions" });
  const fits = async (width: number) => {
    const box = (await more.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await team.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  };
  await fits(1280);
  await checkpoint(team, "endpoints", { fullPage: false });
  await team.setViewportSize({ width: 1024, height: 900 });
  await fits(1024);
  await expect(team.getByRole("button", { name: "Upload new version" })).toBeVisible();
  await checkpoint(team, "endpoints-1024", { fullPage: false });
  await team.setViewportSize({ width: 1280, height: 900 });

  // Kept. (Each switch saved before the next: the reload waits for nothing.)
  await expect.poll(async () => (await saved()).counts.onHelpCenter).toBe(1);
  await team.reload();
  await expect(team.getByText("1 of 3 on the help center")).toBeVisible();
  await expect(team.getByRole("switch", { name: "Create a post (POST /posts): on the help center" })).not.toBeChecked();
  await expect(team.getByRole("switch", { name: "Admin: on the help center" })).not.toBeChecked();

  // A new version adds an operation: New, and off the help center since the team has hidden something. While it uploads
  // (held back here until the test lets it go) the button is disabled and keeps the keyboard's focus.
  const uploadButton = team.getByRole("button", { name: "Upload new version" });
  let release = () => {};
  let held: Promise<void> | null = new Promise((resolve) => (release = resolve));
  await team.route(`**/docs/references/api-reference`, async (route) => {
    if (route.request().method() === "POST" && held) {
      const until = held;
      held = null;
      await until;
    }
    await route.continue();
  });
  await uploadButton.focus();
  await team.locator('input[type="file"]').setInputFiles({
    name: "openapi.json",
    mimeType: "application/json",
    buffer: Buffer.from(spec({ ...POSTS, "GET /comments": ["Comments", "List comments"] })),
  });
  await expect(uploadButton).toBeDisabled();
  await expect(uploadButton).toBeFocused();
  release();
  await expect(team.getByText("1 added", { exact: true })).toBeVisible();
  const comments = team.getByRole("region", { name: "Comments", exact: true }).getByRole("listitem");
  await expect(comments.getByText("New", { exact: true })).toBeVisible();
  await expect(team.getByText("1 new endpoint was added hidden.")).toBeVisible();
  await expect(team.getByRole("link", { name: "Review it below." })).toHaveAttribute("href", "#endpoint-list-comments");
  await expect(team.getByText("1 of 4 on the help center")).toBeVisible();
  await expect(team.getByRole("switch", { name: "List comments (GET /comments): on the help center" })).not.toBeChecked();
  await checkpoint(team, "new-version", { fullPage: false });

  // Seen: on the next visit nothing is New.
  await expect.poll(async () => (await saved()).counts.new).toBe(0);
  await team.reload();
  await expect(team.getByText("1 of 4 on the help center")).toBeVisible();
  await expect(comments.getByText("New", { exact: true })).toBeHidden();
  await expect(team.getByText("was added hidden")).toBeHidden();

  // A phone: the method and path on one line, the title under them, the switch at the right; nothing wider than the window.
  await team.setViewportSize({ width: 390, height: 844 });
  const row = posts.getByRole("listitem").filter({ hasText: "List posts" });
  const [path, title, toggle] = await Promise.all([row.getByText("/posts", { exact: true }).boundingBox(), row.getByText("List posts", { exact: true }).boundingBox(), row.getByRole("switch").boundingBox()]);
  expect(title!.y).toBeGreaterThanOrEqual(path!.y + path!.height - 1);
  expect(toggle!.x).toBeGreaterThan(title!.x + title!.width - 1);
  await fits(390);
  await checkpoint(team, "phone", { fullPage: false });
  await team.setViewportSize({ width: 1280, height: 900 });

  // Unpublishing under More: a draft, with no page on the help center to open.
  await team.getByRole("button", { name: "More actions" }).click();
  await team.getByRole("menuitem", { name: "Unpublish" }).click();
  await expect(team.getByText("API reference unpublished")).toBeVisible();
  // On its page, and on its row in the tree.
  await expect(team.locator('[data-slot="badge"]').getByText("Draft", { exact: true })).toBeVisible();
  await expect(team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "API reference Draft" })).toBeVisible();
  // Nothing of a draft is on the help center: the count says what will be.
  await expect(team.getByText("1 of 4 on the help center when published")).toBeVisible();
  await expect(team.getByRole("link", { name: "View on help center" })).toBeHidden();

  // Deleting goes back to Docs.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("menuitem", { name: "Publish" })).toBeVisible();
  await team.getByRole("menuitem", { name: "Delete" }).click();
  await team.getByRole("alertdialog", { name: "Delete API reference?" }).getByRole("button", { name: "Delete" }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
});

test("An API reference's Endpoints: a group that's only a second tag has its switch, and a long list is searched", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // 21 operations: enough for the search box. One is tagged Internal too, which no operation has as its first tag.
  const paths: Record<string, unknown> = {};
  for (let n = 1; n <= 21; n++) {
    paths[`/things/${n}`] = { get: { tags: n === 1 ? ["Things", "Internal"] : ["Things"], summary: `Read thing ${n}`, responses: { 200: { description: "OK" } } } };
  }
  const text = (more: Record<string, unknown> = {}) => JSON.stringify({ openapi: "3.1.0", info: { title: "Acme API", version: "1" }, paths: { ...paths, ...more } });
  await api("/api-references", { name: "API reference", spec: text() });
  await team.setViewportSize({ width: 1280, height: 900 });
  await team.goto(`/app/${slug}/docs/references/api-reference`);
  await expect(team.getByText("21 of 21 on the help center")).toBeVisible();

  // Off, on, off in a hurry, the first save still on its way (held here): the last click is what's saved.
  let release = () => {};
  let held: Promise<void> | null = new Promise((resolve) => (release = resolve));
  let saves = 0;
  // What each of this switch's saves asked for, in the order they were sent (an action's arguments end with `on`).
  const sent: string[] = [];
  await team.route(`**/docs/references/api-reference`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postData() ?? "";
    if (body.includes("GET /things/2")) sent.push(/true\]\s*$/.test(body) ? "on" : "off");
    if (held) {
      const until = held;
      held = null;
      await until;
    }
    await route.continue();
  });
  team.on("response", (response) => {
    if (response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/docs/references/api-reference")) saves += 1;
  });
  const second = team.getByRole("switch", { name: "Read thing 2 (GET /things/2): on the help center" });
  await second.click();
  await second.click();
  await second.click();
  await expect(second).not.toBeChecked();
  release();
  // The first click's save and the last one's: the one between was never sent.
  await expect.poll(() => saves).toBe(2);
  await expect(second).not.toBeChecked();
  // Until the last save sent asks for off: a save per click would have sent off, on, off.
  await expect.poll(() => sent.length >= 2 && sent.at(-1) === "off").toBe(true);
  expect(sent).toEqual(["off", "off"]);
  await team.reload();
  await expect(team.getByText("20 of 21 on the help center")).toBeVisible();
  await expect(second).not.toBeChecked();
  await second.check();
  await expect(team.getByText("21 of 21 on the help center")).toBeVisible();

  // Everything off: nothing of it is on the help center, so there's no page there to open.
  const helpCenter = team.getByRole("link", { name: "View on help center" });
  await expect(helpCenter).toBeVisible();
  await team.getByRole("switch", { name: "Things: on the help center" }).uncheck();
  await expect(team.getByText("0 of 21 on the help center")).toBeVisible();
  await expect(helpCenter).toBeHidden();
  await team.getByRole("switch", { name: "Things: on the help center" }).check();
  await expect(helpCenter).toBeVisible();

  // Internal off: the operation tagged with it is off too, its switch greyed, saying why.
  await team.getByRole("switch", { name: "Internal: on the help center" }).uncheck();
  await expect(team.getByText("20 of 21 on the help center")).toBeVisible();
  const first = team.getByRole("switch", { name: "Read thing 1 (GET /things/1): on the help center" });
  await expect(first).toBeDisabled();
  await expect(first).toHaveAccessibleDescription("Off while Internal is off");

  // Search by path or title; nothing found is said.
  const search = team.getByRole("searchbox", { name: "Search endpoints" });
  await search.fill("thing 20");
  await expect(team.getByRole("region", { name: "Things", exact: true }).getByRole("listitem")).toHaveCount(1);
  await search.fill("nothing like it");
  await expect(team.getByRole("status").filter({ hasText: "No endpoints match “nothing like it”." })).toBeVisible();
  await expect(team.getByRole("region", { name: "Things", exact: true })).toBeHidden();

  // A new version's operation arrives hidden; the notice's link clears the search, so its row is there to go to.
  await team.locator('input[type="file"]').setInputFiles({
    name: "openapi.json",
    mimeType: "application/json",
    buffer: Buffer.from(text({ "/others": { get: { tags: ["Others"], summary: "List others", responses: { 200: { description: "OK" } } } } })),
  });
  await expect(team.getByText("1 added", { exact: true })).toBeVisible();
  await team.getByRole("link", { name: "Review it below." }).click();
  await expect(search).toHaveValue("");
  await expect(team.getByRole("region", { name: "Others", exact: true }).getByText("New", { exact: true })).toBeVisible();
});
