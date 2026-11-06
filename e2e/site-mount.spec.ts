import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";
import { forwardToPortal, siteUrl } from "./site";

// One at a time: the site fake has one forward for /_tuti, and "Check setup" asks through it for the portal it goes to.
test.describe.configure({ mode: "default" });

test("the team puts the portal under a path of its own site: its site forwards it, Tuti checks it, and people read it there", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/customize/address`);
  // Customize → Address: the Tuti address, a domain of its own or a sub-folder of the site: they pick the sub-folder.
  await checkpoint(owner, "settings-own-address-choice");
  await owner.getByRole("radio", { name: /Sub-folder/ }).click();
  await owner.getByRole("textbox", { name: "Your site" }).fill(siteUrl());
  await owner.getByRole("textbox", { name: "Path" }).fill("/portal");
  await owner.getByRole("button", { name: "Set up sub-folder" }).click();
  await expect(owner.getByText("Waiting for your site")).toBeVisible();
  // Not both: with the path set, there's no domain to add until it's removed.
  await expect(owner.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "true");
  await expect(owner.getByRole("textbox", { name: "Custom domain" })).toHaveCount(0);
  await expect(owner.getByText(`To switch, remove ${new URL(siteUrl()).host}/portal first.`)).toBeVisible();
  await expect(owner.getByRole("region", { name: "Forward /portal/*" })).toContainText(`${portalUrl(slug)}/portal/*`);
  // A guide per platform, with the team's own rules written out.
  await owner.getByRole("button", { name: "Vercel" }).click();
  const guide = owner.getByRole("dialog", { name: "Put your portal under /portal with Vercel" });
  await expect(guide).toContainText(`"destination": "${portalUrl(slug)}/portal/:path*"`);
  await checkpoint(owner, "settings-site-guide", { fullPage: false });
  await owner.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  // Not forwarded yet.
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText("didn't answer with this portal's check", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-site-pending");

  // The team's site forwards /portal to the portal, path and all; the check says /_tuti (scripts and styles) is missing.
  await forwardToPortal("/portal", portalUrl(slug));
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText(`Make sure your site forwards /_tuti/*`, { exact: false })).toBeVisible();
  await forwardToPortal("/_tuti", portalUrl(slug));
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText(`Your portal is at ${siteUrl()}/portal`)).toBeVisible();
  await expect(owner.getByText("Verified", { exact: true })).toBeVisible();
  // The project switcher's View portal says the portal's address, path and all.
  await owner.reload();
  await owner.getByRole("button", { name: /Acme/ }).first().click();
  await expect(owner.getByRole("menuitem", { name: /^View portal/ })).toContainText(`${new URL(siteUrl()).host}/portal`);
  await owner.keyboard.press("Escape");

  // People read it on the site, and its links stay under the path.
  const visitor = await newPerson(browser, siteUrl());
  await expect(async () => {
    await visitor.goto("/portal");
    await expect(visitor).toHaveURL(`${siteUrl()}/portal/feedback/feature-requests`, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(visitor.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  // Its scripts come through the site too (/_tuti), and they run: the tabs below are client navigations.
  await expect(visitor.locator('script[src^="/_tuti/_next/"]').first()).toBeAttached();
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/roadmap`);
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Docs" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/docs`);
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/portal/sign-in?next=%2Fdocs");
  await checkpoint(visitor, "portal-on-site");

  // The team's own HTML (Customize → Custom code) runs on their site, and not when the same path is
  // opened on the portal's Tuti host (which answers it too: the site forwards there).
  await owner.goto(`/app/${slug}/customize/custom-code`);
  await owner.getByLabel("Custom HTML").fill('<p id="team-html">From the team</p><script>document.body.dataset.teamScript = "ran"</script>');
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Custom code saved")).toBeVisible();
  await visitor.goto("/portal/docs");
  await expect(visitor.locator("#team-html")).toHaveText("From the team");
  await expect(visitor.locator("body")).toHaveAttribute("data-team-script", "ran");
  // Not the project's own widget (Customize → Widget) yet: its panel's links don't keep the path. The tag is in the page as sent.
  await expect(visitor.locator("script[data-on-portal]")).toHaveCount(0);
  const direct = await newPerson(browser, portalUrl(slug));
  await direct.goto("/portal/docs");
  await expect(direct.getByRole("heading", { name: "Docs" }).first()).toBeVisible();
  await expect(direct.locator("#team-html")).toHaveCount(0);
  await expect(direct.locator("body")).not.toHaveAttribute("data-team-script", "ran");
  // Customize → Widget says so beside its switch.
  await owner.goto(`/app/${slug}/customize/widget`);
  await expect(owner.getByText("The launcher on every page of your portal too. Not yet while your portal is under a path of your site.")).toBeVisible();
  await owner.goto(`/app/${slug}/customize/address`);

  // Signing up, posting and signing out there, all under the path.
  await visitor.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/sign-in?next=%2Fdocs`);
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await expect(visitor).toHaveURL(new RegExp(`^${siteUrl().replace(/[.:]/g, "\\$&")}/portal/sign-up`));
  await visitor.getByLabel("Name").fill("Ada");
  const email = `e2e-${randomUUID()}@example.com`;
  await visitor.getByLabel("Email").fill(email);
  await visitor.getByLabel("Password").fill("correct horse battery staple");
  await visitor.getByRole("button", { name: "Sign up" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/docs`);
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  await visitor.goto("/portal/feedback/feature-requests");
  await visitor.getByRole("button", { name: "Submit post" }).click();
  await visitor.getByLabel("Title").fill("Dark mode on our site");
  await visitor.getByRole("button", { name: "Submit post" }).click();
  await visitor.getByRole("link", { name: "Dark mode on our site" }).click();
  await visitor.waitForURL((url) => url.origin === siteUrl() && url.pathname.startsWith("/portal/feedback/feature-requests/"));
  await expect(visitor.getByRole("heading", { name: "Dark mode on our site" })).toBeVisible();
  await checkpoint(visitor, "portal-on-site-signed-in");
  await visitor.getByRole("button", { name: "Account" }).click();
  await visitor.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(new URL(visitor.url()).pathname.startsWith("/portal")).toBe(true);
  // Back in with an emailed link, under the path too, to the page they were on.
  await visitor.goto("/portal/roadmap");
  await visitor.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/sign-in?next=%2Froadmap`);
  await visitor.getByLabel("Email").fill(email);
  await visitor.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(visitor.getByText("Check your email")).toBeVisible();
  await visitor.goto(linkIn(await latestEmailTo(email), `${siteUrl()}/portal/sign-in/link?`));
  await visitor.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/roadmap`);
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  // The rest of the site is the site's.
  await visitor.goto("/pricing");
  await expect(visitor.getByRole("heading", { name: "The site's own page" })).toBeVisible();

  // Its Tuti address sends people there.
  const elsewhere = await newPerson(browser, portalUrl(slug));
  await elsewhere.goto("/roadmap");
  await expect(elsewhere).toHaveURL(`${siteUrl()}/portal/roadmap`);

  // Removed, the portal is back at its Tuti address.
  await owner.getByRole("button", { name: "Remove sub-folder" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`${siteUrl()}/portal removed`)).toBeVisible();
  // And either can be picked again.
  await expect(owner.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "false");
  await expect(async () => {
    await elsewhere.goto("/roadmap");
    expect(elsewhere.url()).toBe(`${portalUrl(slug)}/roadmap`);
  }).toPass({ timeout: 20_000 });
});

test("the widget's panel under a path of the team's site keeps the path in its tabs, searches, links and live updates", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // Articles for the Help center (one in a collection), an idea for Feedback, an update for What's new, and Messages on.
  const api = await apiFor(owner, slug);
  const collection = await api("/collections", { name: "Getting started" });
  const inviting = await api("/articles", { title: "Inviting your team", body: "Owners send invites from the Team page.", collection: collection.slug });
  await api(`/articles/${inviting.slug}/publish`, {});
  const exporting = await api("/articles", { title: "Exporting your data", body: "Download a CSV of every post." });
  await api(`/articles/${exporting.slug}/publish`, {});
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/changelog", { title: "CSV export is here" });
  await api("/changelog/1/publish", {});
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();

  // The portal under /help on the team's site.
  await owner.goto(`/app/${slug}/customize/address`);
  await owner.getByRole("radio", { name: /Sub-folder/ }).click();
  await owner.getByRole("textbox", { name: "Your site" }).fill(siteUrl());
  await owner.getByRole("textbox", { name: "Path" }).fill("/help");
  await owner.getByRole("button", { name: "Set up sub-folder" }).click();
  await expect(owner.getByText("Waiting for your site")).toBeVisible();
  await forwardToPortal("/help", portalUrl(slug));
  await forwardToPortal("/_tuti", portalUrl(slug));
  await owner.getByRole("button", { name: "Check setup" }).click();
  await expect(owner.getByText("Verified", { exact: true })).toBeVisible();

  // The panel, opened there.
  const visitor = await newPerson(browser, siteUrl());
  const tabs = visitor.getByRole("navigation", { name: "Widget" });
  await expect(async () => {
    await visitor.goto("/help/widget");
    await expect(tabs).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  const at = (path: string) => `${siteUrl()}/help/widget${path}`;
  // The panel's page under the path, with these in its query (the Help center may add its docs tab).
  const under = (params: Record<string, string>) => (url: URL) =>
    url.origin === siteUrl() && url.pathname === "/help/widget" && Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);

  // What's new, an update and back.
  await visitor.getByRole("link", { name: /^What's new/ }).click();
  await expect(visitor).toHaveURL(at("?tab=whats-new"));
  await visitor.getByRole("link", { name: /^Read more/ }).click();
  await expect(visitor).toHaveURL(at("?tab=whats-new&entry=1"));
  await visitor.getByRole("link", { name: "What's new" }).click();
  await expect(visitor).toHaveURL(at("?tab=whats-new"));
  await visitor.getByRole("link", { name: "Home" }).first().click();
  await expect(visitor).toHaveURL(at(""));

  // Home's search, a plain form, searches in the Help center there; so does the Help center's own.
  await visitor.getByRole("searchbox", { name: "Search for help" }).fill("export");
  await visitor.getByRole("searchbox", { name: "Search for help" }).press("Enter");
  await expect(visitor).toHaveURL(at("?tab=docs&q=export"));
  await expect(visitor.getByRole("list", { name: "Search results" }).getByRole("link", { name: "Exporting your data" })).toHaveAttribute(
    "href",
    `/help/widget?tab=docs&q=export&article=${exporting.slug}`,
  );
  await visitor.getByRole("searchbox", { name: "Search the docs" }).fill("invite");
  await visitor.getByRole("searchbox", { name: "Search the docs" }).press("Enter");
  await expect(visitor).toHaveURL(at("?tab=docs&q=invite"));

  // The tabs, a collection, an article and the ways back.
  await tabs.getByRole("link", { name: "Help center" }).click();
  await expect(visitor).toHaveURL(at("?tab=docs"));
  await visitor.getByRole("link", { name: /^Getting started/ }).click();
  await expect(visitor).toHaveURL(under({ tab: "docs", collection: collection.slug }));
  await visitor.getByRole("link", { name: "Inviting your team" }).click();
  await expect(visitor).toHaveURL(under({ tab: "docs", collection: collection.slug, article: inviting.slug }));
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", `/help/docs/${inviting.slug}`);
  await checkpoint(visitor, "widget-under-path-article");
  await visitor.getByRole("link", { name: "Getting started" }).click();
  await expect(visitor).toHaveURL((url) => under({ tab: "docs", collection: collection.slug })(url) && !url.searchParams.has("article"));
  await visitor.getByRole("link", { name: "All articles" }).click();
  await expect(visitor).toHaveURL((url) => under({ tab: "docs" })(url) && !url.searchParams.has("collection"));
  await tabs.getByRole("link", { name: "Feedback" }).click();
  await expect(visitor).toHaveURL(at("?tab=feedback"));
  // Ideas and signing in to vote open the portal there, in a new tab.
  await expect(visitor.getByRole("link", { name: "Dark mode" })).toHaveAttribute("href", /^\/help\/feedback\/feature-requests\//);
  await expect(visitor.getByRole("link", { name: /^Sign in to vote/ })).toHaveAttribute("href", /^\/help\/sign-in\?next=%2Ffeedback%2Ffeature-requests%2F/);
  await tabs.getByRole("link", { name: "Messages" }).click();
  await expect(visitor).toHaveURL(at("?tab=messages"));
  await expect(visitor.getByRole("region", { name: "Messages" }).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/help/sign-in");
  await tabs.getByRole("link", { name: "Home" }).click();
  await expect(visitor).toHaveURL(at(""));

  // Signed in there, Messages listens for changes through the site too.
  await visitor.goto("/help/sign-up");
  await visitor.getByLabel("Name").fill("Ada");
  await visitor.getByLabel("Email").fill(`e2e-${randomUUID()}@example.com`);
  await visitor.getByLabel("Password").fill("correct horse battery staple");
  await visitor.getByRole("button", { name: "Sign up" }).click();
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  const live = visitor.waitForRequest((request) => request.url().includes("/api/widget/live"));
  await visitor.goto("/help/widget?tab=messages");
  expect(new URL((await live).url()).pathname).toBe("/help/api/widget/live");
  await checkpoint(visitor, "widget-under-path-messages");
});
