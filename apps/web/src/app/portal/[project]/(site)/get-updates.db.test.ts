import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import BoardPage from "./feedback/[board]/page";

// Links that come back to the page with its query, and the idea box's router.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

/** A board's Get updates says only what holds for the reader: what the shipped email does for them (audienceReach), or how to vote. */
test("a board's Get updates: the email promised only to whom it reaches, confirm when that's missing, unsubscribed said, sign in for who can't vote", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  // Get updates' card as HTML, then with its tags taken out.
  const getUpdatesHtml = async () => {
    const html = renderToStaticMarkup(
      await BoardPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests" }), searchParams: Promise.resolve({}) } as never),
    );
    return html.slice(html.indexOf('id="get-updates"'), html.indexOf("</aside>"));
  };
  const getUpdates = async () => (await getUpdatesHtml()).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const accountLink = /<a [^>]*href="[^"]*\/account"[^>]*>You&#x27;ve unsubscribed from these emails.<\/a>/;
  const person = async (name: string, emailVerified: boolean) => {
    const user = await signUp(name);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified } });
    return user;
  };
  const promise = "Vote for an idea to get an email when it ships.";

  actAs(null);
  expect(await getUpdates()).toContain("Vote for an idea to hear when it ships.");

  const confirmed = await person("Confirmed", true);
  actAs(confirmed);
  expect(await getUpdates()).toContain(promise);

  const unconfirmed = await person("Unconfirmed", false);
  actAs(unconfirmed);
  const asking = await getUpdates();
  expect(asking).toContain("Confirm your email to hear when ideas you vote on ship.");
  expect(asking).toContain("Resend email");
  expect(asking).not.toContain(promise);

  // Unsubscribed from the project's emails: said, not promised (nor asked to confirm).
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: confirmed.id } });
  actAs(confirmed);
  const unsubscribed = await getUpdates();
  expect(unsubscribed).toContain("You've unsubscribed from these emails.");
  expect(unsubscribed).not.toContain(promise);
  expect(unsubscribed).not.toContain("Resend email");
  // It opens their Account, where the emails turn back on.
  expect(await getUpdatesHtml()).toMatch(accountLink);

  // Emails about ideas they vote on turned off in their Account: said the same way, never promised.
  await prisma.emailOptOut.deleteMany({ where: { userId: confirmed.id } });
  await prisma.emailPreference.create({ data: { projectId: project.id, userId: confirmed.id, followedPosts: false } });
  const turnedOff = await getUpdates();
  expect(turnedOff).toContain("You've unsubscribed from these emails.");
  expect(turnedOff).not.toContain(promise);
  expect(await getUpdatesHtml()).toMatch(accountLink);
  // Only their own ideas' emails off: ideas they vote on still email them.
  await prisma.emailPreference.update({ where: { userId_projectId: { userId: confirmed.id, projectId: project.id } }, data: { ownPosts: false, followedPosts: true } });
  expect(await getUpdates()).toContain(promise);

  // Signed in through another project's single sign-on: they can't vote here, as the vote buttons say.
  const elsewhere = await person("Elsewhere", false);
  await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-1", userId: elsewhere.id, email: "e2e-elsewhere@example.com" } });
  actAs(elsewhere);
  const outsider = await getUpdates();
  expect(outsider).toContain("Sign in to vote");
  expect(outsider).not.toContain("Vote for an idea");
  expect(outsider).not.toContain("Confirm your email");
  expect(outsider).not.toContain("Resend email");

  // The team is never emailed: no promise, nor anything to do.
  actAs(owner);
  const team = await getUpdates();
  expect(team).not.toContain("Vote for an idea");
  expect(team).not.toContain("Confirm your email");
  expect(team).toContain("Changelog");
});
