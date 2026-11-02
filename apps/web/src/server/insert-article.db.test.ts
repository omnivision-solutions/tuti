import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { findArticlesToInsert } from "@/server/inbox";
import { createArticle, deleteArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** "Insert article" in a reply: which articles it offers, and where their links go. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

async function write(title: string, options: { listing?: "everywhere" | "unlisted" | "hidden" | "ai_only"; access?: "signed_in"; draft?: boolean } = {}) {
  const { draft, ...fields } = options;
  const article = await call(createArticle, as(), { title, body: "How refunds work.", ...fields });
  if (!draft) {
    await call(publishArticle, as(), { slug: article.slug });
  }
  return article.slug;
}

/** A conversation with someone signed in on the portal (a user), or known only by their email address. */
async function conversation(number: number, signedIn: boolean) {
  const user = signedIn ? await signUp("Sam") : null;
  await prisma.conversation.create({
    data: { projectId: project.id, number, subject: "Refunds?", status: "OPEN", origin: "API", lastMessageAt: new Date(), userId: user?.id, email: user ? null : "e2e-asker@example.com" },
  });
  return number;
}

const titles = async (number: number, q = "refunds") => (await findArticlesToInsert(project.slug, number, q)).articles?.map((a) => a.title).sort();

test("offers published articles they can be sent a link to: listed or unlisted, never hidden, AI-only, drafts or deleted ones", async () => {
  await write("Refunds everywhere");
  await write("Refunds unlisted", { listing: "unlisted" });
  await write("Refunds hidden", { listing: "hidden" });
  await write("Refunds for AI", { listing: "ai_only" });
  await write("Refunds draft", { draft: true });
  const deleted = await write("Refunds deleted");
  await call(deleteArticle, as(), { slug: deleted });
  const number = await conversation(1, false);

  expect(await titles(number)).toEqual(["Refunds everywhere", "Refunds unlisted"]);
  // Nothing typed: nothing yet.
  expect(await titles(number, " ")).toEqual([]);
});

test("only what the conversation's person may read: a signed-in article for someone signed in, not for an email address", async () => {
  await write("Refunds for members", { access: "signed_in" });
  expect(await titles(await conversation(1, false))).toEqual([]);
  expect(await titles(await conversation(2, true))).toEqual(["Refunds for members"]);
});

test("a link goes to the article on the portal, where the team's site has it once that's verified", async () => {
  // Before anything looks the address up (it's kept a while).
  await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://acme.example", path: "/help", verificationToken: "token", verifiedAt: new Date() } });
  const slug = await write("Refunds");
  expect((await findArticlesToInsert(project.slug, await conversation(1, false), "refunds")).articles).toEqual([
    { slug, title: "Refunds", url: `https://acme.example/help/docs/${slug}` },
  ]);
});
