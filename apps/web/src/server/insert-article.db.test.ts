import { prisma } from "@tuti/db";
import { FAKE_OPENAI_KEY, startOpenAIFake } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { anyArticleToSend, readerToSend, searchDocs } from "@/server/docs-search";
import { findArticlesToInsert } from "@/server/inbox";
import { createArticle, deleteArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** "Insert article" in a reply: which articles it offers, and where their links go. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

afterEach(() => vi.unstubAllEnvs());

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

/** Whether the reply box shows "Insert article" (the conversation's page asks this). */
async function shown(number: number) {
  const { userId } = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } }, select: { userId: true } });
  return anyArticleToSend(project.id, await readerToSend(project.id, userId));
}

const titles = async (number: number, q = "refunds") => (await findArticlesToInsert(project.slug, number, q)).articles?.map((a) => a.title).sort();

test("offers published articles they can be sent a link to: listed or unlisted, never hidden, AI-only, drafts or deleted ones", async () => {
  const number = await conversation(1, false);
  expect(await shown(number)).toBe(false);
  await write("Refunds hidden", { listing: "hidden" });
  await write("Refunds for AI", { listing: "ai_only" });
  await write("Refunds draft", { draft: true });
  const deleted = await write("Refunds deleted");
  await call(deleteArticle, as(), { slug: deleted });
  // None of those: no "Insert article" yet.
  expect(await shown(number)).toBe(false);
  await write("Refunds unlisted", { listing: "unlisted" });
  expect(await shown(number)).toBe(true);
  await write("Refunds everywhere");

  expect(await titles(number)).toEqual(["Refunds everywhere", "Refunds unlisted"]);
  // Nothing typed: nothing yet.
  expect(await titles(number, " ")).toEqual([]);
});

test("only what the conversation's person may read: a signed-in article for someone signed in, not for an email address", async () => {
  await write("Refunds for members", { access: "signed_in" });
  expect(await titles(await conversation(1, false))).toEqual([]);
  expect(await titles(await conversation(2, true))).toEqual(["Refunds for members"]);
  // The button by the same rule: none for whoever can read nothing, so it never opens empty.
  expect([await shown(1), await shown(2)]).toEqual([false, true]);
});

test("nothing for someone who can't get into a private portal", async () => {
  await write("Refunds");
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await titles(await conversation(1, false))).toEqual([]);
  expect(await titles(await conversation(2, true))).toEqual([]);
  expect([await shown(1), await shown(2)]).toEqual([false, false]);
});

test("a link goes to the article on the portal, where the team's site has it once that's verified", async () => {
  // Before anything looks the address up (it's kept a while).
  await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://acme.example", path: "/help", verificationToken: "token", verifiedAt: new Date() } });
  const slug = await write("Refunds");
  expect((await findArticlesToInsert(project.slug, await conversation(1, false), "refunds")).articles).toEqual([
    { slug, title: "Refunds", url: `https://acme.example/help/docs/${slug}` },
  ]);
});

test("a search in the picker isn't a reader's: no embedding is asked for, and the team's search insights don't count it", async () => {
  const openai = await startOpenAIFake();
  try {
    vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
    vi.stubEnv("OPENAI_BASE_URL", openai.url);
    await write("Refunds");
    const number = await conversation(1, false);
    openai.inputs.length = 0;
    expect(await titles(number)).toEqual(["Refunds"]);
    expect(openai.inputs).toEqual([]);
    // A reader's search after it (one nothing matches, so its words are kept) is counted: by the time it is, the
    // picker's, sent first, would have been too.
    await searchDocs(project.id, "nothing like this", 5, null, { meaning: false });
    await expect.poll(() => prisma.docsFailedSearchDay.count({ where: { projectId: project.id } })).toBe(1);
    expect(await prisma.docsSearchDay.findMany({ where: { projectId: project.id }, select: { searches: true, failed: true } })).toEqual([{ searches: 1, failed: 1 }]);
  } finally {
    await openai.close();
  }
});
