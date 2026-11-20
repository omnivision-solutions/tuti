import { prisma } from "@tuti/db";
import { backfillEmbeddings, grantCredits } from "@tuti/jobs";
import { DUPLICATE_CANDIDATE_MIN_SIMILARITY, DUPLICATE_MIN_SIMILARITY, DEFAULT_DUPLICATES_MODEL, TYPING_SUGGESTION_MIN_SIMILARITY } from "@tuti/shared";
import { configFile, FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { mergePost } from "./manage-posts";
import { createPost } from "./posts";
import { findSimilarPosts } from "./similar-posts";

/**
 * Duplicate detection end to end: creating a post runs the post-created job
 * inline, which embeds it (through the OpenAI fake) and suggests older posts.
 */

let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  openai = await startOpenAIFake();
});
afterAll(() => openai.close());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  owner = await signUp();
  project = await createProject(owner);
  actAs(owner);
});

/** A unit vector with exactly `similarity` to `along(1)` (cosine). */
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

async function post(title: string, inProject = project) {
  const form = new FormData();
  form.set("projectSlug", inProject.slug);
  form.set("boardSlug", "feature-requests");
  form.set("title", title);
  expect(await createPost({}, form)).toEqual({});
  return prisma.post.findFirstOrThrow({ where: { projectId: inProject.id, title }, select: { id: true } });
}

const suggestions = () =>
  prisma.duplicateSuggestion.findMany({
    where: { projectId: project.id },
    select: { postId: true, originalId: true, similarity: true, status: true },
  });

describe("after a post is created", () => {
  test("older posts above the threshold are suggested as its original", async () => {
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(DUPLICATE_MIN_SIMILARITY + 0.01));
    const original = await post("Dark mode");
    const duplicate = await post("Night theme please");

    const [suggestion, ...others] = await suggestions();
    expect(others).toEqual([]);
    expect(suggestion).toMatchObject({ postId: duplicate.id, originalId: original.id, status: "PENDING" });
    expect(suggestion!.similarity).toBeCloseTo(DUPLICATE_MIN_SIMILARITY + 0.01, 5);
  });

  test("posts just below the threshold aren't", async () => {
    openai.setVector("Dark mode", along(1));
    openai.setVector("Darker colours", along(DUPLICATE_MIN_SIMILARITY - 0.01));
    await post("Dark mode");
    await post("Darker colours");
    expect(await suggestions()).toEqual([]);
  });

  test("merged posts and other projects' posts are never suggested", async () => {
    openai.setVector("Dark mode", along(1));
    openai.setVector("Dark theme", along(1));
    openai.setVector("Dark UI", along(1));
    const otherOwner = await signUp();
    const other = await createProject(otherOwner);
    actAs(otherOwner);
    await post("Dark mode", other);

    actAs(owner);
    const merged = await post("Dark theme");
    const original = await post("Dark UI");
    await mergePost(project.slug, merged.id, original.id);
    const newest = await post("Dark mode");

    expect(await suggestions()).toEqual([
      expect.objectContaining({ postId: newest.id, originalId: original.id }),
    ]);
  });

  test("posting still works when OpenAI fails, with no suggestions", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openai.setVector("Dark mode", along(1));
    openai.setVector("Dark theme", along(1));
    await post("Dark mode");
    openai.failNext(500);
    await post("Dark theme");
    expect(await suggestions()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "Enqueueing the post-created job failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  test("without an OpenAI key nothing is embedded or sent", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const sent = openai.inputs.length;
    const created = await post("Dark mode");
    expect(openai.inputs.length).toBe(sent);
    expect(await prisma.postEmbedding.count({ where: { postId: created.id } })).toBe(0);
  });
});

