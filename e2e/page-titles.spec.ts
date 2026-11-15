import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "./fixtures";

import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

const meta = (page: Page, selector: string) => page.locator(`head meta[${selector}]`).getAttribute("content");
/** The tab's title, after the count of unread conversations the app puts before it ("(1) "), if there are any. */
const tabSays = (page: Page, title: string) => expect(page).toHaveTitle(new RegExp(`^(\\(\\d+\\) )?${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

test("The app's tabs say the page and the project, its pages keep out of search, and a shared sign-in link shows Tuti's card; the portal stays the team's", async ({ browser }) => {
  // Signed out: sign-in's tab, kept out of search, and a card for a shared link with Tuti's image, served.
  const visitor = await newPerson(browser, APP_URL);
  await visitor.goto("/app/auth/sign-in");
  await expect(visitor).toHaveTitle("Sign in · Tuti");
  expect(await meta(visitor, 'name="robots"')).toBe("noindex, nofollow");
  expect(await meta(visitor, 'property="og:description"')).toBe(
    "The help center that stays in sync with your code: docs, AI answers, an inbox, feedback, a roadmap and a changelog.",
  );
  expect(await meta(visitor, 'name="twitter:card"')).toBe("summary_large_image");
  // On a phone's home screen, the parrot.
  expect(await visitor.locator('head link[rel="apple-touch-icon"]').getAttribute("href")).toMatch(/^\/app\/apple-icon\.png/);
  const image = (await meta(visitor, 'property="og:image"'))!;
  expect(image.startsWith(`${APP_URL}/app/auth/opengraph-image`)).toBe(true);
  const response = await visitor.request.get(image);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");

  // The licence page, served signed out (self-hosted servers send buyers there): the same card.
  await visitor.goto("/app/license");
  expect((await meta(visitor, 'property="og:image"'))!.startsWith(`${APP_URL}/app/auth/opengraph-image`)).toBe(true);

  // The API's reference: its own title, kept out of search too.
  await visitor.goto("/api/docs");
  await expect(visitor).toHaveTitle("API · Tuti");
  expect(await meta(visitor, 'name="robots"')).toBe("noindex, nofollow");

  // Signed in: the page, then the project ("Inbox · Acme"); a post's tab is its title.
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme $$", slug);
  // Home, in the same segment as the project's template: the project, then Tuti.
  await expect(owner).toHaveTitle("Acme $$ · Tuti");
  expect(await meta(owner, 'name="robots"')).toBe("noindex, nofollow");
  const api = await apiFor(owner, slug);
  await expect(owner).toHaveTitle("Developers · Settings · Acme $$");
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(owner).toHaveTitle("Inbox · Acme $$");
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner).toHaveTitle("Dark mode · Acme $$");
  await owner.goto(`/app/${slug}/docs`);
  await expect(owner).toHaveTitle("Docs · Acme $$");
  // A conversation's subject, an article's title, a changelog entry's.
  await api("/conversations", { email: "e2e-asker@example.com", subject: "Charged $$ twice", body: "Two charges on my card this month." });
  await owner.goto(`/app/${slug}/inbox/1`);
  await tabSays(owner, "Charged $$ twice · Acme $$");
  await api("/articles", { title: "Inviting your team", body: "Owners send invites from the Team page." });
  await owner.goto(`/app/${slug}/docs/inviting-your-team`);
  await tabSays(owner, "Inviting your team · Acme $$");
  // After the count of open conversations, a post's own "(2)" stays.
  await api("/posts", { board: "feature-requests", title: "(2) Export fails on Safari" });
  await owner.goto(`/app/${slug}/p/2`);
  await expect(owner).toHaveTitle("(1) (2) Export fails on Safari · Acme $$");
  await api("/changelog", { title: "Dark mode is here", body: "Everywhere." });
  await owner.goto(`/app/${slug}/changelog/1`);
  await tabSays(owner, "Dark mode is here · Changelog · Acme $$");

  // An invite link: its tab says what it's for, like the page, while the card a shared link shows stays Tuti's.
  await owner.goto(`/app/${slug}/team`);
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill("e2e-invitee@example.com");
  await owner.getByRole("button", { name: "Send invite" }).click();
  const link = await owner.getByRole("alert").locator("code").innerText();
  await visitor.goto(link);
  await expect(visitor).toHaveTitle("Join Acme $$ · Tuti");
  expect(await meta(visitor, 'property="og:title"')).toBe("Tuti");
  expect(await meta(visitor, 'name="twitter:title"')).toBe("Tuti");
  // Revoked, it names no project.
  await owner.getByRole("button", { name: "Revoke" }).click();
  await expect(owner.getByText("Invite revoked")).toBeVisible();
  await visitor.reload();
  await expect(visitor).toHaveTitle("Invite · Tuti");

  // The portal is the team's: its own name, no "· Tuti", and open to search.
  await visitor.goto(portalUrl(slug));
  await expect(visitor).toHaveTitle(/Acme/);
  await expect(visitor).not.toHaveTitle(/Tuti/);
  await expect(visitor.locator('head meta[name="robots"]')).toHaveCount(0);
});
