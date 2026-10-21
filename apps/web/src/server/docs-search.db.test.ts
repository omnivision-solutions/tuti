import { prisma } from "@tuti/db";
import { articleChunkText, SEARCH_MIN_SIMILARITY } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { createArticle, deleteArticle, publishArticle, searchArticles, unpublishArticle, updateArticle } from "@/server/operations/docs";
import { searchDocs } from "@/server/docs-search";
import { call } from "@/server/operations/run";
import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/**
 * Docs search: publishing an article runs the articleChanged job inline, which
 * embeds its sections (through the OpenAI fake); articles.search ranks them by meaning,
 * then by words (all it has without a key).
 */

let openai: OpenAIFake;
let owner: TestUser;
let visitor: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  openai = await startOpenAIFake();
});
afterAll(() => openai.close());
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  openai.inputs.length = 0;
  owner = await signUp("Owner");
  visitor = await signUp("Visitor");
  project = await createProject(owner);
});

const as = (user: TestUser, projectId = project.id) => ({ actor: { kind: "user" as const, userId: user.id }, projectId });
const doc = (...content: object[]) => ({ type: "doc", content });
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });

/** A unit vector with exactly `similarity` to `along(1)` (cosine). */
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

/** Writes an article (plain `body` or rich `content`) and publishes it, unless `draft`. */
async function write(title: string, text: string | object, { draft = false, projectId = project.id } = {}) {
  const article = await call(createArticle, as(owner, projectId), typeof text === "string" ? { title, body: text } : { title, content: text });
  if (!draft) {
    await call(publishArticle, as(owner, projectId), { slug: article.slug });
  }
  return article.slug;
}

const chunks = (slug: string) =>
  prisma.articleChunk.findMany({
    where: { article: { projectId: project.id, slug } },
    orderBy: { position: "asc" },
    select: { position: true, heading: true, text: true },
  });

const search = async (q: string) => (await call(searchArticles, as(visitor), { q })).results;

