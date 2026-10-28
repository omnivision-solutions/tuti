import { prisma } from "@tuti/db";
import { afterEach, expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { type InboxChange, notifyInbox, subscribeInbox } from "./live";
import { createConversation, replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";

/** Live updates (server/live.ts): changes reach only the streams allowed to see them, once committed. */

const subscriptions: (() => void)[] = [];
afterEach(() => subscriptions.splice(0).forEach((stop) => stop()));

/** What a subscriber with `wants` hears, as a list that fills as changes arrive. */
function hear(wants: (change: InboxChange) => boolean) {
  const heard: number[] = [];
  subscriptions.push(subscribeInbox(wants, () => heard.push(Date.now())));
  return heard;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const key = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  return { project, key };
}

test("the team hears of its own project's changes only, and a user of their own conversations only", async () => {
  const first = await setup();
  const second = await setup();
  const sam = await upsertProjectUser(first.project.id, "user-42", { name: "Sam" });
  const team = hear((change) => change.projectId === first.project.id);
  const samsWidget = hear((change) => change.projectId === first.project.id && change.userId === sam);
  // Let the listener connect before anything changes.
  await settle();

  await call(createConversation, first.key, { user: { id: "user-42" }, body: "Help" });
  await call(createConversation, first.key, { email: "e2e-other@example.com", body: "Me too" });
  await call(replyToConversation, first.key, { number: 1, body: "On it" });
  await call(updateConversation, first.key, { number: 2, status: "closed" });
  await call(createConversation, second.key, { email: "e2e-elsewhere@example.com", body: "Elsewhere" });
  await settle();

  expect(team).toHaveLength(4);
  // Sam's conversation started, and the team replied in it; not the other person's.
  expect(samsWidget).toHaveLength(2);
});

test("a change that rolls back tells nobody", async () => {
  const { project } = await setup();
  const team = hear((change) => change.projectId === project.id);
  await settle();
  await expect(
    prisma.$transaction(async (tx) => {
      await notifyInbox(tx, { projectId: project.id, conversationId: "none", userId: null, visitorHash: null });
      throw new Error("Rolled back");
    }),
  ).rejects.toThrow("Rolled back");
  await settle();
  expect(team).toEqual([]);
});
