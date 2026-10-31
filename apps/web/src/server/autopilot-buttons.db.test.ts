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
  const token = signAutopilotButton("user-1", "change-1", "publish:a,b")!;
  expect(readAutopilotButton(token)).toEqual({ userId: "user-1", codeChangeId: "change-1", button: "publish:a,b", expired: false });
  expect(readAutopilotButton(token, new Date(Date.now() + 8 * 86_400_000))?.expired).toBe(true);
  // Changed, it isn't one of ours.
  const [payload, signature] = token.split(".");
  const other = Buffer.from(JSON.stringify({ u: "user-2", c: "change-1", b: "publish:a,b", e: Date.now() + 1e9 })).toString("base64url");
  expect(readAutopilotButton(`${other}.${signature}`)).toBeNull();
  expect(readAutopilotButton(`${payload}.nope`)).toBeNull();
  // As long in letters as a signature but not in bytes: not one either (and no error).
  expect(readAutopilotButton(`${payload}.${"a".repeat(signature!.length - 1)}é`)).toBeNull();
});

test("Approve: one click for its recipient, signed in, then the page says it's done; a second click does nothing again", async () => {
  const { id, actions } = await change();
  const link = actions.find((action) => action.kind === "LINKS")!;
  const token = signAutopilotButton(owner.id, id, `approve:${link.id}`)!;
  expect(await click(id, token)).toBe(`/app/${project.slug}/autopilot/${id}?done=approved&update=${link.id}`);
  expect(await statusOf(link.id)).toBe("APPLIED");
  expect(await click(id, token)).toBe(`/app/${project.slug}/autopilot/${id}?done=already&button=approve&update=${link.id}`);
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

const scheduledOf = (c: Awaited<ReturnType<typeof change>>) => c.actions.find((a) => a.kind === "MOVES_FORWARD")!.id;

test("Stop and Publish now act on what the email showed; once it's gone, a click says so (who, and when) and does nothing", async () => {
  const stopped = await change();
  const stop = signAutopilotButton(owner.id, stopped.id, `stop:${scheduledOf(stopped)}`)!;
  expect(await click(stopped.id, stop)).toBe(`/app/${project.slug}/autopilot/${stopped.id}?done=stopped&button=stop`);
  expect(await statusOf(scheduledOf(stopped))).toBe("PENDING");
  // Clicked again: done already, by whom (the page says "stopped by Olive Owner").
  expect(await click(stopped.id, stop)).toBe(`/app/${project.slug}/autopilot/${stopped.id}?done=already&button=stop&update=${scheduledOf(stopped)}`);
  expect(await prisma.codeChangeAction.findUniqueOrThrow({ where: { id: scheduledOf(stopped) } })).toMatchObject({ decidedById: owner.id, waitReason: "Stopped by Olive Owner" });

  const published = await change();
  const publish = signAutopilotButton(owner.id, published.id, `publish:${scheduledOf(published)}`)!;
  expect(await click(published.id, publish)).toBe(`/app/${project.slug}/autopilot/${published.id}?done=published&button=publish`);
  expect(await statusOf(scheduledOf(published))).toBe("APPLIED");
  expect(await click(published.id, publish)).toBe(`/app/${project.slug}/autopilot/${published.id}?done=already&button=publish&update=${scheduledOf(published)}`);
});

test("an email's buttons act only on what it showed: analysed again, a new scheduled update isn't published, and a replaced one's Approve says so", async () => {
  const c = await change();
  const publish = signAutopilotButton(owner.id, c.id, `publish:${scheduledOf(c)}`)!;
  const approve = signAutopilotButton(owner.id, c.id, `approve:${c.actions.find((a) => a.kind === "LINKS")!.id}`)!;
  // Analysed again: its updates replaced by new ones.
  await prisma.codeChangeAction.deleteMany({ where: { codeChangeId: c.id } });
  const fresh = await prisma.codeChangeAction.create({
    data: { codeChangeId: c.id, kind: "MOVES_FORWARD", postId: c.actions[0]!.postId, probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 86_400_000), payload: { comment: "New words" } },
  });
  expect(await click(c.id, publish)).toBe(`/app/${project.slug}/autopilot/${c.id}?done=already&button=publish&update=${scheduledOf(c)}`);
  expect(await statusOf(fresh.id)).toBe("SCHEDULED");
  expect(await click(c.id, approve)).toBe(`/app/${project.slug}/autopilot/${c.id}?select=likely&done=replaced`);
});

test("Publish now that's refused (nothing to post, say) says nothing went out, and the update waits for the team", async () => {
  const c = await change();
  // Its words were cleared since it was scheduled: applying refuses it ("Write the comment to post first").
  await prisma.codeChangeAction.update({ where: { id: scheduledOf(c) }, data: { payload: { comment: "" } } });
  const landing = await click(c.id, signAutopilotButton(owner.id, c.id, `publish:${scheduledOf(c)}`)!);
  expect(landing).toBe(`/app/${project.slug}/autopilot/${c.id}?done=refused&button=publish&held=1&select=${scheduledOf(c)}`);
  expect(await statusOf(scheduledOf(c))).toBe("PENDING");
});
