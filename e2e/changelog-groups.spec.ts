import { createHmac, randomUUID } from "node:crypto";

import pg from "pg";

import { expect, test } from "./fixtures";

import { linkPullRequest } from "./changelog-dates";
import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** An HS256 token, as a customer's app would sign it for /sso (see docs/sso.md). */
function ssoToken(secret: string, claims: Record<string, unknown>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iat: now, exp: now + 60, jti: randomUUID(), ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("an entry for some groups only: their readers see it on the changelog, everyone else doesn't, nor its page; the editor picks them", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("switch", { name: "Single sign-on" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your secret key now" }).locator("code").innerText();

  // The team's app: two users, a group for enterprise customers, and two entries, one for them only, which completes a post.
  const api = await apiFor(owner, slug);
  await api("/users", { users: [{ id: "user-1", properties: { plan: "enterprise" } }, { id: "user-2", properties: { plan: "free" } }] });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  await api("/posts", { board: "feature-requests", title: "Audit logs" });
  await api("/changelog", { title: "Dark mode", body: "Switch themes from your profile menu." });
  await api("/changelog", { title: "Audit log export", body: "Download your audit log as CSV.", posts: [1], groups: ["enterprise"] });
  // Everyone's quietly, the enterprise one announced: only enterprise customers have something new.
  await api("/changelog/1/publish", { announce: false });
  await api("/changelog/2/publish", {});
  const newDot = (page: typeof owner) => page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Changelog/ }).getByText("New");
  const shippedIn = (page: typeof owner) => page.getByRole("main").getByRole("link", { name: "Audit log export" });

  const titles = (page: typeof owner) => page.getByRole("main").getByRole("heading", { level: 2 });

  // Signed out: only everyone's, and the other's page isn't there.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/changelog");
  await expect(titles(visitor)).toHaveText(["Dark mode"]);
  await visitor.goto("/changelog/2");
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await checkpoint(visitor, "changelog-signed-out");
  // The post it completed is done, without saying what shipped it; nor does the roadmap, or the widget's What's new.
  await visitor.goto("/feedback/feature-requests/audit-logs-1");
  await expect(visitor.getByRole("heading", { level: 1, name: "Audit logs" })).toBeVisible();
  await expect(shippedIn(visitor)).toHaveCount(0);
  await visitor.goto("/roadmap");
  await expect(visitor.getByRole("main").getByText("Audit logs")).toBeVisible();
  await expect(shippedIn(visitor)).toHaveCount(0);
  await visitor.goto("/widget");
  await expect(visitor.getByText(/^Dark mode · /)).toBeVisible();
  await expect(visitor.getByText("Audit log export")).toHaveCount(0);
  await visitor.goto("/widget?tab=whats-new");
  await expect(visitor.getByRole("heading", { level: 2 })).toHaveText(["Dark mode"]);

  // An enterprise customer, signed in by the team's app: both, and its page.
  const ada = await newPerson(browser, portalUrl(slug));
  await ada.goto(`/sso?token=${ssoToken(secret, { sub: "user-1", name: "Ada" })}&redirect=${encodeURIComponent("/roadmap")}`);
  await expect(newDot(ada)).toBeAttached();
  await ada.goto("/changelog");
  await expect(titles(ada)).toHaveText(["Audit log export", "Dark mode"]);
  await checkpoint(ada, "changelog-enterprise");
  await ada.getByRole("link", { name: "Audit log export" }).click();
  await expect(ada.getByRole("heading", { level: 1, name: "Audit log export" })).toBeVisible();
  await expect(ada.getByText("Download your audit log as CSV.")).toBeVisible();
  // Kept from search engines, and no Markdown copy offered (that one's everyone's only).
  await expect(ada.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(ada.locator('link[type="text/markdown"]')).toHaveCount(0);
  await ada.goto("/feedback/feature-requests/audit-logs-1");
  await expect(shippedIn(ada)).toBeVisible();
  await ada.goto("/widget");
  await expect(ada.getByText(/^Audit log export · /)).toBeVisible();
  await ada.goto("/widget?tab=whats-new");
  await expect(ada.getByRole("heading", { level: 2 })).toHaveText(["Audit log export", "Dark mode"]);

  // A customer on another plan: only everyone's.
  const bea = await newPerson(browser, portalUrl(slug));
  await bea.goto(`/sso?token=${ssoToken(secret, { sub: "user-2", name: "Bea" })}&redirect=${encodeURIComponent("/roadmap")}`);
  await expect(bea.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Changelog/ })).toBeVisible();
  await expect(newDot(bea)).toHaveCount(0);
  await bea.goto("/changelog");
  await expect(titles(bea)).toHaveText(["Dark mode"]);
  // The team makes Dark mode for enterprise customers too, in the editor's Who sees it: now Bea has none.
  await owner.goto(`/app/${slug}/changelog/1`);
  const audience = owner.getByRole("group", { name: "Who sees it" });
  // The sidebar scrolls with the page: no scrollbar of its own beside the page's.
  await expect(owner.getByRole("complementary", { name: "Entry settings" })).toHaveCSS("overflow-y", "visible");
  // Everyone to start with: no chips until Some groups.
  await expect(audience.getByRole("radio", { name: "Everyone" })).toBeChecked();
  await expect(audience.getByRole("checkbox", { name: "Enterprise" })).toHaveCount(0);
  await audience.getByText("Some groups", { exact: true }).click();
  await expect(audience.getByRole("checkbox", { name: "Enterprise" })).not.toBeChecked();
  await audience.getByRole("checkbox", { name: "Enterprise" }).check();
  // Who it reaches, in a few words: the list, the widget and the email all leave out everyone else.
  await expect(audience).toContainText("Only users in selected groups");
  await checkpoint(owner, "editor-audience");
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(audience.getByRole("radio", { name: "Some groups" })).toBeChecked();
  await expect(audience.getByRole("checkbox", { name: "Enterprise" })).toBeChecked();
  // On a phone the sidebar fits the screen, a long pull request title cut to its line.
  await linkPullRequest(slug, 1, { repo: "acme/app", number: 41, title: "Replace the theme picker with a menu that follows the system setting on every platform" });
  await owner.reload();
  await owner.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Changelog list", "Widget", "Email"]) {
    const box = (await owner.getByRole("group", { name: "Published in" }).getByRole("switch", { name }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  // Published, it says nothing of what publishing does with its posts.
  await expect(owner.getByText(/^Publishing completes/)).toHaveCount(0);
  await owner.getByRole("heading", { name: "Pull requests" }).scrollIntoViewIfNeeded();
  await checkpoint(owner, "editor-sidebar-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });
  await bea.goto("/changelog");
  await expect(titles(bea)).toHaveCount(0);
  await owner.goto(`/app/${slug}/changelog/1`);
  // Everyone again: the picks go.
  await audience.getByText("Everyone", { exact: true }).click();
  await expect(audience.getByRole("checkbox", { name: "Enterprise" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  // Groups set meanwhile (by the API here; a teammate alike) stay when the open editor saves something else.
  await api("/changelog/1", { groups: ["enterprise"] }, "PATCH");
  await owner.getByRole("checkbox", { name: "Fixed" }).check();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  const saved = async () => (await api("/changelog/1", undefined, "GET")) as unknown as { groups: string[]; tags: string[] };
  await expect.poll(async () => (await saved()).tags).toEqual(["fixed"]);
  expect((await saved()).groups).toEqual(["enterprise"]);
  await api("/changelog/1", { groups: [] }, "PATCH");
  // Ticked and unticked again, then saved: nothing changed, so the next save (of its tags) still keeps groups set meanwhile.
  await owner.reload();
  const enterprise = audience.getByRole("checkbox", { name: "Enterprise" });
  await audience.getByText("Some groups", { exact: true }).click();
  await enterprise.check();
  await enterprise.uncheck();
  // Some groups with none ticked isn't saved (it would be for everyone): back to Everyone.
  await audience.getByText("Everyone", { exact: true }).click();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  await api("/changelog/1", { groups: ["enterprise"] }, "PATCH");
  await owner.getByRole("checkbox", { name: "Improved" }).check();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await saved()).tags).toEqual(["improved", "fixed"]);
  expect((await saved()).groups).toEqual(["enterprise"]);
  await api("/changelog/1", { groups: [] }, "PATCH");
  // While a save runs (its answer held here), the picks wait: one made then would be dropped as the picker starts afresh after it.
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  await owner.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await saveHeld;
    await route.fulfill({ response });
  });
  await owner.getByRole("checkbox", { name: "Breaking" }).check();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(enterprise).toBeDisabled();
  releaseSave();
  // Saved for everyone (set meanwhile by the API), it starts afresh on Everyone.
  await expect(audience.getByRole("radio", { name: "Everyone" })).toBeChecked();
  await owner.unroute("**/*");

  // A draft: picking its audience holds Publish until it's saved (Publish sends what's saved, to whoever that's for).
  await api("/changelog", { title: "Roles", body: "Give teammates roles." });
  await owner.goto(`/app/${slug}/changelog/3`);
  await audience.getByText("Some groups", { exact: true }).click();
  // None ticked yet: it would go to everyone, so Publish says to pick one.
  await owner.getByRole("button", { name: "Publish" }).click();
  const publish = owner.getByRole("alertdialog");
  await expect(publish.getByRole("heading", { name: "Pick a group before publishing" })).toBeVisible();
  await expect(publish).toContainText("“Roles” is for some groups, but none is picked. Pick one, or choose Everyone.");
  await publish.getByRole("button", { name: "Cancel" }).click();
  await audience.getByRole("checkbox", { name: "Enterprise" }).check();
  await owner.getByRole("button", { name: "Publish" }).click();
  await expect(publish.getByRole("heading", { name: "Save before publishing" })).toBeVisible();
  await expect(publish.getByRole("button", { name: "Publish" })).toBeDisabled();
  await publish.getByRole("button", { name: "Cancel" }).click();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => ((await api("/changelog/3", undefined, "GET")) as unknown as { groups: string[] }).groups).toEqual(["enterprise"]);
  await owner.getByRole("button", { name: "Publish" }).click();
  await expect(publish.getByRole("heading", { name: "Publish “Roles”?" })).toBeVisible();
  await publish.getByRole("button", { name: "Cancel" }).click();

  // Her What's new has nothing announced for her, so it marks nothing seen (not the time of the one she can't read).
  await bea.goto("/widget?tab=whats-new");
  await expect(bea.getByRole("heading", { level: 2 })).toHaveText(["Dark mode"]);
  await bea.waitForLoadState("networkidle");
  const seen = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await seen.connect();
  try {
    const { rows } = await seen.query(
      `SELECT 1 FROM changelog_seen s JOIN project p ON p.id = s."projectId" JOIN sso_identity i ON i."userId" = s."userId" WHERE p.slug = $1 AND i."externalId" = 'user-2'`,
      [slug],
    );
    expect(rows).toEqual([]);
  } finally {
    await seen.end();
  }
});
