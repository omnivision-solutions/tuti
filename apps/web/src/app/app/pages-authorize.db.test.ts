import { readdirSync } from "node:fs";

import { prisma } from "@tuti/db";
import { isValidElement } from "react";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import FeedbackPage from "./[project]/feedback/page";

/**
 * Every page under /app checks who's asking itself, before it loads anything: a request can render a page without the
 * layouts above it, so a layout's check (signed in, on the team, an admin) never stands in for the page's own.
 */

type Page = (props: unknown) => unknown;

/** Owners' and admins' only: under their layouts, and Setup. */
const adminOnly = (file: string) => /^\[project\]\/(customize\/|settings\/\(admin\)\/|setup\/)/.test(file);

const pages = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith("page.tsx"))
  .sort();

let project: Awaited<ReturnType<typeof createProject>>;
let outsider: TestUser;
let member: TestUser;
let owner: TestUser;

/** One of each record the pages open, so a page that doesn't check would find it. */
let records: { post: { id: string; number: number }; article: { id: string; slug: string }; change: { id: string }; entry: number; conversation: number; collection: string; tab: string; user: string };

beforeAll(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  outsider = await signUp("Outsider");
  await createProject(outsider);
  member = await addMember(project.id, "MEMBER");

  const projectId = project.id;
  const post = await prisma.post.create({ data: { projectId, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode" } });
  const tab = await prisma.docsTab.create({ data: { projectId, slug: "guides", name: "Guides" } });
  const collection = await prisma.collection.create({ data: { projectId, tabId: tab.id, slug: "billing", name: "Billing" } });
  const article = await prisma.article.create({ data: { projectId, collectionId: collection.id, slug: "plans", title: "Plans", body: "" } });
  const change = await prisma.codeChange.create({
    data: {
      projectId,
      repoId: 1,
      repo: "acme/app",
      number: 1,
      url: "https://github.com/acme/app/pull/1",
      title: "Dark mode",
      author: "octo",
      mergedAt: new Date(),
      state: "READY",
      actions: {
        create: [
          { kind: "MOVES_FORWARD", postId: post.id, probability: 0.9 },
          { kind: "ARTICLE_EDIT", articleId: article.id, probability: 0.9 },
        ],
      },
    },
  });
  await prisma.changelogEntry.create({ data: { projectId, number: 1, title: "Dark mode", body: "" } });
  await prisma.conversation.create({ data: { projectId, number: 1, subject: "Help", status: "OPEN", origin: "API", lastMessageAt: new Date() } });
  const customer = await signUp("Customer");
  await prisma.ssoIdentity.create({ data: { projectId, externalId: "user-1", userId: customer.id, email: customer.email } });
  records = { post, article, change, entry: 1, conversation: 1, collection: collection.slug, tab: tab.slug, user: "user-1" };
});

// AI and Autopilot on, so their pages get as far as their checks. Nothing here gets past one to call it.
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "sk-or-placeholder"));

/** The params for the page in `file`: the project's, and its records', so a page that doesn't check would find them. */
function props(file: string) {
  const { post, article, change } = records;
  const id = file.includes("/feedback/[id]/") ? post.id : file.includes("/articles/[id]/") ? article.id : change.id;
  const number = file.includes("/changelog/") ? records.entry : file.includes("/inbox/") ? records.conversation : post.number;
  return {
    params: Promise.resolve({ project: project.slug, id, number: String(number), slug: article.slug, collection: records.collection, tab: records.tab, user: records.user }),
    searchParams: Promise.resolve({}),
  };
}

/** The page, and a server component it hands everything to (it may check there), as far as the first thing it shows. */
async function render(file: string, page: Page): Promise<unknown> {
  let node = await page(props(file));
  while (isValidElement(node) && typeof node.type === "function" && node.type.constructor.name === "AsyncFunction") {
    node = await (node.type as Page)(node.props);
  }
  return node;
}

/** What the page did: "refused" for not found or a redirect, "shown" if it showed anything; it failing otherwise fails the test. */
async function outcome(file: string) {
  const { default: page } = (await import(`./${file}`)) as { default: Page };
  const thrown = await render(file, page).then(
    () => "shown" as const,
    (error: unknown) => error,
  );
  if (thrown === "shown") {
    return thrown;
  }
  const digest = (thrown as { digest?: unknown }).digest;
  if (typeof digest === "string" && /^NEXT_(HTTP_ERROR_FALLBACK;404|REDIRECT;)/.test(digest)) {
    return digest.startsWith("NEXT_REDIRECT;") ? `redirect ${digest.split(";")[2]}` : "refused";
  }
  throw thrown;
}

/** Refused: not found, or sent elsewhere (a page that only redirects; where it sends you checks for itself). */
const refused = (result: string) => result === "refused" || result.startsWith("redirect ");

describe("signed out", () => {
  test.each(pages)("%s", async (file) => {
    actAs(null);
    expect(refused(await outcome(file))).toBe(true);
  });
});

describe("signed in, on another team", () => {
  test.each(pages.filter((file) => file.startsWith("[project]/")))("%s", async (file) => {
    actAs(outsider);
    expect(refused(await outcome(file))).toBe(true);
  });
});

describe("a member, on an admins' page", () => {
  test.each(pages.filter(adminOnly))("%s", async (file) => {
    actAs(member);
    expect(refused(await outcome(file))).toBe(true);
  });
});

// Without this, a page given a record that isn't there would be "not found" for anyone, checked or not.
describe("the records are real: the owner sees each page that opens one", () => {
  test.each(pages.filter((file) => /\[(?!project\])/.test(file)))("%s", async (file) => {
    actAs(owner);
    const shown = await outcome(file);
    // Those that only redirect send the owner on to the record's own page.
    expect([
      "shown",
      `redirect /app/${project.slug}/autopilot/activity/${records.change.id}`,
      `redirect /app/${project.slug}/docs/${records.article.slug}?history`,
    ]).toContain(shown);
  });
});

test("Feedback shows the team's posts to the team, and is not found for anyone else", async () => {
  actAs(member);
  await expect(FeedbackPage(props("[project]/feedback/page.tsx") as never)).resolves.toBeTruthy();
  for (const who of [null, outsider]) {
    actAs(who);
    await expect(FeedbackPage(props("[project]/feedback/page.tsx") as never)).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  }
});
