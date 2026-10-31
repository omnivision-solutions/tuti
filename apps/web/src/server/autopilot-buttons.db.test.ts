import { prisma } from "@tuti/db";
import { readAutopilotButton, signAutopilotButton } from "@tuti/jobs";
import { beforeEach, expect, test } from "vitest";

import { GET as act } from "@/app/app/[project]/autopilot/[id]/act/route";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let number = 0;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** A ready change: a request it closes (waiting) and a progress update going out by itself tomorrow. */
async function change() {
  number++;
  const post = await call(createPost, team(), { board: "feature-requests", title: `Dark mode ${number}` });
  const postId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } })).id;
  return prisma.codeChange.create({
    data: {
      projectId: project.id,
      repoId: 1,
      repo: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      title: "Add a dark theme",
      author: "octo",
      mergedAt: new Date(),
      state: "READY",
      actions: {
        create: [
          { kind: "LINKS", postId, probability: 0.9 },
          { kind: "MOVES_FORWARD", postId, probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 86_400_000), payload: { comment: "Out soon" } },
        ],
      },
    },
    include: { actions: true },
  });
}

/** Opens a button's link as the browser would: where it lands. */
async function click(codeChangeId: string, token: string): Promise<string> {
  return act(new Request(`http://tuti.localhost/app/${project.slug}/autopilot/${codeChangeId}/act?token=${token}`), {
    params: Promise.resolve({ project: project.slug, id: codeChangeId }),
  }).then(
    () => "no redirect",
    (error: { digest?: string }) => error.digest?.match(/^NEXT_REDIRECT;\w+;([^;]+);/)?.[1] ?? Promise.reject(error),
  );
}

const statusOf = async (id: string) => (await prisma.codeChangeAction.findUniqueOrThrow({ where: { id } })).status;

test("a button's token is for its recipient, its change and itself, for a week; anything else isn't one", () => {
  const token = signAutopilotButton("user-1", "change-1", "publish")!;
  expect(readAutopilotButton(token)).toEqual({ userId: "user-1", codeChangeId: "change-1", button: "publish", expired: false });
  expect(readAutopilotButton(token, new Date(Date.now() + 8 * 86_400_000))?.expired).toBe(true);
  // Changed, it isn't one of ours.
  const [payload, signature] = token.split(".");
  const other = Buffer.from(JSON.stringify({ u: "user-2", c: "change-1", b: "publish", e: Date.now() + 1e9 })).toString("base64url");
  expect(readAutopilotButton(`${other}.${signature}`)).toBeNull();
  expect(readAutopilotButton(`${payload}.nope`)).toBeNull();
});

test("Approve: one click for its recipient, signed in, then the page says it's done; a second click does nothing again", async () => {
  const { id, actions } = await change();
  const link = actions.find((action) => action.kind === "LINKS")!;
  const token = signAutopilotButton(owner.id, id, `approve:${link.id}`)!;
  expect(await click(id, token)).toBe(`/app/${project.slug}/autopilot/${id}?done=approved&update=${link.id}`);
  expect(await statusOf(link.id)).toBe("APPLIED");
  expect(await click(id, token)).toBe(`/app/${project.slug}/autopilot/${id}?done=already&update=${link.id}`);
});

test("signed out (a mail scanner, or the recipient on another device): sign in first, nothing done until then", async () => {
  const { id, actions } = await change();
  const link = actions.find((action) => action.kind === "LINKS")!;
  const token = signAutopilotButton(owner.id, id, `approve:${link.id}`)!;
  actAs(null);
  const landing = await click(id, token);
  expect(landing).toBe(`/sign-in?next=${encodeURIComponent(`/app/${project.slug}/autopilot/${id}/act?token=${token}`)}`);
  expect(await statusOf(link.id)).toBe("PENDING");
});

test("someone else's button, or an old one, only opens the page with those updates ticked", async () => {
  const { id, actions } = await change();
  const link = actions.find((action) => action.kind === "LINKS")!;
  const teammate = await signUp("Tess Team");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "ADMIN" } });
  actAs(teammate);
  expect(await click(id, signAutopilotButton(owner.id, id, `approve:${link.id}`)!)).toBe(`/app/${project.slug}/autopilot/${id}?select=${link.id}`);
  actAs(owner);
  const old = signAutopilotButton(owner.id, id, `approve:${link.id}`, new Date(Date.now() - 8 * 86_400_000))!;
  expect(await click(id, old)).toBe(`/app/${project.slug}/autopilot/${id}?select=${link.id}`);
  expect(await click(id, "not-a-token")).toBe(`/app/${project.slug}/autopilot/${id}?select=likely`);
  expect(await statusOf(link.id)).toBe("PENDING");
});

test("Stop and Publish now act on what's going out by itself; once it's gone, a click says so and does nothing", async () => {
  const stopped = await change();
  expect(await click(stopped.id, signAutopilotButton(owner.id, stopped.id, "stop")!)).toBe(`/app/${project.slug}/autopilot/${stopped.id}?done=stopped`);
  expect(await statusOf(stopped.actions.find((a) => a.kind === "MOVES_FORWARD")!.id)).toBe("PENDING");
  const published = await change();
  const publish = signAutopilotButton(owner.id, published.id, "publish")!;
  expect(await click(published.id, publish)).toBe(`/app/${project.slug}/autopilot/${published.id}?done=published`);
  expect(await statusOf(published.actions.find((a) => a.kind === "MOVES_FORWARD")!.id)).toBe("APPLIED");
  expect(await click(published.id, publish)).toBe(`/app/${project.slug}/autopilot/${published.id}?done=already`);
});
