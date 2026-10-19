import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { hashApiKey } from "@/lib/api-keys";
import { createApiKey, revokeApiKey } from "@/server/api-keys";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { GET } from "./[...path]/route";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let key: string;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
  key = (await createApiKey(project.slug, "Tests", "READ")).key!;
});

/** Calls the API like a client would. */
async function api(path: string, apiKey: string | null = key) {
  const url = new URL(`http://tuti.localhost:3100/api/v1${path}`);
  const response = await GET(
    new Request(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }),
    { params: Promise.resolve({ path: url.pathname.split("/").slice(3) }) },
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function post(title: string, fields: { votes?: number; status?: "PLANNED"; createdAt?: Date; board?: string } = {}) {
  const board = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: fields.board ?? "feature-requests" } });
  const { postCount: number } = await prisma.project.update({
    where: { id: project.id },
    data: { postCount: { increment: 1 } },
    select: { postCount: true },
  });
  return prisma.post.create({
    data: {
      projectId: project.id,
      boardId: board.id,
      authorId: owner.id,
      number,
      title,
      body: `About ${title}`,
      voteCount: fields.votes ?? 0,
      status: fields.status ?? "OPEN",
      createdAt: fields.createdAt,
    },
  });
}

describe("keys", () => {
  test("requests need a valid, unrevoked key; keys are stored hashed and record their use", async () => {
    expect(await api("/posts", null)).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
    expect(await api("/posts", `tuti_${"x".repeat(43)}`)).toMatchObject({ status: 401 });
    expect(await api("/posts", "Basic abc")).toMatchObject({ status: 401 });

    const stored = await prisma.apiKey.findFirstOrThrow({ where: { projectId: project.id } });
    expect(stored.keyHash).toBe(hashApiKey(key));
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(stored.lastUsedAt).toBeNull();

    expect((await api("/posts")).status).toBe(200);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: stored.id } })).lastUsedAt).not.toBeNull();

    expect(await revokeApiKey(project.slug, stored.id)).toEqual({});
    expect(await api("/posts")).toMatchObject({
      status: 401,
      body: { error: { message: "This API key isn't valid or was revoked" } },
    });
  });

  test("a key only sees its own project", async () => {
    const other = await createProject(owner);
    const otherKey = (await createApiKey(other.slug, "Other", "READ")).key!;
    await post("Dark mode");
    expect((await api("/posts")).body.posts).toHaveLength(1);
    expect((await api("/posts", otherKey)).body.posts).toEqual([]);
    expect(await api("/posts/1", otherKey)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  test("600 requests a minute per key, then 429 with Retry-After", async () => {
    await prisma.apiKey.updateMany({
      where: { projectId: project.id },
      data: { rateWindowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000), rateCount: 600 },
    });
    const limited = await api("/boards");
    expect(limited).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("only owners and admins create keys; names are required; keys are shown once", async () => {
    expect(await createApiKey(project.slug, "  ", "READ")).toEqual({ error: "Give the key a name" });
    expect(await createApiKey(project.slug, "x", "ADMIN")).toMatchObject({ error: expect.any(String) });
    const member = await addMember(project.id, "MEMBER");
    actAs(member);
    expect(await createApiKey(project.slug, "Mine", "READ")).toEqual({
      error: "Only project owners and admins can manage API keys",
    });
  });
});

describe("reading", () => {
  test("boards, with how many posts each has (merged duplicates left out)", async () => {
    const dark = await post("Dark mode");
    const night = await post("Night theme");
    await prisma.post.update({ where: { id: night.id }, data: { duplicateOfId: dark.id } });
    expect(await api("/boards")).toEqual({
      status: 200,
      body: { boards: [{ slug: "feature-requests", name: "Feature requests", posts: 1 }] },
      headers: expect.anything(),
    });
  });

  test("posts: most voted or newest first, filtered, a page at a time", async () => {
    await post("Old and popular", { votes: 10, createdAt: new Date("2026-01-01") });
    await post("New", { votes: 1, createdAt: new Date("2026-06-01"), status: "PLANNED" });
    await post("Middle", { votes: 5, createdAt: new Date("2026-03-01") });

    const top = await api("/posts?limit=2");
    expect(top.body.posts.map((p: { title: string }) => p.title)).toEqual(["Old and popular", "Middle"]);
    expect(top.body.nextCursor).toBe("2");
    expect((await api("/posts?limit=2&cursor=2")).body).toMatchObject({ posts: [{ title: "New" }], nextCursor: null });

    expect((await api("/posts?sort=new")).body.posts.map((p: { title: string }) => p.title)).toEqual([
      "New",
      "Middle",
      "Old and popular",
    ]);
    expect((await api("/posts?status=planned")).body.posts).toEqual([
      {
        number: 2,
        title: "New",
        status: "planned",
        board: "feature-requests",
        votes: 1,
        comments: 0,
        author: { name: "Olive Owner" },
        createdAt: "2026-06-01T00:00:00.000Z",
        url: `http://${project.slug}.localhost:3100/p/new-2`,
      },
    ]);
    expect((await api("/posts?board=nope")).body.posts).toEqual([]);
  });

  test("bad input and unknown endpoints get clear errors", async () => {
    expect(await api("/posts?limit=1000")).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_input", message: expect.stringContaining("limit") } },
    });
    expect(await api("/posts?status=done")).toMatchObject({ status: 400 });
    expect(await api("/posts/abc")).toMatchObject({ status: 400 });
    expect(await api("/nothing")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  test("a post, with its text and document, and its comments (team comments marked)", async () => {
    const dark = await post("Dark mode");
    const ada = await signUp("Ada");
    await prisma.comment.createMany({
      data: [
        { projectId: project.id, postId: dark.id, authorId: ada.id, body: "Please!" },
        { projectId: project.id, postId: dark.id, authorId: owner.id, body: "On it" },
      ],
    });
    expect((await api("/posts/1")).body).toMatchObject({
      number: 1,
      title: "Dark mode",
      body: "About Dark mode",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "About Dark mode" }] }] },
      mergedInto: null,
    });
    expect((await api("/posts/1/comments")).body.comments).toEqual([
      expect.objectContaining({ author: { name: "Ada", team: false }, body: "Please!" }),
      expect.objectContaining({ author: { name: "Olive Owner", team: true }, body: "On it" }),
    ]);
    expect((await api("/posts/2")).status).toBe(404);
  });
});