describe("chunks", () => {
  const inviting = doc(p("Everyone starts alone."), h("Who can invite"), p("Owners and admins."), h("Limits"), p("Ten seats."));

  test("publishing embeds an article by sections, each with its title; drafts aren't embedded", async () => {
    const slug = await write("Inviting your team", inviting, { draft: true });
    expect(await chunks(slug)).toEqual([]);
    expect(openai.inputs).toEqual([]);

    await call(publishArticle, as(owner), { slug });
    const sections = [
      { position: 0, heading: "", text: "Everyone starts alone." },
      { position: 1, heading: "Who can invite", text: "Owners and admins." },
      { position: 2, heading: "Limits", text: "Ten seats." },
    ];
    expect(await chunks(slug)).toEqual(sections);
    expect(openai.inputs).toEqual(sections.map((section) => articleChunkText("Inviting your team", section)));
  });

  test("a published article is embedded again when changes to its text or title go live, not otherwise", async () => {
    const slug = await write("Inviting your team", inviting);
    const embedded = openai.inputs.length;

    await call(updateArticle, as(owner), { slug, content: inviting });
    await call(publishArticle, as(owner), { slug });
    expect(openai.inputs).toHaveLength(embedded);

    await call(updateArticle, as(owner), { slug, content: doc(h("Who can invite"), p("Only owners.")), publish: true });
    expect(await chunks(slug)).toEqual([{ position: 0, heading: "Who can invite", text: "Only owners." }]);

    await call(updateArticle, as(owner), { slug, title: "Adding teammates", publish: true });
    expect(openai.inputs.at(-1)).toBe(articleChunkText("Adding teammates", { heading: "Who can invite", text: "Only owners." }));
  });

  test("unpublishing or deleting an article removes its chunks", async () => {
    const first = await write("Inviting your team", inviting);
    const second = await write("Billing", "Pay by card.");
    expect(await chunks(first)).toHaveLength(3);

    await call(unpublishArticle, as(owner), { slug: first });
    expect(await chunks(first)).toEqual([]);
    // Saving the draft doesn't bring them back.
    await call(updateArticle, as(owner), { slug: first, title: "Inviting people" });
    expect(await chunks("inviting-people")).toEqual([]);

    await call(deleteArticle, as(owner), { slug: second });
    expect(await prisma.articleChunk.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("a job for an older version never overwrites the chunks of a newer one", async () => {
    const slug = await write("Inviting your team", "Anyone can invite.");
    // The next save's job waits for its embeddings while a newer save is embedded.
    const release = openai.holdNext();
    const older = call(updateArticle, as(owner), { slug, body: "Owners can invite.", publish: true });
    await vi.waitFor(() => expect(openai.inputs).toContain(articleChunkText("Inviting your team", { heading: "", text: "Owners can invite." })));
    await call(updateArticle, as(owner), { slug, body: "Owners and admins can invite.", publish: true });
    expect(await chunks(slug)).toEqual([{ position: 0, heading: "", text: "Owners and admins can invite." }]);

    release();
    await older;
    expect(await chunks(slug)).toEqual([{ position: 0, heading: "", text: "Owners and admins can invite." }]);
  });

  test("an article unpublished while it's being embedded gets no chunks", async () => {
    const slug = await write("Inviting your team", "Anyone can invite.", { draft: true });
    const release = openai.holdNext();
    const publishing = call(publishArticle, as(owner), { slug });
    await vi.waitFor(() => expect(openai.inputs).toHaveLength(1));
    await call(unpublishArticle, as(owner), { slug });

    release();
    await publishing;
    expect(await chunks(slug)).toEqual([]);
  });

  test("a failed embedding doesn't fail the save", async () => {
    const slug = await write("Inviting your team", "Anyone can invite.", { draft: true });
    openai.failNext();
    expect(await call(publishArticle, as(owner), { slug })).toMatchObject({ status: "published" });
    expect(await chunks(slug)).toEqual([]);
    // Words still find it.
    expect((await search("invite")).map((r) => r.slug)).toEqual([slug]);
  });
});

describe("search with embeddings", () => {
  const query = "add a colleague";
  /** Gives an article's section a vector this similar to the query, before it's published. */
  const near = (title: string, heading: string, text: string, similarity: number) =>
    openai.setVector(articleChunkText(title, { heading, text }), along(similarity));

  beforeEach(() => openai.setVector(query, along(1)));

  test("articles come by their closest section, once each, with that section as the snippet", async () => {
    near("Inviting your team", "Who can invite", "Owners and admins send invites.", 0.9);
    near("Inviting your team", "Limits", "Ten seats per plan.", 0.6);
    near("Roles", "", "Admins manage boards.", 0.7);
    near("Exports", "", "Download a CSV.", SEARCH_MIN_SIMILARITY - 0.05);
    const inviting = await write("Inviting your team", doc(h("Limits"), p("Ten seats per plan."), h("Who can invite"), p("Owners and admins send invites.")));
    const roles = await write("Roles", "Admins manage boards.");
    await write("Exports", "Download a CSV.");

    const results = await search(query);
    expect(results).toEqual([
      { slug: inviting, title: "Inviting your team", snippet: "Owners and admins send invites.", url: expect.stringMatching(/\/docs\/inviting-your-team$/) },
      { slug: roles, title: "Roles", snippet: "Admins manage boards.", url: expect.stringMatching(/\/docs\/roles$/) },
    ]);
    expect((await call(searchArticles, as(visitor), { q: query, limit: 1 })).results.map((r) => r.slug)).toEqual([inviting]);
  });

  test("drafts and other projects' articles never come back, even with chunks left over", async () => {
    near("Inviting your team", "", "Owners send invites.", 0.9);
    const slug = await write("Inviting your team", "Owners send invites.");
    const other = await createProject(owner);
    await write("Inviting your team", "Owners send invites.", { projectId: other.id });
    expect((await search(query)).map((r) => r.slug)).toEqual([slug]);

    // Unpublished behind search's back: its chunks are still there.
    await prisma.article.updateMany({ where: { projectId: project.id, slug }, data: { publishedAt: null } });
    expect(await chunks(slug)).toHaveLength(1);
    expect(await search(query)).toEqual([]);
    expect(await search("invites")).toEqual([]);
  });

  test("a deleted article never comes back, by meaning or by words, even with chunks left over", async () => {
    near("Inviting your team", "", "Owners send invites.", 0.9);
    const slug = await write("Inviting your team", "Owners send invites.");
    expect((await search(query)).map((r) => r.slug)).toEqual([slug]);

    await call(deleteArticle, as(owner), { slug });
    expect(await search(query)).toEqual([]);
    expect(await search("invites")).toEqual([]);

    // Deleted behind search's back (a deleted article can't stay published): its chunks are still there.
    const other = await write("Inviting your team", "Owners send invites.");
    await prisma.article.updateMany({ where: { projectId: project.id, slug: other }, data: { deletedAt: new Date(), publishedAt: null } });
    expect(await chunks(other)).toHaveLength(1);
    expect(await search(query)).toEqual([]);
    expect(await search("invites")).toEqual([]);
  });

  test("articles that only share words come after the ones that mean the same", async () => {
    near("Inviting your team", "", "Owners send invites.", 0.9);
    const meaning = await write("Inviting your team", "Owners send invites.");
    const words = await write("Colleagues", "Add each colleague from Settings.");
    expect((await search(query)).map((r) => r.slug)).toEqual([meaning, words]);
  });

  test("when OpenAI is down, search still matches words", async () => {
    const slug = await write("Inviting your team", "Owners send invites.");
    openai.failNext();
    expect((await search("invites")).map((r) => r.slug)).toEqual([slug]);
  });

  test("when OpenAI is slow, search stops waiting for it and matches words", async () => {
    const slug = await write("Inviting your team", "Owners send invites.");
    const release = openai.holdNext();
    try {
      const started = Date.now();
      expect((await searchDocs(project.id, "invites", 10, SIGNED_OUT, 100)).map((r) => r.slug)).toEqual([slug]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      release();
    }
  });
});

describe("search without an OpenAI key", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""));

  test("matches the words of titles and text in any form, title matches first, with the passage around them", async () => {
    const billing = await write("Billing", `${"Plans are billed monthly. ".repeat(20)}Each team member you invite adds a seat.`);
    const inviting = await write("Inviting your team", "Owners send invitations from the Team page.");
    expect(openai.inputs).toEqual([]);
    expect(await prisma.articleChunk.count({ where: { projectId: project.id } })).toBe(0);

    const results = await search("invite team");
    expect(results.map((r) => r.slug)).toEqual([inviting, billing]);
    expect(results[0]!.snippet).toBe("Owners send invitations from the Team page.");
    // Cut from a longer text: "…" where it was cut, not at its end.
    expect(results[1]!.snippet).toMatch(/^….*Plans are billed monthly\. Each team member you invite adds a seat\.$/);
    expect(results[1]!.snippet.length).toBeLessThan(250);

    expect(await search("refunds")).toEqual([]);
  });

  test("drafts and other projects' articles never come back", async () => {
    await write("Inviting your team", "Owners send invites.", { draft: true });
    const other = await createProject(owner);
    await write("Inviting your team", "Owners send invites.", { projectId: other.id });
    expect(await search("invites")).toEqual([]);
  });
});
