import { randomUUID } from "node:crypto";

import { expect, type Route, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, postFeedback, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("a portal's Account: email settings the emails follow, and the reader's posts and votes", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada (email verified) posts two ideas; Bo (verified too) posts one and votes for hers.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  await postFeedback(ada, "Offline mode");
  // A long address, as company and single sign-on ones are: "Signed in as" wraps it on a phone.
  const bo = await signUp(browser, portalUrl(slug), "Bo", `e2e-${randomUUID().replaceAll("-", "")}withalongcompanyaddress@example.com`);
  await bo.goto(linkIn(await latestEmailTo(bo.email), "http"));
  await bo.goto("/feedback/feature-requests");
  await postFeedback(bo, "Export invoices");
  for (const path of ["dark-mode-1", "offline-mode-2"]) {
    await bo.goto(`/feedback/feature-requests/${path}`);
    await bo.getByRole("button", { name: "Upvote" }).click();
    await expect(bo.getByRole("button", { name: "Upvoted" })).toBeEnabled();
  }

  // From the account menu: Bo's posts and votes, each linking to it.
  await bo.getByRole("button", { name: "Account" }).click();
  await bo.getByRole("menuitem", { name: "Account settings" }).click();
  await bo.waitForURL("**/account");
  // His name, read only: it's his Tuti account's, changed on the app.
  const profile = bo.getByRole("region", { name: "Profile" });
  await expect(profile).toContainText("Bo");
  await expect(profile.getByRole("textbox")).toHaveCount(0);
  await expect(profile.getByRole("link", { name: "Change your name in your Tuti account" })).toHaveAttribute("href", `${APP_URL}/app/account`);
  await checkpoint(bo, "portal-account-profile");
  await expect(bo.getByRole("heading", { level: 1 })).toHaveText("Account");
  await expect(bo.getByRole("region", { name: "Your posts" }).getByRole("link")).toHaveText(["Export invoices"]);
  await expect(bo.getByRole("region", { name: "Your votes" }).getByRole("link")).toHaveText(["Offline mode", "Dark mode"]);
  // The section list jumps within the page, the one picked marked; scrolling back up marks the one there.
  const sections = bo.getByRole("navigation", { name: "Account sections" });
  await expect(sections.getByRole("link")).toHaveText(["Profile", "Emails", "Your posts 1", "Your votes 2"]);
  await expect(sections.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "location");
  // Opened in a new tab (Ctrl/Cmd-click): this page stays where it is, Profile still marked.
  const tab = bo.context().waitForEvent("page");
  await sections.getByRole("link", { name: /Your votes/ }).click({ modifiers: ["ControlOrMeta"] });
  await (await tab).close();
  expect(await bo.evaluate(() => window.scrollY)).toBe(0);
  await expect(sections.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "location");
  // From the keyboard, as a hash link: the next Tab goes on inside the section jumped to (a screen reader is taken there too).
  await sections.getByRole("link", { name: /Your votes/ }).focus();
  await bo.keyboard.press("Enter");
  await expect(bo.getByRole("heading", { name: "Your votes" })).toBeInViewport();
  await bo.keyboard.press("Tab");
  await expect(bo.getByRole("region", { name: "Your votes" }).getByRole("link", { name: "Offline mode" })).toBeFocused();
  await bo.mouse.wheel(0, -5000);
  await expect(sections.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "location");
  // Clicked, even when the address already has its hash (as a hash link, it jumps again).
  await sections.getByRole("link", { name: /Your votes/ }).click();
  await expect(bo).toHaveURL(/\/account#votes$/);
  await expect(sections.getByRole("link", { name: /Your votes/ })).toHaveAttribute("aria-current", "location");
  await expect(sections.getByRole("link", { name: "Profile" })).not.toHaveAttribute("aria-current");
  await expect(bo.getByRole("heading", { name: "Your votes" })).toBeInViewport();
  // Hairlines between a list's rows only, none under the last.
  const voteRows = bo.getByRole("region", { name: "Your votes" }).getByRole("listitem");
  await expect(voteRows.first()).toHaveCSS("border-bottom-width", "1px");
  await expect(voteRows.last()).toHaveCSS("border-bottom-width", "0px");
  await bo.mouse.wheel(0, -5000);
  await expect(sections.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "location");
  // Back to a section after leaving the page: the Account again (the section links are the router's), at that section.
  await sections.getByRole("link", { name: /Your votes/ }).click();
  await bo.getByRole("banner").getByRole("link", { name: "Roadmap" }).click();
  await bo.waitForURL("**/roadmap");
  await bo.goBack();
  await expect(bo).toHaveURL(/\/account#votes$/);
  await expect(bo.getByRole("heading", { name: "Your votes" })).toBeInViewport();
  await expect(sections.getByRole("link", { name: /Your votes/ })).toHaveAttribute("aria-current", "location");
  // A section mid-page (Emails, which the page can bring to its top): the jump stops it at the line under the header, so
  // it stays marked as the reader scrolls on a little, and when the page is opened at its hash.
  const wide = bo.viewportSize()!;
  await bo.setViewportSize({ width: 1280, height: 480 });
  const emailsTop = () => bo.getByRole("region", { name: "Emails" }).evaluate((section) => section.getBoundingClientRect().top + window.scrollY);
  expect(await bo.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan((await emailsTop()) + 100);
  await sections.getByRole("link", { name: "Emails" }).click();
  await expect(bo).toHaveURL(/\/account#emails$/);
  await bo.mouse.wheel(0, 10);
  await expect.poll(() => bo.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await bo.waitForTimeout(200);
  await expect(sections.getByRole("link", { name: "Emails" })).toHaveAttribute("aria-current", "location");
  await bo.goto("/roadmap");
  await bo.goto("/account#emails");
  await expect(bo.getByRole("heading", { name: "Emails" })).toBeInViewport();
  await expect(sections.getByRole("link", { name: "Emails" })).toHaveAttribute("aria-current", "location");
  await bo.setViewportSize(wide);
  await bo.getByRole("region", { name: "Your votes" }).getByRole("link", { name: "Dark mode" }).click();
  await expect(bo.getByRole("heading", { level: 1 })).toHaveText("Dark mode");

  // Bo stops emails about posts he voted on; it's kept.
  await bo.goto("/account");
  const followed = bo.getByRole("switch", { name: "Posts I voted on or follow" });
  await expect(followed).toBeChecked();
  // From the keyboard, which keeps its focus while it saves.
  await followed.focus();
  await bo.keyboard.press("Space");
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await expect(followed).toBeFocused();
  await bo.reload();
  await expect(followed).not.toBeChecked();
  await expect(bo.getByRole("switch", { name: "Posts I wrote" })).toBeChecked();

  // The board's Get updates says so, and opens his Account to turn them back on.
  await bo.goto("/feedback/feature-requests");
  await bo.getByRole("main").getByRole("button", { name: "Get updates" }).click();
  const updates = bo.getByRole("dialog", { name: "Get updates" });
  await expect(updates).not.toContainText("Vote for an idea to get an email when it ships.");
  await checkpoint(bo, "board-get-updates-unsubscribed");
  await updates.getByRole("link", { name: "You've unsubscribed from these emails." }).click();
  await bo.waitForURL("**/account");
  await expect(followed).not.toBeChecked();

  // Clicked three times while the first save is still going, and it fails: the last click is what's saved and shown
  // (the failure doesn't put the switch back over the clicks after it). The first save fails once the clicks are done.
  const wrote = bo.getByRole("switch", { name: "Posts I wrote" });
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
  let seen = 0;
  await bo.route("**/account", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    if (++seen === 1) {
      await firstHeld;
      return route.abort();
    }
    return route.fallback();
  });
  await wrote.click();
  await wrote.click();
  await wrote.click();
  releaseFirst();
  await expect(bo.getByText("Couldn't save your email settings. Try again.")).toBeVisible();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await expect(wrote).not.toBeChecked();
  await bo.unroute("**/account");
  await bo.reload();
  await expect(wrote).not.toBeChecked();
  await wrote.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();

  // A save that fails (offline, say) puts the switch back and says so. Clicked, not uncheck(): it goes back.
  await bo.route("**/account", (route) => (route.request().method() === "POST" ? route.abort() : route.fallback()));
  await wrote.click();
  await expect(bo.getByText("Couldn't save your email settings. Try again.")).toBeVisible();
  await expect(wrote).toBeChecked();
  await bo.unroute("**/account");
  await bo.reload();
  await expect(wrote).toBeChecked();

  // Bo gets the changelog from here: his address is confirmed, so no email asks him to confirm it again.
  const changelog = bo.getByRole("switch", { name: "The changelog" });
  await expect(changelog).not.toBeChecked();
  await changelog.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await expect(changelog).toBeChecked();
  await checkpoint(bo, "portal-account-changelog");
  // The changelog page agrees: no form asking him to subscribe, a line saying he gets it, and its link back here.
  await bo.goto("/changelog");
  // (In the rail on wide screens, after the list below them: the copy for the other width is hidden.)
  await expect(bo.getByText(`The changelog entries Acme emails to subscribers go to ${bo.email}.`).filter({ visible: true })).toBeVisible();
  await expect(bo.getByRole("region", { name: "Get updates by email" })).toHaveCount(0);
  await checkpoint(bo, "portal-changelog-gets-it");
  const desktop = bo.viewportSize()!;
  await bo.setViewportSize({ width: 390, height: 844 });
  await checkpoint(bo, "portal-changelog-gets-it-phone");
  await bo.setViewportSize(desktop);
  await bo.getByRole("link", { name: "Manage", exact: true }).click();
  await bo.waitForURL("**/account");
  // Stopping the project's emails turns it off with them; turned back on (the page read while they were off), it shows on
  // again as the save says, without a reload.
  const stopBo = bo.getByRole("switch", { name: "Email me nothing from Acme" });
  await stopBo.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await expect(changelog).not.toBeChecked();
  await expect(changelog).toBeDisabled();
  // There too: Stop wins, said as the subscription pages say it.
  await bo.goto("/changelog");
  await expect(bo.getByText(`You've turned off all of Acme's emails, so its changelog isn't emailed to ${bo.email} either.`).filter({ visible: true })).toBeVisible();
  await checkpoint(bo, "portal-changelog-emails-off");
  await bo.goto("/account");
  await stopBo.uncheck();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await expect(changelog).toBeChecked();
  await expect(changelog).toBeEnabled();
  await bo.reload();
  await expect(changelog).toBeChecked();
  // An entry the team publishes with Email subscribers reaches him.
  const publish = async (title: string) => {
    await team.goto(`/app/${slug}/changelog/new`);
    await team.getByLabel("Title").fill(title);
    await team.getByRole("button", { name: "Save draft" }).first().click();
    await expect(team).toHaveURL(new RegExp(`/app/${slug}/changelog/\\d+$`));
    return team.getByRole("group", { name: "How it's announced" }).getByRole("checkbox", { name: "Email subscribers" });
  };
  const emailSubscribers = await publish("Dark mode is here");
  await expect(emailSubscribers).toBeChecked();
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await latestEmailTo(bo.email, { subject: /^Acme: Dark mode is here$/ });
  // Turned off, he's unsubscribed: the next entry has nobody to email.
  await changelog.uncheck();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await expect(changelog).not.toBeChecked();
  // Subscribed again with Stop on, he turns Stop off and, before that save comes back, the changelog on and off: his
  // last click (off) is what's saved and shown, not the changelog's state the Stop save answers with.
  await changelog.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await stopBo.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  let releaseStop!: () => void;
  const stopHeld = new Promise<void>((resolve) => (releaseStop = resolve));
  let sent = 0;
  await bo.route("**/account", async (route) => {
    if (route.request().method() === "POST" && ++sent === 1) {
      await stopHeld;
    }
    return route.fallback();
  });
  await stopBo.uncheck();
  await changelog.check();
  await changelog.uncheck();
  releaseStop();
  await expect(bo.getByText("Email settings saved")).toHaveCount(2);
  await expect(changelog).not.toBeChecked();
  await bo.unroute("**/account");
  await bo.reload();
  await expect(changelog).not.toBeChecked();
  await expect(stopBo).not.toBeChecked();
  await expect(await publish("Exports")).toBeDisabled();

  // At desktop and phone widths, light and dark.
  const signedIn = await bo.context().storageState();
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await (await browser.newContext({ baseURL: portalUrl(slug), viewport, colorScheme, storageState: signedIn })).newPage();
      await page.goto("/account");
      await expect(page.getByRole("switch", { name: "Posts I voted on or follow" })).not.toBeChecked();
      // Who's signed in, and Sign out in the Profile card (the page's only one).
      await expect(page.getByText(`Signed in as ${bo.email}`)).toBeVisible();
      await expect(page.getByRole("region", { name: "Profile" }).getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(1);
      // The sections' list, one of its two shapes for the width: a rail beside them, or pills above them on phones.
      const list = page.getByRole("navigation", { name: "Account sections" });
      await expect(list).toBeVisible();
      await expect(list.getByRole("link", { name: "Emails" })).toHaveClass(name === "phone" ? /rounded-full/ : /rounded-lg/);
      if (name === "phone") {
        await list.getByRole("link", { name: /Your posts/ }).click();
        await expect(page.getByRole("heading", { name: "Your posts" })).toBeInViewport();
        await expect(list.getByRole("link", { name: /Your posts/ })).toHaveAttribute("aria-current", "location");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      // The sections fill the pages' width beside the list, not a narrow column.
      if (name === "desktop") expect((await page.getByRole("region", { name: "Profile" }).boundingBox())!.width).toBeGreaterThan(800);
      await checkpoint(page, `portal-account-${name}-${colorScheme}`);
      await page.context().close();
    }
  }

  // Shipping Dark mode tells Ada, who wrote it, and not Bo, who voted for it: the team is told it emails one person.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status", { exact: true }).click();
  await team.getByRole("option", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: "Mark “Dark mode” completed?" });
  await expect(ask).toContainText("This emails up to 1 person who asked for it that it shipped.");
  await ask.getByRole("button", { name: "Mark completed" }).click();
  await expect(team.getByText("Status: Completed")).toBeVisible();
  const email = await latestEmailTo(ada.email, { subject: /^Done: Dark mode$/ });

  // Ada asks Acme to email her nothing (the switch says what still arrives): the email's unsubscribe link says she already has.
  await ada.goto("/account");
  const stop = ada.getByRole("switch", { name: "Email me nothing from Acme" });
  await expect(stop).toHaveAccessibleDescription(
    "None of the emails above, whatever you follow. Replies to your messages, sign-in emails and notices that you've been let into its private portal still arrive.",
  );
  await stop.check();
  await expect(ada.getByText("Email settings saved")).toBeVisible();
  await expect(ada.getByRole("switch", { name: "Posts I wrote" })).toBeDisabled();
  // The changelog's emails too: its switch off, until she turns them back on.
  await expect(ada.getByRole("switch", { name: "The changelog" })).not.toBeChecked();
  await expect(ada.getByRole("switch", { name: "The changelog" })).toBeDisabled();
  // The switches above it greyed with theirs, still readable.
  expect(await ada.locator('label[for="email-ownPosts"]').evaluate((label) => getComputedStyle(label).color)).not.toBe(
    await ada.locator('label[for="email-unsubscribed"]').evaluate((label) => getComputedStyle(label).color),
  );
  await checkpoint(ada, "portal-account-stopped");
  await ada.goto(linkIn(email, `${portalUrl(slug)}/unsubscribe`));
  await expect(ada.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();

  // Cy hasn't confirmed his address yet: the switches, and above them what's still needed, with Resend email.
  const cy = await signUp(browser, portalUrl(slug), "Cy");
  await cy.goto("/account");
  await expect(cy.getByText("Confirm your email address to get these.")).toBeVisible();
  await expect(cy.getByRole("switch", { name: "Posts I wrote" })).toBeChecked();
  // Stopping the project's emails waits for the confirmed address (it would count against the address).
  await expect(cy.getByRole("switch", { name: "Email me nothing from Acme" })).toBeDisabled();
  // So does the changelog: it's the address's subscription.
  await expect(cy.getByRole("switch", { name: "The changelog" })).toBeDisabled();
  await cy.getByRole("button", { name: "Resend email" }).click();
  await expect(cy.getByRole("button", { name: "Sent" })).toBeVisible();
  // No posts or votes: each says so on a soft fill, with the way to the boards.
  const noVotes = cy.getByRole("region", { name: "Your votes" });
  await expect(noVotes).toContainText("You haven't voted on others' posts here yet.");
  await expect(noVotes.getByRole("link", { name: "Browse ideas" })).toHaveAttribute("href", /\/feedback$/);
  await expect(cy.getByRole("region", { name: "Your posts" })).toContainText("You haven't posted here yet.");
  await checkpoint(cy, "portal-account-unconfirmed");
  // A page short enough to fit a tall window, which can't scroll: its first section is the current one, not the last.
  const tall = await (await browser.newContext({ baseURL: portalUrl(slug), viewport: { width: 1280, height: 3000 }, storageState: await cy.context().storageState() })).newPage();
  await tall.goto("/account");
  expect(await tall.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  const tallList = tall.getByRole("navigation", { name: "Account sections" });
  await expect(tallList.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "location");
  await expect(tallList.getByRole("link", { name: /Your votes/ })).not.toHaveAttribute("aria-current");
  // Opened with a section's hash the browser didn't scroll to (it can't scroll here; a reload or Back that restores the
  // page elsewhere is the same): the section the page shows, not the hash's.
  // (A load of its own: from /account itself, it would only be a hash change, which marks the section asked for.)
  await tall.goto("/roadmap");
  await tall.goto("/account#votes");
  await expect(tallList.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "location");
  await expect(tallList.getByRole("link", { name: /Your votes/ })).not.toHaveAttribute("aria-current");
  await tall.context().close();
  // Sign out on the page: a failed one, refused or never sent (offline), says so and stays, the button ready again; then
  // back on the portal's home, signed out.
  const signOut = cy.getByRole("button", { name: "Sign out" });
  // Each failure's own toast: ones already shown are marked, so whether the last has gone yet doesn't matter.
  const toasts = cy.locator("[data-sonner-toast]");
  const newFailure = cy.locator("[data-sonner-toast]:not([data-seen])", { hasText: "Couldn't sign you out. Try again." });
  for (const fail of [(route: Route) => route.fulfill({ status: 500, json: { message: "Down" } }), (route: Route) => route.abort()]) {
    await toasts.evaluateAll((shown) => shown.forEach((toast) => toast.setAttribute("data-seen", "")));
    await cy.route("**/sign-out", fail);
    await signOut.click();
    await expect(newFailure).toBeVisible();
    await expect(signOut).toBeEnabled();
    await expect(cy).toHaveURL(/\/account$/);
    await cy.unroute("**/sign-out");
  }
  await cy.getByRole("button", { name: "Sign out" }).click();
  await expect(cy.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await cy.goto("/account");
  await cy.waitForURL("**/sign-in?**");
});