describe("suggestions while typing a title", () => {
  test("title matches work without OpenAI", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await post("Dark mode for the dashboard");
    await post("Export to CSV");
    const found = await findSimilarPosts(project.slug, "dark mode");
    expect(found.map((p) => p.title)).toEqual(["Dark mode for the dashboard"]);
  });

  test("with OpenAI, posts with the same meaning come first, then title matches", async () => {
    openai.setVector("Dark mode please", along(1));
    openai.setVector("Night theme", along(TYPING_SUGGESTION_MIN_SIMILARITY + 0.05));
    openai.setVector("Dark mode for the dashboard", [0, 0, 1]); // unrelated in meaning
    await post("Night theme");
    await post("Dark mode for the dashboard");

    const found = await findSimilarPosts(project.slug, "Dark mode please");
    expect(found.map((p) => p.title)).toEqual(["Night theme", "Dark mode for the dashboard"]);
  });

  test("falls back to title matches when OpenAI fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openai.setVector("Night theme", along(1));
    openai.setVector("Dark mode please", along(1));
    await post("Night theme");
    await post("Dark mode for the dashboard");

    openai.failNext(500);
    const found = await findSimilarPosts(project.slug, "Dark mode please");
    expect(found.map((p) => p.title)).toEqual(["Dark mode for the dashboard"]);
  });

  test("short queries don't call OpenAI, and merged posts aren't shown", async () => {
    const merged = await post("Dark mode now");
    const original = await post("Dark mode soon");
    await mergePost(project.slug, merged.id, original.id);
    const sent = openai.inputs.length;

    const found = await findSimilarPosts(project.slug, "dark mode");
    expect(openai.inputs.length).toBe(sent);
    expect(found.map((p) => p.title)).toEqual(["Dark mode soon"]);
  });
});

