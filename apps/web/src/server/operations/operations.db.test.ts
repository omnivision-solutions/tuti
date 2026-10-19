import { prisma } from "@tuti/db";
import { beforeAll, expect, test } from "vitest";

import { DELETE, GET, PATCH, POST } from "@/app/api/v1/[...path]/route";
import { createApiKey } from "@/server/api-keys";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { type Operation, type OperationName, operations } from "./index";

/**
 * Every operation on the API surface (REST; MCP serves the same operations with
 * the same key check, see app/mcp/mcp.db.test.ts): a read-only key may run reads
 * and is refused writes without changing anything; a read and write key may run
 * everything; another project's key never reaches this project's data. In the
 * app, operations run through server actions, which the authorization matrix
 * (server/authorization.db.test.ts) covers. The type lists every operation, so a
 * new one doesn't compile until it's added here.
 */

type Fixture = Awaited<ReturnType<typeof createFixture>>;
/** A valid call: path values and the rest of the input. */
const cases: Record<OperationName, (f: Fixture) => Record<string, unknown>> = {
  "project.get": () => ({}),
  "team.list": () => ({}),
  "votes.set": () => ({ number: 1, voted: true }),
  "duplicates.list": () => ({}),
  "duplicates.dismiss": (f) => ({ id: f.suggestionId }),
  "boards.list": () => ({}),
  "posts.list": () => ({}),
  "posts.get": () => ({ number: 1 }),
  "comments.list": () => ({ number: 1 }),
  "posts.create": () => ({ board: "feature-requests", title: "From the matrix" }),
  "comments.create": () => ({ number: 1, body: "From the matrix" }),
  "posts.update": () => ({ number: 1, status: "planned" }),
  "posts.merge": () => ({ number: 2, into: 1 }),
  "links.add": () => ({ number: 1, url: "https://github.com/acme/app/pull/7" }),
  "links.remove": (f) => ({ number: 1, id: f.linkId }),
  "linkSuggestions.list": () => ({}),
  "linkSuggestions.accept": (f) => ({ id: f.linkSuggestionId }),
  "linkSuggestions.dismiss": (f) => ({ id: f.linkSuggestionId }),
};

let owner: TestUser;
let keys: { read: string; write: string; otherWrite: string };
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  owner = await signUp("Olive Owner");
  actAs(owner);
  project = await createProject(owner);
  const other = await createProject(owner);
  keys = {
    read: (await createApiKey(project.slug, "Read", "READ")).key!,
    write: (await createApiKey(project.slug, "Write", "WRITE")).key!,
    otherWrite: (await createApiKey(other.slug, "Other", "WRITE")).key!,
  };
});

/** Fresh posts #1 and #2 (with a link on #1) for each case; numbers restart per fixture. */
async function createFixture() {
  await prisma.post.deleteMany({ where: { projectId: project.id } });
  await prisma.project.update({ where: { id: project.id }, data: { postCount: 2 } });
  const board = project.boards[0]!;
  const marker = `matrix-${crypto.randomUUID()}`;
  const [first, second] = await Promise.all(
    [1, 2].map((number) =>
      prisma.post.create({
        data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title: `${marker} ${number}`, body: "" },
      }),
    ),
  );
  const link = await prisma.postLink.create({
    data: {
      projectId: project.id,
      postId: first!.id,
      kind: "ISSUE",
      repo: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/issues/9",
      source: "MANUAL",
    },
  });
  const suggestion = await prisma.duplicateSuggestion.create({
    data: { projectId: project.id, postId: second!.id, originalId: first!.id, similarity: 0.9 },
  });
  const linkSuggestion = await prisma.linkSuggestion.create({
    data: {
      projectId: project.id,
      postId: second!.id,
      repo: "acme/app",
      number: 11,
      url: "https://github.com/acme/app/pull/11",
      title: "Night mode",
      similarity: 0.6,
    },
  });
  return { marker, linkId: link.id, suggestionId: suggestion.id, linkSuggestionId: linkSuggestion.id };
}

/** Calls an operation over REST like a client would. */
async function call(operation: Operation, input: Record<string, unknown>, key: string) {
  const values = { ...input };
  const path = operation.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = String(values[name]);
    delete values[name];
    return encodeURIComponent(value);
  });
  const url = new URL(`http://tuti.localhost:3100/api/v1${path}`);
  if (operation.method === "GET") {
    for (const [name, value] of Object.entries(values)) {
      url.searchParams.set(name, String(value));
    }
  }
  const request = new Request(url, {
    method: operation.method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(operation.method !== "GET" && { body: JSON.stringify(values) }),
  });
  const handler = { GET, POST, PATCH, DELETE }[operation.method];
  const response = await handler(request, { params: Promise.resolve({ path: url.pathname.split("/").slice(3) }) });
  return { status: response.status, text: await response.text() };
}

/** This project's data, to show refused calls change nothing. */
const snapshot = () =>
  Promise.all([
    prisma.post.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } }),
    prisma.comment.findMany({ where: { projectId: project.id } }),
    prisma.postLink.findMany({ where: { projectId: project.id } }),
    prisma.vote.findMany({ where: { projectId: project.id } }),
    prisma.duplicateSuggestion.findMany({ where: { projectId: project.id } }),
  ]);

test("every operation is in this matrix", () => {
  expect(operations.map((o) => o.name).sort()).toEqual(Object.keys(cases).sort());
});

test.each(operations.map((operation) => ({ name: operation.name, operation })))("$name", async ({ operation }) => {
  const input = () => cases[operation.name as OperationName](fixture);
  let fixture = await createFixture();

  // Another project's key: nothing of this project comes back, and nothing changes.
  const before = await snapshot();
  const other = await call(operation, input(), keys.otherWrite);
  expect(other.text).not.toContain(fixture.marker);
  expect(other.text).not.toContain(project.slug);
  expect(await snapshot()).toEqual(before);

  // A read-only key: reads work, writes are refused without changing anything.
  const read = await call(operation, input(), keys.read);
  if (operation.scope === "read") {
    expect(read.status).toBe(200);
  } else {
    expect(read.status).toBe(403);
    expect(await snapshot()).toEqual(before);
  }

  // A read and write key can run it.
  fixture = await createFixture();
  expect(await call(operation, input(), keys.write)).toMatchObject({ status: 200 });
});
