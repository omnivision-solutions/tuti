import { prisma } from "@tuti/db";
import { DUPLICATE_MIN_SIMILARITY, TYPING_SUGGESTION_MIN_SIMILARITY } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
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
    expect(console.error).toHaveBeenCalledWith("Failed to enqueue post-created job", expect.any(Error));
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
