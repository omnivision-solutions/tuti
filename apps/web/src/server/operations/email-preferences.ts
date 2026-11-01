import { prisma } from "@tuti/db";
import { z } from "zod";

import { author, authorId } from "./create";
import { defineOperation } from "./define";

/** Which of the project's emails someone gets (their portal's Account): emails about posts they wrote, about posts they voted on or follow, or none at all. */
export async function emailPreferences(projectId: string, userId: string) {
  const key = { userId_projectId: { userId, projectId } };
  const [preference, optOut] = await Promise.all([
    prisma.emailPreference.findUnique({ where: key, select: { ownPosts: true, followedPosts: true } }),
    prisma.emailOptOut.findUnique({ where: key }),
  ]);
  return { ownPosts: preference?.ownPosts ?? true, followedPosts: preference?.followedPosts ?? true, unsubscribed: optOut !== null };
}

export const updateEmailPreferences = defineOperation({
  name: "emailPreferences.update",
  summary:
    "Choose which of the project's emails someone gets, as the key's creator or on behalf of someone from your app: when posts they wrote (`ownPosts`) or posts they voted on, commented on or follow (`followedPosts`) ship or get the team's reply, or none at all (`unsubscribed`, as the unsubscribe link in every email); what's left out stays as it was",
  method: "PATCH",
  path: "/email-preferences",
  scope: "write",
  access: "anyone",
  input: z.object({ ownPosts: z.boolean().optional(), followedPosts: z.boolean().optional(), unsubscribed: z.boolean().optional(), author }),
  example: { followedPosts: false, author: { id: "user-42" } },
  run: async (context, input) => {
    const userId = await authorId(context, input.author);
    const key = { userId, projectId: context.projectId };
    const posts = { ownPosts: input.ownPosts, followedPosts: input.followedPosts };
    if (posts.ownPosts !== undefined || posts.followedPosts !== undefined) {
      await prisma.emailPreference.upsert({ where: { userId_projectId: key }, create: { ...key, ...posts }, update: posts });
    }
    if (input.unsubscribed) {
      await prisma.emailOptOut.createMany({ data: key, skipDuplicates: true });
    } else if (input.unsubscribed === false) {
      await prisma.emailOptOut.deleteMany({ where: key });
    }
    return emailPreferences(context.projectId, userId);
  },
});
