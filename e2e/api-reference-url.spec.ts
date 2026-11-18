import { randomUUID } from "node:crypto";

import type { Request, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";
import { siteAnswers, siteUrl } from "./site";

/** An OpenAPI spec: each operation as "GET /posts" with its tag and summary. */
function spec(operations: Record<string, [tag: string, summary: string]>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, [tag, summary]] of Object.entries(operations)) {
    const [method, path] = key.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = { tags: [tag], summary, responses: { 200: { description: "OK" } } };
  }
  return JSON.stringify({ openapi: "3.1.0", info: { title: "Acme API", version: "1" }, paths });
}

test("An API reference read from a URL: added from its address, Sync now brings what's new, and a failed sync says so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  // The team's spec, on its own site (the site fake): a path of this journey's own.
  const path = `/${slug}/openapi.json`;
  await siteAnswers(path, spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"] }));
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/tabs", { name: "Developers" });
  await team.setViewportSize({ width: 1280, height: 900 });
  await team.goto(`/app/${slug}/docs`);

  await team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("button", { name: "Add to your docs" }).click();
  await team.getByRole("menuitem", { name: "API reference" }).click();
  const dialog = team.getByRole("dialog", { name: "Add API reference" });
  await expect(dialog.getByRole("radio", { name: /From a URL/ })).toBeChecked();
  const add = dialog.getByRole("button", { name: "Add reference" });

  // A Fetch still on its way when the team picks "Upload a file": its answer, arriving after, changes nothing there.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let begun = () => {};
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const isAction = (request: Request) => request.method() === "POST" && Boolean(request.headers()["next-action"]);
  const holdFetch = async (route: Route) => {
    if (!isAction(route.request())) {
      await route.continue();
      return;
    }
    begun();
    await released;
    // Whole, so the page has all of it at once and its end can be waited for.
    await route.fulfill({ response: await route.fetch() });
  };
  await team.route("**/*", holdFetch);
  await dialog.getByLabel("Spec URL").fill(`${siteUrl()}${path}`);
  await dialog.getByRole("button", { name: "Fetch" }).click();
  await started;
  await dialog.getByText("Upload a file", { exact: true }).click();
  const answered = team.waitForResponse((response) => isAction(response.request()));
  release();
  // Its whole answer in the page, then two frames: the moment it would have landed in.
  await (await answered).finished();
  await team.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await team.unroute("**/*", holdFetch);
  await expect(dialog.getByLabel("Name")).toHaveValue("");
  await expect(add).toBeDisabled();
  await dialog.getByText("From a URL", { exact: true }).click();

  // An address that isn't there is refused at Fetch, under its field.
  await dialog.getByLabel("Spec URL").fill(`${siteUrl()}/${slug}/missing.json`);
  await dialog.getByRole("button", { name: "Fetch" }).click();
  await expect(dialog.getByText("The address answered 404 Not Found.")).toBeVisible();
  await expect(add).toBeDisabled();
  // The right one: Fetch reads it and names the reference.
  await dialog.getByLabel("Spec URL").fill(`${siteUrl()}${path}`);
  await dialog.getByLabel("Spec URL").press("Enter");
  await expect(dialog.getByLabel("Name")).toHaveValue("Acme API");
  await expect(dialog.getByText("Read. It’s fetched again every 6 hours.")).toBeVisible();
  await checkpoint(team, "the dialog's URL panel, fetched", { fullPage: false });
  await add.click();

  await expect(team).toHaveURL(new RegExp(`/app/${slug}/docs/references/acme-api$`));
  await expect(team.getByRole("heading", { name: "Acme API", level: 1 })).toBeVisible();
  await expect(team.getByText("2 of 2 on the help center", { exact: true })).toBeVisible();
  // A URL's button reads it again; there's nothing to upload.
  await expect(team.getByRole("button", { name: "Upload new version" })).toHaveCount(0);

  // The spec changes on the team's site: Sync now brings the new operation, New.
  await siteAnswers(path, spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"], "GET /users": ["Users", "List users"] }));
  await team.getByRole("button", { name: "Sync now" }).click();
  await expect(team.getByText("1 added", { exact: true })).toBeVisible();
  const users = team.getByRole("region", { name: "Users", exact: true });
  await expect(users.getByRole("listitem").filter({ hasText: "List users" })).toContainText("New");
  await expect(team.getByText("3 of 3 on the help center", { exact: true })).toBeVisible();

  // The site stops answering: the sync fails, and the page says why and keeps the reference as it was.
  await siteAnswers(path, null);
  await team.getByRole("button", { name: "Sync now" }).click();
  await expect(team.getByText("The address answered 404 Not Found.").first()).toBeVisible();
  const banner = team.getByRole("status").filter({ hasText: "Sync failed." });
  await expect(banner).toContainText("The address answered 404 Not Found.");
  await expect(banner).toContainText("Last synced just now");
  await expect(team.getByText("3 of 3 on the help center", { exact: true })).toBeVisible();
  await expect(users.getByRole("listitem").filter({ hasText: "List users" })).toBeVisible();
  await checkpoint(team, "a failed sync's banner");

  // Back: the banner's own Sync now clears it.
  await siteAnswers(path, spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"], "GET /users": ["Users", "List users"] }));
  await banner.getByRole("button", { name: "Sync now" }).click();
  await expect(team.getByText("No changes", { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
  // Its button went with it: focus is on the header's Sync now, not lost.
  await expect(team.getByRole("button", { name: "Sync now" })).toBeFocused();

  // Settings' Source: where it's read from and how its syncs went, and the address changed there.
  await team.getByRole("navigation", { name: "API reference" }).getByRole("link", { name: "Settings" }).click();
  await team.waitForURL(`**/docs/references/acme-api/settings`);
  const source = team.getByRole("region", { name: "Source" });
  await expect(source).toContainText("A URL");
  await expect(source).toContainText("Last tried");
  await expect(source).toContainText("Last synced");
  const address = source.getByLabel("Spec URL");
  await expect(address).toHaveValue(`${siteUrl()}${path}`);
  // An address that isn't there is refused under the field, and the reference stays read from the old one.
  await address.fill(`${siteUrl()}/${slug}/v2/missing.json`);
  await source.getByRole("button", { name: "Change" }).click();
  await expect(source.getByText("The address answered 404 Not Found.")).toBeVisible();
  await expect(address).toBeFocused();
  // One that is: read in, with what it added in the toast.
  const moved = `/${slug}/v2/openapi.json`;
  await siteAnswers(moved, spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"], "GET /users": ["Users", "List users"], "GET /teams": ["Teams", "List teams"] }));
  await address.fill(`${siteUrl()}${moved}`);
  await source.getByRole("button", { name: "Change" }).click();
  await expect(team.getByText("Address changed: 1 added", { exact: true })).toBeVisible();
  await expect(source.getByRole("button", { name: "Change" })).toBeDisabled();
  await checkpoint(team, "Settings' Source for a URL");
  // Synced from the new address from now on: the old one's gone, and Sync now still works.
  await siteAnswers(path, null);
  await source.getByRole("button", { name: "Sync now" }).click();
  await expect(team.getByText("No changes", { exact: true }).last()).toBeVisible();
  await expect(source).not.toContainText("Last sync failed");
});
