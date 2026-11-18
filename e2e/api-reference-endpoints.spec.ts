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
  await expect(team.getByText("3 of 3 on the help center")).toBeVisible();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await expect(team.getByRole("link", { name: "View on help center" })).toHaveAttribute("href", /\/docs\/api-reference$/);
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
  await checkpoint(team, "endpoints");

  // Kept. (Each switch saved before the next: the reload waits for nothing.)
  await expect.poll(async () => (await saved()).counts.onHelpCenter).toBe(1);
  await team.reload();
  await expect(team.getByText("1 of 3 on the help center")).toBeVisible();
  await expect(team.getByRole("switch", { name: "Create a post (POST /posts): on the help center" })).not.toBeChecked();
  await expect(team.getByRole("switch", { name: "Admin: on the help center" })).not.toBeChecked();

  // A new version adds an operation: New, and off the help center since the team has hidden something.
  await team.locator('input[type="file"]').setInputFiles({
    name: "openapi.json",
    mimeType: "application/json",
    buffer: Buffer.from(spec({ ...POSTS, "GET /comments": ["Comments", "List comments"] })),
  });
  await expect(team.getByText("1 added", { exact: true })).toBeVisible();
  const comments = team.getByRole("region", { name: "Comments", exact: true }).getByRole("listitem");
  await expect(comments.getByText("New", { exact: true })).toBeVisible();
  await expect(team.getByText("1 new endpoint was added hidden.")).toBeVisible();
  await expect(team.getByRole("link", { name: "Review it below." })).toHaveAttribute("href", "#endpoint-list-comments");
  await expect(team.getByText("1 of 4 on the help center")).toBeVisible();
  await expect(team.getByRole("switch", { name: "List comments (GET /comments): on the help center" })).not.toBeChecked();
  await checkpoint(team, "new-version");

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
  expect(await team.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(team, "phone");
  await team.setViewportSize({ width: 1280, height: 900 });

  // Unpublishing under More: a draft, with no page on the help center to open.
  await team.getByRole("button", { name: "More actions" }).click();
  await team.getByRole("menuitem", { name: "Unpublish" }).click();
  await expect(team.getByText("API reference unpublished")).toBeVisible();
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();
  await expect(team.getByRole("link", { name: "View on help center" })).toBeHidden();

  // Deleting goes back to Docs.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("menuitem", { name: "Publish" })).toBeVisible();
  await team.getByRole("menuitem", { name: "Delete" }).click();
  await team.getByRole("alertdialog", { name: "Delete API reference?" }).getByRole("button", { name: "Delete" }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
});
