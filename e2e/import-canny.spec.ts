import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_CANNY_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

test("in the first run the team comes from Canny: a bad key is refused, a good one brings its users, feedback and changelog across", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // Where are you coming from: Canny, with its key and what it has to bring (no team, help center or inbox).
  await owner.waitForURL(`**/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Canny/ }).check();
  await expect(owner.getByText("Bring your users, feedback and changelog across with an API key.")).toBeVisible();
  await expect(owner.getByRole("link", { name: /^Get your API key.*opens in a new tab/ })).toHaveAttribute("href", "https://canny.io/admin/settings/api");
  await expect(owner.getByText("In Canny, Settings → API. It's kept only while the import runs.")).toBeVisible();
  await expect(owner.getByRole("checkbox", { name: /^Team/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Help center/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Inbox/ })).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  await owner.getByRole("checkbox", { name: /^Feedback/ }).check();
  await owner.getByRole("checkbox", { name: /^Changelog/ }).check();
  await checkpoint(owner, "setup-canny");

  const key = owner.getByRole("textbox", { name: "API key" });
  await key.fill("not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Canny didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();

  await key.fill(FAKE_CANNY_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Canny" });
  await expect(status).toContainText(
    "Imported from Canny. 3 contacts, 1 board, 4 posts, 7 votes, 2 comments, 1 note, 2 images, 3 changelog entries, 1 image in the changelog, 1 profile picture brought across.",
    { timeout: 30_000 },
  );
  await expect(status).toContainText("1 board only some people see");
  await checkpoint(owner, "setup-canny-imported");

  // On the portal: the post with its details, image, date, votes and comment; never the internal note.
  const visitor = await browser.newPage({ baseURL: portalUrl(slug) });
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  const post = visitor.getByRole("article");
  await expect(post.getByRole("heading", { name: "Dark mode" })).toBeVisible();
  await expect(post.getByText("Night owls need it.")).toBeVisible();
  // Canny keeps no alt text: the image is decoration to a screen reader.
  await expect(post.locator("figure img")).toHaveCount(1);
  await expect(post.locator('time[datetime="2024-01-10T08:00:00.000Z"]')).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Sign in to vote (3 votes)" })).toBeVisible();
  await expect(visitor.getByRole("region", { name: "Comments" }).getByText("Yes please!")).toBeVisible();
  await expect(visitor.getByText("Planning it for June.")).toHaveCount(0);
  await checkpoint(visitor, "portal-canny-post");

  // The changelog: published entries at their dates, the draft not on the portal.
  await visitor.goto("/changelog");
  await expect(visitor.getByRole("heading", { name: "Dark mode is here" })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Faster exports" })).toBeVisible();
  await expect(visitor.getByText("Single sign-on")).toHaveCount(0);
  await checkpoint(visitor, "portal-canny-changelog");

  // In the app: the admin's internal comment as the team's note.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByText("Planning it for June.")).toBeVisible();
  await expect(owner.getByText("Internal note", { exact: true })).toBeVisible();
});

test("on a plan with a board limit, the setup step names Canny in what happens to boards past it", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Canny/ }).check();
  await owner.getByRole("checkbox", { name: /^Feedback/ }).check();
  await expect(
    owner.getByText(
      "Projects on the free plan have up to 2 feedback boards: Canny's boards past that come across turned off, seen only by your team in the app until an upgrade lets you turn them on. Pro has up to 5, and Business any number.",
    ),
  ).toBeVisible();
});
