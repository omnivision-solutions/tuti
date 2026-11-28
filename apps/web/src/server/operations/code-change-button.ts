import { prisma } from "@tuti/db";
import { POST_UPDATE, postUpdate } from "@tuti/jobs";
import { z } from "zod";

import { defineOperation } from "./define";

/**
 * What a button in Autopilot's email (app/…/autopilot/[id]/act) acts on: the updates it names, of its pull request in
 * this project, as they are now. With `parts`, a post's update says which parts it's made of now (Approve asks: one sent
 * before it was one only acts while it's still just the part the email showed). The button itself acts through the operations it runs.
 */
export const getCodeChangeButton = defineOperation({
  name: "codeChanges.button",
  title: "Read an email's button",
  summary: "The updates a button in Autopilot's email names, as they are now.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({ id: z.string().min(1).max(100), actions: z.array(z.string().min(1).max(100)).max(100), parts: z.boolean().optional() }),
  output: z.object({
    actions: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        status: z.string(),
        postId: z.string().nullable(),
        articleId: z.string().nullable(),
        waitReason: z.string().nullable(),
        /** With `parts`, a post's update's parts now (their ids); null for anything else, or when not asked. */
        parts: z.array(z.string()).nullable(),
      }),
    ),
  }),
  run: async ({ projectId }, input) => {
    const found = await prisma.codeChangeAction.findMany({
      where: { id: { in: input.actions }, codeChangeId: input.id, codeChange: { projectId } },
      select: { id: true, kind: true, status: true, postId: true, articleId: true, waitReason: true },
    });
    const actions = await Promise.all(
      found.map(async (action) => ({
        ...action,
        parts: input.parts && POST_UPDATE.includes(action.kind) && action.postId ? (await postUpdate(action.postId)).parts.map((part) => part.id) : null,
      })),
    );
    return { actions };
  },
});
