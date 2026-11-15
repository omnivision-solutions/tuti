import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "./fixtures";

import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

const meta = (page: Page, selector: string) => page.locator(`head meta[${selector}]`).getAttribute("content");

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

  // Signed in: the page, then the project ("Inbox · Acme"); a post's tab is its title.
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // Home, in the same segment as the project's template: the project, then Tuti.
  await expect(owner).toHaveTitle("Acme · Tuti");
  expect(await meta(owner, 'name="robots"')).toBe("noindex, nofollow");
  const api = await apiFor(owner, slug);
  await expect(owner).toHaveTitle("Developers · Settings · Acme");
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(owner).toHaveTitle("Inbox · Acme");
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner).toHaveTitle("Dark mode · Acme");
  await owner.goto(`/app/${slug}/docs`);
  await expect(owner).toHaveTitle("Docs · Acme");

  // The portal is the team's: its own name, no "· Tuti", and open to search.
  await visitor.goto(portalUrl(slug));
  await expect(visitor).toHaveTitle(/Acme/);
  await expect(visitor).not.toHaveTitle(/Tuti/);
  await expect(visitor.locator('head meta[name="robots"]')).toHaveCount(0);
});
