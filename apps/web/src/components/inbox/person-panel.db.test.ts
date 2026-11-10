import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { userAccounts } from "@/server/operations/users";
import { upsertProjectUser } from "@/server/project-users";
import { createProject, signUp } from "@/test/helpers";

import { maybeUser, PersonPanel } from "./person-panel";

test("the hint finds the project's user whatever the capitals in their saved address, and only in that project", async () => {
  const project = await createProject(await signUp());
  const userId = await upsertProjectUser(project.id, "kim-1", { name: "Kim Lee" });
  // As an older instance may have saved it.
  await prisma.ssoIdentity.update({ where: { userId }, data: { email: "E2E-Kim@Example.com" } });
  expect(await maybeUser(project.id, "e2e-kim@example.com")).toEqual({ name: "Kim Lee", id: "kim-1" });
  const other = await createProject(await signUp());
  expect(await maybeUser(other.id, "e2e-kim@example.com")).toBeNull();
});

test("a user's page lists what they did with every account that is them, as Users counts it; not spam", async () => {
  const project = await createProject(await signUp());
  const userId = await upsertProjectUser(project.id, "bea-2", { name: "Bea Byte", email: "e2e-bea@example.com" });
  // Signed in to the portal another way, with the address verified (in capitals, as older accounts kept it).
  const portal = await prisma.user.create({ data: { id: crypto.randomUUID(), name: "Bea", email: "E2E-Bea@example.com", emailVerified: true } });
  const board = project.boards[0]!;
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: (await signUp()).id, number: 1, title: "Dark mode" } });
  await prisma.vote.create({ data: { projectId: project.id, postId: post.id, userId: portal.id } });
  // An email from the address, and one marked as spam.
  for (const [number, spam] of [[1, false], [2, true]] as const) {
    await prisma.conversation.create({
      data: { projectId: project.id, number, subject: spam ? "Cheap pills" : "Invoices", origin: "EMAIL", email: "e2e-bea@example.com", emailVerified: true, spam },
    });
  }
  const accounts = await userAccounts(project.id, { userId, email: "e2e-bea@example.com" });
  expect(accounts.sort()).toEqual([userId, portal.id].sort());
  const html = renderToStaticMarkup(
    await PersonPanel({ projectId: project.id, slug: project.slug, person: { userId, email: "e2e-bea@example.com", emailVerified: true, accounts } }),
  );
  expect(html).toContain("Dark mode");
  expect(html).toContain("Invoices");
  expect(html).not.toContain("Cheap pills");
});

test("someone who marked the project's email as spam says so: replies aren't emailed to them any more", async () => {
  const project = await createProject(await signUp());
  const other = await createProject(await signUp());
  const ids = await Promise.all([project, other].map((p) => upsertProjectUser(p.id, "ann-3", { name: "Ann Ash", email: "E2E-Ann@example.com" })));
  // Their page in Users, and beside a conversation in the Inbox.
  const panel = async (p: typeof project, userId: string, page: boolean) =>
    renderToStaticMarkup(await PersonPanel({ projectId: p.id, slug: p.slug, person: { userId, email: null, emailVerified: true }, page }));
  const notice = "Marked your email as spam, so replies aren&#x27;t emailed to them any more.";
  expect(await panel(project, ids[0]!, true)).not.toContain(notice);
  // As SES's complaint saves it: lowercase.
  await prisma.emailBlock.create({ data: { projectId: project.id, email: "e2e-ann@example.com" } });
  expect(await panel(project, ids[0]!, true)).toContain(notice);
  expect(await panel(project, ids[0]!, false)).toContain(notice);
  // Only that project's.
  expect(await panel(other, ids[1]!, true)).not.toContain(notice);
});

test("Inbox properties are retained in collapsed Company and Customer details sections, while Users shows them all", async () => {
  const project = await createProject(await signUp());
  const panel = async (externalId: string, properties: Record<string, string | number>) => {
    const userId = await upsertProjectUser(project.id, externalId, { name: externalId, properties });
    const props = { projectId: project.id, slug: project.slug, person: { userId, email: null, emailVerified: true }, besides: 1 };
    const html = renderToStaticMarkup(await PersonPanel(props));
    const sections = [...html.matchAll(/<details([^>]*)>([\s\S]*?)<\/details>/g)];
    const values = (body: string) => [...body.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map((m) => m[1]);
    const section = (title: string) => {
      const match = sections.find(([, , body]) => body!.includes(`>${title}</span>`))!;
      expect(match).toBeDefined();
      expect(match[1]).not.toContain("open");
      return values(match[2]!);
    };
    const page = renderToStaticMarkup(await PersonPanel({ ...props, page: true }));
    expect(values(page).sort()).toEqual(Object.values(properties).map(String).sort());
    return { company: section("Company"), customer: section("Customer details") };
  };
  // The key properties keep their order and case-insensitive grouping, under Company.
  expect(await panel("lee-1", { role: "admin", seats: 40, Company: "Initech", plan: "Business", region: "EU" })).toEqual({ company: ["Initech", "Business", "40"], customer: ["admin", "EU"] });
  // With no business properties, every property remains under Customer details.
  expect(await panel("lee-2", { zone: "EU", role: "admin", tier: "gold", team: "Ops" })).toEqual({ company: [], customer: ["admin", "Ops", "gold", "EU"] });
});
