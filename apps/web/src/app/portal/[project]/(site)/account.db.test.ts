import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import AccountPage from "./account/page";

// Links that come back to the page with its query, and the forms' router.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/account",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

/** The Account's email switches only for people the project's emails about posts may reach (whyNotEmailedAboutPosts); the rest are told why. */
test("the Account's email switches for people its emails about posts may reach; the team, another project's sign-on, a private portal's non-reader and an SSO user without an address are told why not", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  const account = async () =>
    renderToStaticMarkup(await AccountPage({ params: Promise.resolve({ project: project.slug }) } as never)).replace(/&#x27;/g, "'");
  const person = async (name: string, emailVerified: boolean) => {
    const user = await signUp(name);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified } });
    return user;
  };
  const switches = 'role="switch"';

  // A confirmed reader: switches, no reason, nothing to do.
  const reader = await person("Reader", true);
  actAs(reader);
  const confirmed = await account();
  expect(confirmed).toContain(switches);
  expect(confirmed).toContain("Posts I voted on or follow");
  expect(confirmed).not.toContain("about posts.");
  expect(confirmed).not.toContain("Confirm your email address");
  // Not confirmed yet: the switches (confirming is all it takes), and above them what to do, with Resend email.
  actAs(await person("Unconfirmed", false));
  const unconfirmed = await account();
  expect(unconfirmed).toContain(switches);
  expect(unconfirmed).not.toContain("about posts.");
  expect(unconfirmed).toMatch(/Confirm your email address to get these\.<\/p><button[^>]*>Resend email<\/button>/);
  expect(unconfirmed.indexOf("Confirm your email address to get these.")).toBeLessThan(unconfirmed.indexOf(switches));
  // Stopping the project's emails needs a proven address (the opt-out counts against it): off for them, on for a confirmed reader.
  const stop = /<input [^>]*id="email-unsubscribed"[^>]*>/;
  expect(unconfirmed.match(stop)![0]).toContain('disabled=""');
  expect(confirmed.match(stop)![0]).not.toContain('disabled=""');

  // The team: audienceReach never emails it about posts (the changelog, which it gets like anyone, keeps its switch).
  actAs(owner);
  const team = await account();
  expect(team).not.toContain('id="email-followedPosts"');
  expect(team).toContain('id="email-changelog"');
  expect(team).toContain(`${project.name} doesn't email its team about posts.`);

  // Signed in through another project's single sign-on: they can't post, vote or follow here (canActIn), so saving is refused too.
  const elsewhere = await person("Elsewhere", false);
  await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-1", userId: elsewhere.id, email: "e2e-elsewhere@example.com" } });
  actAs(elsewhere);
  const outsider = await account();
  expect(outsider).not.toContain(switches);
  expect(outsider).toContain(`This account is signed in through another site's single sign-on, so ${project.name} doesn't email it about posts.`);
  expect(outsider).toMatch(/<a [^>]*href="[^"]*\/sign-in[^"]*"[^>]*>Sign in<\/a> to choose your emails here./);
  // Their name and their (empty) lists stay.
  expect(outsider).toContain("My posts");
  // Their placeholder address isn't confirmed either, but there's nothing to confirm here.
  expect(outsider).not.toContain("Confirm your email address");

  // This project's sign-on gave no address: nothing to email.
  const noAddress = await person("No address", false);
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "user-2", userId: noAddress.id } });
  actAs(noAddress);
  const unaddressed = await account();
  expect(unaddressed).not.toContain(switches);
  expect(unaddressed).toContain(`${project.name}'s sign-in didn't give this account an email address, so it can't be emailed about posts.`);
  // Having turned these off, or unsubscribed, before the address went: still the reason, not switches.
  for (const choice of [
    () => prisma.emailPreference.create({ data: { projectId: project.id, userId: noAddress.id, followedPosts: false } }),
    () => prisma.emailOptOut.create({ data: { projectId: project.id, userId: noAddress.id } }),
  ]) {
    await choice();
    const chose = await account();
    expect(chose).not.toContain(switches);
    expect(chose).toContain(`${project.name}'s sign-in didn't give this account an email address, so it can't be emailed about posts.`);
  }

  // A private portal they can't read (the proxy keeps them off its pages; the page says so all the same).
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  actAs(reader);
  const shut = await account();
  expect(shut).not.toContain(switches);
  expect(shut).toContain(`${project.name}'s portal is private, and it doesn't email this account about posts.`);
});
