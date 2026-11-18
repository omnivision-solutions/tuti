import { randomUUID } from "node:crypto";

import type { Request, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
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
  // Server actions the page sends, counted from the start and never unhooked: one sent late is counted too.
  const isAction = (request: Request) => request.method() === "POST" && Boolean(request.headers()["next-action"]);
  let actions = 0;
  team.on("request", (request) => {
    if (isAction(request)) actions++;
  });
  /**
   * A read whose answer arrives after the team switched source changes nothing. The form says while a read's answer
   * isn't handled yet (`data-reading`): once it's gone, every answer has been kept or dropped, in the same update as
   * what it changed. Called while one is unsettled.
   */
  const staysEmpty = async () => {
    await expect(dialog.locator("form")).not.toHaveAttribute("data-reading");
    await expect(dialog.getByLabel("Name")).toHaveValue("");
    await expect(add).toBeDisabled();
  };

  // A file still being read when the team picks "From a URL": the read, ending after, changes nothing there.
  await dialog.getByText("Upload a file", { exact: true }).click();
  await team.evaluate(() => {
    const text = File.prototype.text;
    File.prototype.text = function (this: File) {
      File.prototype.text = text;
      return new Promise<string>((resolve) => {
        (window as unknown as { releaseRead: () => void }).releaseRead = () => resolve(text.call(this));
      });
    };
  });
  await dialog.getByLabel("Spec file").setInputFiles({ name: "openapi.json", mimeType: "application/json", buffer: Buffer.from(spec({ "GET /posts": ["Posts", "List posts"] })) });
  await team.waitForFunction(() => typeof (window as unknown as { releaseRead?: () => void }).releaseRead === "function");
  await expect(dialog.locator("form")).toHaveAttribute("data-reading");
  await dialog.getByText("From a URL", { exact: true }).click();
  await team.evaluate(() => (window as unknown as { releaseRead: () => void }).releaseRead());
  await staysEmpty();

  // A Fetch still on its way when the team picks "Upload a file": its answer, arriving after, changes nothing there.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let begun = () => {};
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const holdFetch = async (route: Route) => {
    if (!isAction(route.request())) {
      await route.continue();
      return;
    }
    begun();
    await released;
    await route.fulfill({ response: await route.fetch() });
  };
  const before = actions;
  await team.route("**/*", holdFetch);
  await dialog.getByLabel("Spec URL").fill(`${siteUrl()}${path}`);
  await dialog.getByRole("button", { name: "Fetch" }).click();
  await started;
  await expect(dialog.locator("form")).toHaveAttribute("data-reading");
  // Enter again for the same address, as a held-down key repeats it, while it's on its way: no second fetch. (One
  // would be a read of its own, held as the first is, so the form couldn't settle without it being counted.)
  await dialog.getByLabel("Spec URL").press("Enter");
  await dialog.getByLabel("Spec URL").press("Enter");
  await dialog.getByText("Upload a file", { exact: true }).click();
  release();
  await staysEmpty();
  expect(actions - before).toBe(1);
  await team.unroute("**/*", holdFetch);
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
  // Held on its way, while another address is typed: that stays once the change is done (its toast is shown in the
  // same step that would clear the field).
  let letChange = () => {};
  const changeHeld = new Promise<void>((resolve) => {
    letChange = resolve;
  });
  let changeSent = () => {};
  const changeOnItsWay = new Promise<void>((resolve) => {
    changeSent = resolve;
  });
  const holdChange = async (route: Route) => {
    if (!isAction(route.request())) {
      await route.continue();
      return;
    }
    changeSent();
    await changeHeld;
    await route.fulfill({ response: await route.fetch() });
  };
  await team.route("**/*", holdChange);
  await source.getByRole("button", { name: "Change" }).click();
  await changeOnItsWay;
  const typed = `${siteUrl()}/${slug}/typed-meanwhile.json`;
  await address.fill(typed);
  letChange();
  await expect(team.getByText("Address changed: 1 added", { exact: true })).toBeVisible();
  await team.unroute("**/*", holdChange);
  await expect(address).toHaveValue(typed);
  // Back to the address it's read from now: nothing to change.
  await address.fill(`${siteUrl()}${moved}`);
  await expect(source.getByRole("button", { name: "Change" })).toBeDisabled();
  await checkpoint(team, "Settings' Source for a URL");
  // Synced from the new address from now on: the old one's gone, and Sync now still works.
  await siteAnswers(path, null);
  await source.getByRole("button", { name: "Sync now" }).click();
  await expect(team.getByText("No changes", { exact: true }).last()).toBeVisible();
  await expect(source).not.toContainText("Last sync failed");

  // A teammate moves it on while this page is open: once the page refreshes, the field shows their address, not the
  // one this page started from, so Change can't put the old one back.
  const theirs = `/${slug}/v3/openapi.json`;
  await siteAnswers(theirs, spec({ "GET /posts": ["Posts", "List posts"] }));
  await query(`UPDATE api_reference SET "sourceUrl" = $1 WHERE slug = 'acme-api' AND "sourceUrl" = $2`, [`${siteUrl()}${theirs}`, `${siteUrl()}${moved}`]);
  await source.getByRole("button", { name: "Sync now" }).click();
  await expect(address).toHaveValue(`${siteUrl()}${theirs}`);
  await expect(source.getByRole("button", { name: "Change" })).toBeDisabled();
});
