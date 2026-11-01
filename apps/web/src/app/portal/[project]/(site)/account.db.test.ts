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

/** The Account's email switches only for people whose choices can be saved here (setEmailPreference's canActIn). */
test("the Account's email switches for people who can act on the portal; another project's sign-on gets a line and Sign in instead", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  const account = async () =>
    renderToStaticMarkup(await AccountPage({ params: Promise.resolve({ project: project.slug }) } as never)).replace(/&#x27;/g, "'");

  const reader = await signUp("Reader");
  actAs(reader);
  const own = await account();
  expect(own).toContain('role="switch"');
  expect(own).toContain("Posts I voted on or follow");
  expect(own).not.toContain("doesn't email this account");

  // Signed in through another project's single sign-on: saving would be refused, and nothing about posts here reaches them.
  const elsewhere = await signUp("Elsewhere");
  await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-1", userId: elsewhere.id, email: "e2e-elsewhere@example.com" } });
  actAs(elsewhere);
  const outsider = await account();
  expect(outsider).not.toContain('role="switch"');
  expect(outsider).toContain(`${project.name} doesn't email this account about posts.`);
  expect(outsider).toMatch(/<a [^>]*href="[^"]*\/sign-in[^"]*"[^>]*>Sign in<\/a> to choose your emails here./);
  // Their name and their (empty) lists stay.
  expect(outsider).toContain("My posts");
});