describe("with a decision model (OpenRouter)", () => {
  let model: ModelFake;
  beforeAll(async () => {
    model = await startModelFake({ embeddings: openai });
  });
  afterAll(() => model.close());
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", model.env.OPENAI_API_KEY!);
    vi.stubEnv("OPENAI_BASE_URL", model.env.OPENAI_BASE_URL!);
  });
  beforeEach(() => model.decisions.splice(0));
  afterEach(() => model.done());

  const DUPLICATE = { duplicate: 0.9, related: 0.08, different: 0.02 };
  const RELATED = { duplicate: 0.2, related: 0.7, different: 0.1 };
  const DIFFERENT = { duplicate: 0.01, related: 0.2, different: 0.79 };

  test("after posting, only the candidates it calls duplicates are suggested, from a wider net than similarity alone", async () => {
    // Most similar to "Articles in other languages": Inbox (0.536), then Translations (0.37: under DUPLICATE_MIN_SIMILARITY).
    openai.setVector("Translations for articles", [1, 0, 0, 0]);
    openai.setVector("Live translations for Inbox", [0.8, 0.6, 0, 0]);
    openai.setVector("Articles in other languages", [0.37, 0.4, Math.sqrt(1 - 0.37 ** 2 - 0.4 ** 2), 0]);
    openai.setVector("Auto translation of articles", [DUPLICATE_CANDIDATE_MIN_SIMILARITY - 0.01, 0, 0, Math.sqrt(1 - (DUPLICATE_CANDIDATE_MIN_SIMILARITY - 0.01) ** 2)]);
    model.decide({ duplicate_0: RELATED }, "Live translations for Inbox");
    model.decide({ duplicate_0: DIFFERENT, duplicate_1: DUPLICATE }, "Articles in other languages");
    const original = await post("Translations for articles");
    await post("Live translations for Inbox");
    const languages = await post("Articles in other languages");
    // Its candidates are all under the cut-off, so it isn't asked about.
    await post("Auto translation of articles");

    expect(model.decisions).toHaveLength(2);
    expect(model.decisions[1]).toMatchObject({
      model: DEFAULT_DUPLICATES_MODEL,
      state: { new: "Articles in other languages", existing_0: "Live translations for Inbox", existing_1: "Translations for articles" },
    });
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: languages.id, originalId: original.id, status: "PENDING" })]);
  });

  test("when it fails, posts are suggested by similarity alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(DUPLICATE_MIN_SIMILARITY + 0.01));
    const original = await post("Dark mode");
    const duplicate = await post("Night theme please");
    expect(model.decisions).toHaveLength(1);
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: duplicate.id, originalId: original.id })]);
    // Nothing was scripted, so the fake turned it down.
    expect(() => model.done()).toThrow("no answers scripted");
  });

  test("duplicates.posted.model off asks nothing and uses similarity alone", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
    openai.setVector("Dark mode", [1, 0, 0]);
    openai.setVector("Night theme please", along(DUPLICATE_MIN_SIMILARITY + 0.01));
    openai.setVector("Darker colours", [DUPLICATE_MIN_SIMILARITY - 0.01, 0, Math.sqrt(1 - (DUPLICATE_MIN_SIMILARITY - 0.01) ** 2)]);
    await post("Dark mode");
    const night = await post("Night theme please");
    await post("Darker colours");
    expect(model.decisions).toHaveLength(0);
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: night.id })]);
  });

  test("while typing, it keeps the duplicates, likeliest first, with duplicates.typing.model", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" }, typing: { model: "acme/judge" } } }));
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Translations for articles", along(0.9));
    openai.setVector("Article translation", along(0.8));
    openai.setVector("Live translations for Inbox", along(0.7));
    await post("Translations for articles");
    await post("Article translation");
    await post("Live translations for Inbox");
    model.decide({ duplicate_0: { duplicate: 0.6, related: 0.3, different: 0.1 }, duplicate_1: DUPLICATE, duplicate_2: DIFFERENT });

    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Article translation", "Translations for articles"]);
    expect(model.decisions.at(-1)).toMatchObject({ model: "acme/judge", state: { new: "Translate articles please" } });
  });

  test("while typing, every candidate is judged before the 5 shown are picked: a duplicate found only by its words isn't cut", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
    openai.setVector("Dark mode please", along(1));
    for (const k of [1, 2, 3, 4, 5]) {
      openai.setVector(`Night theme ${k}`, along(0.95 - k / 100));
      await post(`Night theme ${k}`);
    }
    openai.setVector("Dark mode for the dashboard", [0, 0, 1]); // unrelated in meaning: found by its words only
    await post("Dark mode for the dashboard");
    model.decide({ "*": DIFFERENT, duplicate_5: DUPLICATE });

    const found = await findSimilarPosts(project.slug, "Dark mode please");
    expect(found.map((p) => p.title)).toEqual(["Dark mode for the dashboard"]);
    expect(Object.keys(model.decisions.at(-1)!.questions)).toHaveLength(6);
  });

  test("with AI credits on, a check is recorded and charged as duplicate detection; out of credits, nothing is asked", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true }, duplicates: { posted: { model: "off" } } }));
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Translations for articles", along(0.9));
    await post("Translations for articles");
    model.decide({ duplicate_0: DIFFERENT });

    expect(await findSimilarPosts(project.slug, "Translate articles please")).toEqual([]);
    const [usage, ...more] = await prisma.aiUsage.findMany({ where: { projectId: project.id } });
    expect(more).toEqual([]);
    expect(usage).toMatchObject({ feature: "duplicates", kind: "decision" });
    expect(Number(usage!.credits)).toBeGreaterThan(0);

    await prisma.creditGrant.updateMany({ where: { projectId: project.id }, data: { remaining: 0 } });
    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Translations for articles"]);
    expect(model.decisions).toHaveLength(1);
  });

  test("after posting, with AI credits on, the check is recorded and charged as duplicate detection", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true } }));
    await grantCredits(project.id, "TOPUP", 10, { days: 365 });
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(0.8));
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    await post("Dark mode");
    await post("Night theme please");
    const [usage, ...more] = await prisma.aiUsage.findMany({ where: { projectId: project.id } });
    expect(more).toEqual([]);
    expect(usage).toMatchObject({ feature: "duplicates", kind: "decision" });
    expect(Number(usage!.credits)).toBeGreaterThan(0);
  });

  test("after posting, out of AI credits, posts are suggested by similarity alone, without asking", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true } }));
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(DUPLICATE_MIN_SIMILARITY + 0.01));
    const original = await post("Dark mode");
    const duplicate = await post("Night theme please");
    expect(model.decisions).toHaveLength(0);
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: duplicate.id, originalId: original.id })]);
  });

  test("the embeddings backfill checks only posts it embeds for the first time: a rerun asks (and charges) nothing again", async () => {
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(0.8));
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    await post("Dark mode");
    const night = await post("Night theme please");
    expect(model.decisions).toHaveLength(1);
    // A post from before embeddings were set up: never embedded, never checked.
    await prisma.postEmbedding.delete({ where: { postId: night.id } });
    await prisma.duplicateSuggestion.deleteMany({ where: { projectId: project.id } });
    const log = { info: () => {}, warn: () => {} };

    // The backfill covers every project: other tests' posts never embedded are checked too (and told they're different).
    model.otherwiseDecide({ "*": DIFFERENT }, '"existing_0"');
    const nightAsked = () => model.decisions.filter((d) => JSON.stringify(d.state).includes("Night theme please")).length;
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    await backfillEmbeddings(log);
    expect(nightAsked()).toBe(2);
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: night.id })]);

    const asked = model.decisions.length;
    await backfillEmbeddings(log);
    expect(model.decisions).toHaveLength(asked);
  });

  test("while typing signed out, nothing is asked (it'd be charged to the project): the posts are shown as found", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Live translations for Inbox", along(0.9));
    await post("Live translations for Inbox");
    actAs(null);

    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Live translations for Inbox"]);
    expect(model.decisions).toHaveLength(0);
  });

  test("the backfill also checks newer posts against an older one it embeds for the first time", async () => {
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(0.8));
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    const dark = await post("Dark mode");
    const night = await post("Night theme please");
    // The older post was never embedded, so the newer one was never compared with it.
    await prisma.postEmbedding.delete({ where: { postId: dark.id } });
    await prisma.duplicateSuggestion.deleteMany({ where: { projectId: project.id } });

    model.otherwiseDecide({ "*": DIFFERENT }, '"existing_0"');
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    await backfillEmbeddings({ info: () => {}, warn: () => {} });
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: night.id, originalId: dark.id })]);
  });

  test("a post checked before is checked again only against the older posts the backfill has just embedded", async () => {
    openai.setVector("Dark mode", along(1));
    openai.setVector("Darker colours", along(0.9));
    openai.setVector("Night theme please", along(0.8));
    model.decide({ duplicate_0: DIFFERENT }, "Darker colours");
    const dark = await post("Dark mode");
    await post("Darker colours");
    model.decide({ duplicate_0: DIFFERENT, duplicate_1: DIFFERENT }, "Night theme please");
    const night = await post("Night theme please");
    // "Dark mode" was never embedded: neither newer post was compared with it.
    await prisma.postEmbedding.delete({ where: { postId: dark.id } });
    const asked = model.decisions.length;

    model.otherwiseDecide({ "*": DIFFERENT }, '"existing_0"');
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    await backfillEmbeddings({ info: () => {}, warn: () => {} });
    const night2 = model.decisions.slice(asked).find((d) => (d.state as { new: string }).new === "Night theme please");
    // Against "Dark mode" alone: "Darker colours" was judged already.
    expect(night2?.state).toEqual({ new: "Night theme please", existing_0: "Dark mode" });
    expect(await suggestions()).toContainEqual(expect.objectContaining({ postId: night.id, originalId: dark.id }));
  });

  test("a backfill batch whose check fails is unembedded again, so the next run checks it", async () => {
    model.otherwiseDecide({ "*": DIFFERENT }, '"existing_0"');
    openai.setVector("Dark mode", along(1));
    openai.setVector("Night theme please", along(0.8));
    const dark = await post("Dark mode");
    const night = await post("Night theme please");
    // Neither was ever embedded.
    await prisma.postEmbedding.deleteMany({ where: { postId: { in: [dark.id, night.id] } } });
    await prisma.duplicateSuggestion.deleteMany({ where: { projectId: project.id } });
    const log = { info: () => {}, warn: () => {} };

    vi.spyOn(prisma.duplicateSuggestion, "createMany").mockRejectedValueOnce(new Error("database blip"));
    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    const failed = await backfillEmbeddings(log);
    expect(failed.errors).toContainEqual({ phase: "posts", message: "database blip" });
    expect(await prisma.postEmbedding.count({ where: { postId: { in: [dark.id, night.id] } } })).toBe(0);

    model.decide({ duplicate_0: DUPLICATE }, "Night theme please");
    expect((await backfillEmbeddings(log)).errors).toEqual([]);
    expect(await suggestions()).toEqual([expect.objectContaining({ postId: night.id, originalId: dark.id })]);
  });

  test("while typing, a balance that can't be read shows the posts as found", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true }, duplicates: { posted: { model: "off" } } }));
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Live translations for Inbox", along(0.9));
    await post("Live translations for Inbox");
    vi.spyOn(prisma.creditGrant, "findMany").mockRejectedValueOnce(new Error("database blip"));

    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Live translations for Inbox"]);
    expect(model.decisions).toHaveLength(0);
  });

  test("while typing, a failure shows the posts as found", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Translations for articles", along(0.9));
    await post("Translations for articles");

    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Translations for articles"]);
    expect(() => model.done()).toThrow("no answers scripted");
  });

  test("while typing, a project's checks stop at 300 an hour: the rest show the posts as found, till the next hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T10:10:00Z") });
    // With credits on, each check reads the balance first: the wait searches at once could slip past the count in.
    vi.stubEnv("TUTI_CONFIG", configFile({ credits: { enabled: true }, duplicates: { posted: { model: "off" } } }));
    await grantCredits(project.id, "TOPUP", 1000, { days: 365 });
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Live translations for Inbox", along(0.9));
    await post("Live translations for Inbox");
    model.otherwiseDecide({ "*": DIFFERENT }, "Translate articles please");

    // All at once: none may read a count another hasn't saved yet.
    const answered = await Promise.all(Array.from({ length: 300 }, () => findSimilarPosts(project.slug, "Translate articles please")));
    expect(answered.every((posts) => posts.length === 0)).toBe(true);
    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Live translations for Inbox"]);
    expect(model.decisions).toHaveLength(300);

    vi.setSystemTime(new Date("2026-11-20T11:00:00Z"));
    expect(await findSimilarPosts(project.slug, "Translate articles please")).toEqual([]);
    expect(model.decisions).toHaveLength(301);
    // 301 searches, each a few database queries and requests to the fakes.
  }, 60_000);

  test("while typing, an answer that takes over a second shows the posts as found", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
    openai.setVector("Translate articles please", along(1));
    openai.setVector("Live translations for Inbox", along(0.9));
    await post("Live translations for Inbox");
    // Had it answered in time, it would have hidden the post.
    model.decide({ "*": DIFFERENT }, undefined, () => new Promise((resolve) => setTimeout(resolve, 1_500)));

    const found = await findSimilarPosts(project.slug, "Translate articles please");
    expect(found.map((p) => p.title)).toEqual(["Live translations for Inbox"]);
  });

  /** Older posts with these similarities to [1, 0, …] and to nothing else of each other's but through it. */
  const olderPosts = async (similarities: number[]) => {
    for (const [k, s] of similarities.entries()) {
      const vector = Array.from({ length: similarities.length + 1 }, (_, d) => (d === 0 ? s : d === k + 1 ? Math.sqrt(1 - s ** 2) : 0));
      openai.setVector(`Older ${k}`, vector);
    }
    vi.stubEnv("TUTI_CONFIG", configFile({ duplicates: { posted: { model: "off" } } }));
    const posts = [];
    for (const k of similarities.keys()) {
      posts.push(await post(`Older ${k}`));
    }
    vi.unstubAllEnvs();
    vi.stubEnv("OPENAI_API_KEY", model.env.OPENAI_API_KEY!);
    vi.stubEnv("OPENAI_BASE_URL", model.env.OPENAI_BASE_URL!);
    openai.setVector("The new one", [1, ...similarities.map(() => 0)]);
    return posts;
  };

  test("after posting, the 8 most similar posts at 0.35 or above are asked about, in one request", async () => {
    await olderPosts([0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5]);
    model.decide({ "*": DIFFERENT }, "The new one");
    const created = await post("The new one");
    const asked = model.decisions.filter((d) => JSON.stringify(d.state).includes("The new one"));
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!.questions)).toHaveLength(8);
    expect(await suggestions()).not.toContainEqual(expect.objectContaining({ postId: created.id }));
  });

  test("after posting, a failed answer suggests the 3 most similar at 0.45 or above, as before", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [a, b, c] = await olderPosts([0.9, 0.8, 0.7, 0.6, 0.4]);
    const created = await post("The new one");
    const mine = (await suggestions()).filter((s) => s.postId === created.id).map((s) => s.originalId);
    expect(mine.sort()).toEqual([a!.id, b!.id, c!.id].sort());
    expect(() => model.done()).toThrow("no answers scripted");
  });

  test("after posting, a failed answer leaves out what's under 0.45, even among the 3 most similar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [a, b] = await olderPosts([0.9, 0.8, 0.4, 0.38]);
    const created = await post("The new one");
    const mine = (await suggestions()).filter((s) => s.postId === created.id).map((s) => s.originalId);
    expect(mine.sort()).toEqual([a!.id, b!.id].sort());
    expect(() => model.done()).toThrow("no answers scripted");
  });
});
