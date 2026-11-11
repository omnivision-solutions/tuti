import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, backToPortal, createProject, fillSignUp, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";
import { nextModelReply } from "./model";
import { similar } from "./openai";
import { forwardToPortal, siteUrl } from "./site";

// One at a time: the site fake has one forward for /_tuti, and "Check setup" asks through it for the portal it goes to.
test.describe.configure({ mode: "default" });

test("the team puts the portal under a path of its own site: its site forwards it, Tuti checks it, and people read it there", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings/domain`);
  // Settings → Domain: the Tuti address, a domain of its own or a sub-folder of the site: they pick the sub-folder.
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
  // The project's own widget (Customize → Widget): the launcher opens its panel under the path too, through the site (its
  // links keeping the path: the journey below).
  await expect(visitor.locator("script[data-on-portal]")).toHaveAttribute("data-on-portal", "/portal");
  // At an address of its own there, so no browser's copy of an older loader (which didn't read the path) runs it.
  await expect(visitor.locator("script[data-on-portal]")).toHaveAttribute("src", /\/widget\.js\?v=4$/);
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await expect(visitor.locator('iframe[title="Feedback"]')).toHaveAttribute("src", `${siteUrl()}/portal/widget`);
  const panel = visitor.frameLocator('iframe[title="Feedback"]').getByRole("navigation", { name: "Widget" });
  await expect(panel.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/portal/widget");
  await panel.getByRole("link", { name: "Feedback" }).click();
  await expect(panel.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await checkpoint(visitor, "portal-on-site-widget");
  const direct = await newPerson(browser, portalUrl(slug));
  await direct.goto("/portal/docs");
  await expect(direct.getByRole("heading", { name: "How can we help?" }).first()).toBeVisible();
  await expect(direct.locator("#team-html")).toHaveCount(0);
  await expect(direct.locator("body")).not.toHaveAttribute("data-team-script", "ran");
  // Customize → Widget says the same as for any portal beside its switch: nothing about a path.
  await owner.goto(`/app/${slug}/customize/widget`);
  await expect(owner.getByText("The launcher on every page of your portal too, opening the same panel as on your site.")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/domain`);

  // Signing up, posting and signing out there, all under the path (the panel closed: it's over the header's corner).
  await visitor.reload();
  await visitor.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/sign-in?next=%2Fdocs`);
  // The account is made on the app (a password is never typed on the team's site), and back under the path.
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await expect(visitor).toHaveURL(new RegExp(`^${APP_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sign-up\\?`));
  const email = `e2e-${randomUUID()}@example.com`;
  await fillSignUp(visitor, "Ada", email);
  await visitor.waitForURL((url) => url.pathname === "/continue");
  await backToPortal(visitor);
  await expect(visitor).toHaveURL(`${siteUrl()}/portal/docs`);
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  await visitor.goto("/portal/feedback/feature-requests");
  await visitor.getByRole("button", { name: "New idea" }).click();
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
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // The Help center: two docs tabs, a collection with one in it (and one in the other tab), and articles (one close to a question for the AI, one
  // read today, so Home suggests it). Ideas for Feedback, an update for What's new that completes one, and Messages on.
  const api = await apiFor(owner, slug);
  const collection = await api("/collections", { name: "Getting started" });
  const question = `How do I add a colleague to Acme ${slug}?`;
  await similar(question, "Inviting your team\n\nOwners send invites from the Team page.", 0.8);
  const inviting = await api("/articles", { title: "Inviting your team", body: "Owners send invites from the Team page.", collection: collection.slug });
  await api(`/articles/${inviting.slug}/publish`, {});
  const exporting = await api("/articles", { title: "Exporting your data", body: "Download a CSV of every post." });
  await api(`/articles/${exporting.slug}/publish`, {});
  const advanced = await api("/collections", { name: "Advanced", parent: collection.slug });
  const roles = await api("/articles", { title: "Roles", body: "Who can do what.", collection: advanced.slug });
  await api(`/articles/${roles.slug}/publish`, {});
  await api("/tabs", { name: "Guides" });
  await api("/tabs", { name: "API" });
  const endpoints = await api("/collections", { name: "Endpoints", tab: "api" });
  const keys = await api("/articles", { title: "API keys", body: "Make one in Settings.", collection: endpoints.slug });
  await api(`/articles/${keys.slug}/publish`, {});
  // One that links to others: by the portal's Tuti address, and by its address on the site (once that's set up).
  const text = (words: string, href?: string) => ({ type: "text", text: words, ...(href && { marks: [{ type: "link", attrs: { href } }] }) });
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [text("Start with "), text("inviting people", `${portalUrl(slug)}/docs/${inviting.slug}`), text(", then "), text("roles", `${siteUrl()}/help/docs/${roles.slug}`)],
      },
    ],
  };
  const setup = await api("/articles", { title: "Team setup", content });
  await api(`/articles/${setup.slug}/publish`, {});
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO article_view_day ("articleId", day, views) SELECT a.id, (now() AT TIME ZONE 'UTC')::date, 1 FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`,
    [slug, exporting.slug],
  );
  await db.end();
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts", { board: "feature-requests", title: "CSV export" });
  await api("/changelog", { title: "CSV export is here", posts: [2] });
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

  // Home's cards and suggested article.
  await expect(visitor.getByRole("link", { name: /^Send us a message/ })).toHaveAttribute("href", "/help/widget?tab=messages");
  await expect(visitor.getByRole("link", { name: /^Share an idea/ })).toHaveAttribute("href", "/help/widget?tab=feedback");
  await expect(visitor.getByRole("list", { name: "Suggested articles" }).getByRole("link", { name: "Exporting your data" })).toHaveAttribute(
    "href",
    `/help/widget?tab=docs&article=${exporting.slug}`,
  );

  // What's new, an update and back.
  await visitor.getByRole("link", { name: /^What's new/ }).click();
  await expect(visitor).toHaveURL(at("?tab=whats-new"));
  await visitor.getByRole("link", { name: /^Read more/ }).click();
  await expect(visitor).toHaveURL(at("?tab=whats-new&entry=1"));
  await expect(visitor.getByRole("link", { name: "CSV export", exact: true })).toHaveAttribute("href", "/help/feedback/feature-requests/csv-export-2");
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
  // Once the page's script runs (its Search button goes), the box searches in the page; nothing found, it offers all
  // articles; cleared, it's back to them.
  const docsSearch = visitor.getByRole("searchbox", { name: "Search the docs" });
  await expect(visitor.getByRole("search").filter({ has: docsSearch })).toHaveAttribute("action", "/help/widget");
  await expect(visitor.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
  await docsSearch.fill("invite");
  await docsSearch.press("Enter");
  await expect(visitor).toHaveURL(at("?tab=docs&q=invite"));
  await docsSearch.fill("qwxyz");
  await docsSearch.press("Enter");
  await expect(visitor).toHaveURL(at("?tab=docs&q=qwxyz"));
  await expect(visitor.getByRole("link", { name: "All articles" })).toHaveAttribute("href", "/help/widget?tab=docs");
  await docsSearch.fill("");
  await expect(visitor).toHaveURL(at("?tab=docs"));

  // The tabs, a collection, an article and the ways back.
  await tabs.getByRole("link", { name: "Help center" }).click();
  await expect(visitor).toHaveURL(at("?tab=docs"));
  await expect(visitor.getByRole("navigation", { name: "Docs tabs" }).getByRole("link", { name: "API" })).toHaveAttribute("href", "/help/widget?tab=docs&docsTab=api");
  await expect(visitor.getByRole("link", { name: "Exporting your data" })).toHaveAttribute("href", `/help/widget?tab=docs&docsTab=guides&article=${exporting.slug}`);
  await visitor.getByRole("link", { name: /^Getting started/ }).click();
  await expect(visitor).toHaveURL(under({ tab: "docs", collection: collection.slug }));
  await expect(visitor.getByRole("link", { name: /^Advanced/ })).toHaveAttribute("href", `/help/widget?tab=docs&docsTab=guides&collection=${advanced.slug}`);
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

  // The docs' AI: its sources open in the panel there, and after asking a person, so does Messages.
  await tabs.getByRole("link", { name: "Help center" }).click();
  await visitor.getByRole("searchbox", { name: "Search the docs" }).fill(question);
  await visitor.getByRole("searchbox", { name: "Search the docs" }).press("Enter");
  await nextModelReply(JSON.stringify({ answer: "Owners send invites from the Team page.", sources: ["s1"] }), question);
  await visitor.getByRole("button", { name: `Ask AI: ${question}` }).click();
  const ai = visitor.getByRole("dialog", { name: "Assistant" }).getByRole("log", { name: "Conversation" });
  await expect(ai.getByText("Owners send invites from the Team page.")).toBeVisible();
  await expect(ai.getByRole("list", { name: "Sources" }).getByRole("link", { name: "Inviting your team" })).toHaveAttribute(
    "href",
    `/help/widget?tab=docs&article=${inviting.slug}`,
  );
  await ai.getByRole("button", { name: "Not helpful" }).click();
  await ai.getByRole("button", { name: "Ask a person" }).click();
  const askAPerson = ai.getByRole("form", { name: "Ask a person" });
  await askAPerson.getByLabel("Your email").fill(`e2e-ask-${slug}@example.com`);
  await nextModelReply("They want to add a colleague.", question);
  await askAPerson.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", "/help/widget?tab=messages");
  await checkpoint(visitor, "widget-under-path-ai");

  // Signed in there, Messages listens for changes through the site too.
  await visitor.goto("/help/sign-up");
  await fillSignUp(visitor, "Ada", `e2e-${randomUUID()}@example.com`);
  await visitor.waitForURL((url) => url.pathname === "/continue");
  await backToPortal(visitor);
  await expect(visitor.getByRole("button", { name: "Account" })).toBeVisible();
  const live = visitor.waitForRequest((request) => request.url().includes("/api/widget/live"));
  await visitor.goto("/help/widget?tab=messages");
  expect(new URL((await live).url()).pathname).toBe("/help/api/widget/live");
  await checkpoint(visitor, "widget-under-path-messages");

  // Their idea's news on Home opens it on the portal there. Home shows the portal's reader once the page around the
  // panel says it signs nobody in, as the portal's own launcher does: here, a page of the site framing the panel.
  await visitor.goto("/help/feedback/feature-requests/dark-mode-1");
  const voted = visitor.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  await visitor.getByRole("button", { name: /^Upvote/ }).click();
  expect((await voted).ok()).toBe(true);
  await api("/posts/1", { status: "planned" }, "PATCH");
  await visitor.route(`${siteUrl()}/our-app`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe title="Panel" src="/help/widget" style="width:400px;height:700px"></iframe>
        <script>addEventListener("message", (event) => event.data?.type === "tuti:ready" && event.source.postMessage({ type: "tuti:identify", token: null }, "*"));</script>`,
    }),
  );
  await visitor.goto("/our-app");
  const panel = visitor.frameLocator('iframe[title="Panel"]');
  await expect(panel.getByText("Hi Ada")).toBeVisible();
  await expect(panel.getByRole("region", { name: "Your ideas" }).getByRole("link", { name: /Dark mode is now Planned/ })).toHaveAttribute(
    "href",
    "/help/feedback/feature-requests/dark-mode-1",
  );

  // An article's links to others, at either address, stay under the path: on its page, and in the panel.
  const linkReader = await newPerson(browser, siteUrl());
  await linkReader.goto(`/help/docs/${setup.slug}`);
  const page = linkReader.getByRole("article");
  for (const [name, article] of [["inviting people", inviting.slug], ["roles", roles.slug]]) {
    await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("href", `/help/docs/${article}`);
    await expect(page.getByRole("link", { name, exact: true })).not.toHaveAttribute("target", /.*/);
  }
  await linkReader.goto(`/help/widget?tab=docs&article=${setup.slug}`);
  await expect(linkReader.getByRole("article").getByRole("link", { name: "roles", exact: true })).toHaveAttribute("href", `/help/widget?tab=docs&article=${roles.slug}`);

  // Private, the panel asks people to sign in there.
  await owner.goto(`/app/${slug}/settings/access`);
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();
  const stranger = await newPerson(browser, siteUrl());
  await stranger.goto("/help/widget");
  await expect(stranger.getByText("Sign in to see this.", { exact: false })).toBeVisible();
  await expect(stranger.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/help/sign-in");
});
